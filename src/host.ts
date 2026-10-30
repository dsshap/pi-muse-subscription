import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnMspConnection, type SpawnedMspConnection } from "@muse-code/sdk";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult, McpBridge } from "./bridge.ts";
import { type InputPart, MCP_TOOLSET } from "./convert.ts";
import { cleanEnv, removeHostConfig, type SkillsOff, writeHostConfig } from "./home.ts";
import type { CatalogRow, MuseEffort } from "./models.ts";
import { AsyncQueue, errorText } from "./util.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
/** MSP client names must match ^[a-z0-9_]+$. */
const CLIENT = { name: "pi_muse_subscription", version: VERSION };

export type OpenMode = { kind: "fresh" } | { kind: "resume"; sessionId: string } | { kind: "fork"; sessionId: string; turnId: string };

export interface HostSpec {
	cwd: string;
	model: string;
	systemPrompt: string;
	tools: Tool[];
	toolsHash: string;
	open: OpenMode;
	/** A tool-less one-shot request (compaction or branch summary): no tools, no persisted session. */
	ephemeral: boolean;
}

/** Where and how hosts run; shared by every host of the provider. */
export interface HostEnv {
	museBin: string;
	contributorMode: "on" | "off";
	bridge: McpBridge;
	/** pi's private directory for host configs. */
	baseDir: string;
	/** The user's Muse Code config directory (login state). */
	userConfigDir: string;
	skillsOff: () => Promise<SkillsOff>;
	env: Record<string, string | undefined>;
	/** Extra Muse Code settings for every host (tests use a fake endpoint). */
	settingsOverlay?: Record<string, unknown>;
	debug?: (msg: string) => void;
}

export type ToolCallInfo = { callId: string; name: string; args: string };

/** Muse Code session activity, reduced to what a pi step needs. */
export type HostEvent =
	| { type: "turn_started"; turnId: string }
	| { type: "text_start"; itemId: string }
	| { type: "text_delta"; itemId: string; delta: string }
	| { type: "text_end"; itemId: string; text: string }
	| { type: "thinking_start"; itemId: string }
	| { type: "thinking_delta"; itemId: string; delta: string; part: number }
	| { type: "thinking_end"; itemId: string; text: string }
	| { type: "usage"; promptTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; finishReason?: string; modelId?: string }
	/** Every tool call of one model response, before Muse Code runs the first (raw log, experimental). */
	| { type: "tool_calls"; calls: ToolCallInfo[] }
	/** One tool call starting; Muse Code runs a response's calls one at a time. */
	| { type: "tool_started"; call: ToolCallInfo }
	| { type: "turn_completed"; turnId: string; terminal: string; error?: { kind?: string; message?: string }; reason?: string }
	| { type: "host_error"; message: string };

/** What the provider needs from a Muse Code session; MuseHost is the real one. */
export interface MuseSession {
	readonly spec: HostSpec;
	readonly sessionId: string;
	model: string;
	/** Chain hash and length of the pi transcript this session has consumed. */
	chain: string;
	count: number;
	/** Tool calls of the last step that pi has not answered yet. */
	awaiting: Set<string>;
	/** Tool calls already handed to pi as part of a step. */
	announced: Set<string>;
	turnId?: string;
	dead: boolean;
	busy: boolean;
	lastUsed: number;
	readonly events: AsyncQueue<HostEvent>;
	readonly exited: Promise<void>;
	readonly stderr: string;
	startTurn(input: InputPart[], effort: MuseEffort): Promise<void>;
	steer(input: InputPart[]): Promise<void>;
	deliver(result: ToolResultMessage): void;
	setModel(model: string): Promise<void>;
	interrupt(): Promise<void>;
	close(): void;
}

/**
 * One `muse serve` process holding one Muse Code session. Muse Code runs with pi's system prompt
 * and only pi's tools, served over MCP by the bridge; a tool call parks until pi delivers its result
 * on the next provider call.
 */
export class MuseHost implements MuseSession {
	sessionId = "";
	model: string;
	chain = "";
	count = 0;
	awaiting = new Set<string>();
	announced = new Set<string>();
	turnId?: string;
	dead = false;
	busy = false;
	lastUsed = Date.now();
	readonly events = new AsyncQueue<HostEvent>();
	readonly exited: Promise<void>;
	private markExited!: () => void;

	private spawned?: SpawnedMspConnection;
	private xdg?: string;
	private routeId?: string;
	private logSubscription?: number;
	private stderrTail = "";
	private readonly kinds = new Map<string, string>();
	private readonly parked = new Map<string, { resolve: (r: CallToolResult) => void; reject: (e: Error) => void }>();
	private readonly ready = new Map<string, CallToolResult>();
	private readonly decided = new Set<string>();

	readonly spec: HostSpec;
	private readonly host: HostEnv;

	private constructor(spec: HostSpec, host: HostEnv) {
		this.spec = spec;
		this.host = host;
		this.model = spec.model;
		this.exited = new Promise((r) => {
			this.markExited = r;
		});
	}

	static async open(spec: HostSpec, host: HostEnv): Promise<MuseHost> {
		const h = new MuseHost(spec, host);
		try {
			await h.init();
		} catch (e) {
			h.close();
			throw new Error(errorText(e, h.stderr));
		}
		return h;
	}

	/** Whether every tool call of a response arrives up front (`tool_calls`), not one at a time. */
	get rawLog(): boolean {
		return this.logSubscription !== undefined;
	}

	private log(msg: string): void {
		this.host.debug?.(msg);
	}

	private async init(): Promise<void> {
		const { spec, host } = this;
		const id = randomUUID().replace(/-/g, "");
		let mcp: { url: string; token: string } | undefined;
		if (!spec.ephemeral) {
			mcp = await host.bridge.register(id, spec.tools, (callId) => this.onToolCall(callId));
			this.routeId = id;
		}
		this.xdg = writeHostConfig(host.baseDir, id, host.userConfigDir, {
			systemPrompt: spec.systemPrompt,
			toolset: spec.ephemeral ? [] : [MCP_TOOLSET],
			...(mcp ? { mcpUrl: mcp.url } : {}),
			skillsOff: await host.skillsOff(),
			...(host.settingsOverlay ? { overlay: host.settingsOverlay } : {}),
		});
		const args = ["serve", "--contributor-mode", host.contributorMode, "--disable-request-user-input"];
		if (spec.ephemeral) args.push("--no-session-log");
		const handshake = spawnMspConnection({
			command: host.museBin,
			args,
			cwd: spec.cwd,
			env: cleanEnv({ ...host.env, XDG_CONFIG_HOME: this.xdg, PI_MUSE_MCP_AUTH: mcp ? `Bearer ${mcp.token}` : "" }),
			onStderr: (d) => {
				this.stderrTail = (this.stderrTail + d).slice(-4000);
			},
		});
		handshake.onNotification((n) => this.onNotification(n.method, (n.params ?? {}) as any));
		handshake.onServerRequest(async (r) => this.onServerRequest(r.method, (r.params ?? {}) as any));
		void handshake.exited.then(
			() => this.onExit(),
			() => this.onExit(),
		);
		this.spawned = await handshake.initialize({ clientInfo: CLIENT, capabilities: { experimentalApi: true, requestedCapabilities: ["rawLog"] } });
		const c = this.spawned.connection;
		const open = spec.open;
		let result: any;
		if (open.kind === "fresh") result = await c.command("session/start", { workspaceRoot: spec.cwd, modelId: spec.model, approvalMode: "allowAll" });
		else if (open.kind === "resume") result = await c.command("session/resume", { sessionId: open.sessionId, excludeItems: true, modelId: spec.model });
		else result = await c.command("session/fork", { sessionId: open.sessionId, cutPoint: { lastTurnId: open.turnId }, excludeItems: true });
		this.sessionId = String(result.session.sessionId);
		if (open.kind !== "fresh") {
			await c.command("session/setApprovalMode", { sessionId: this.sessionId, mode: "allowAll" });
			if (open.kind === "fork") await c.command("session/setModel", { sessionId: this.sessionId, model: { modelId: spec.model } });
		}
		if (this.spawned.initializeResult.grantedCapabilities.includes("rawLog")) {
			try {
				const streams = (await c.command("log/streams", { sessionId: this.sessionId })) as any;
				const stream = (streams.streams ?? []).map((s: any) => s.stream).find((s: any) => s?.kind === "session") ?? { kind: "session", id: this.sessionId };
				const sub = (await c.command("log/subscribe", { sessionId: this.sessionId, stream })) as any;
				this.logSubscription = sub.subscriptionId;
			} catch (e) {
				this.log(`raw log unavailable (${errorText(e)}); tool calls arrive one at a time`);
			}
		}
	}

	private onNotification(method: string, p: any): void {
		if (method === "log/record") {
			if (p.subscriptionId !== this.logSubscription) return;
			const payload = p.record?.payload;
			const ev = payload?.event;
			if (payload?.kind === "run" && ev?.kind === "assistant_tool_calls_committed" && Array.isArray(ev.tool_calls)) {
				this.events.push({ type: "tool_calls", calls: ev.tool_calls.map((c: any) => ({ callId: String(c.call_id), name: String(c.name), args: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}) })) });
			}
			return;
		}
		if (typeof p.sessionId === "string" && this.sessionId && p.sessionId !== this.sessionId) return;
		switch (method) {
			case "turn/started":
				this.turnId = p.turnId;
				this.events.push({ type: "turn_started", turnId: p.turnId });
				break;
			case "item/started": {
				const it = p.item ?? {};
				this.kinds.set(it.itemId, it.kind);
				if (it.kind === "agentMessage") this.events.push({ type: "text_start", itemId: it.itemId });
				else if (it.kind === "reasoning") this.events.push({ type: "thinking_start", itemId: it.itemId });
				else if (it.kind === "toolCall" && typeof it.callId === "string") this.events.push({ type: "tool_started", call: { callId: it.callId, name: String(it.tool ?? ""), args: String(it.args ?? "") } });
				break;
			}
			case "item/delta": {
				const kind = this.kinds.get(p.itemId);
				const field: string = p.field ?? "text";
				if (kind === "agentMessage" && field === "text") this.events.push({ type: "text_delta", itemId: p.itemId, delta: String(p.delta ?? "") });
				else if (kind === "reasoning" && field.startsWith("summary.")) this.events.push({ type: "thinking_delta", itemId: p.itemId, delta: String(p.delta ?? ""), part: Number(field.slice(8)) || 0 });
				break;
			}
			case "item/completed": {
				const it = p.item ?? {};
				const kind = this.kinds.get(it.itemId) ?? it.kind;
				this.kinds.delete(it.itemId);
				if (kind === "agentMessage") this.events.push({ type: "text_end", itemId: it.itemId, text: String(it.text ?? "") });
				else if (kind === "reasoning") this.events.push({ type: "thinking_end", itemId: it.itemId, text: Array.isArray(it.summary) && it.summary.length > 0 ? it.summary.join("\n\n") : String(it.text ?? "") });
				break;
			}
			case "session/tokenUsage": {
				const u = p.usage ?? {};
				this.events.push({
					type: "usage",
					promptTokens: Number(p.promptTokens ?? u.inputTokens ?? 0),
					outputTokens: Number(u.outputTokens ?? 0),
					cacheRead: Number(u.cacheReadTokens || u.cachedTokens || 0),
					cacheWrite: Number(u.cacheWriteTokens || 0),
					...(p.finishReason ? { finishReason: String(p.finishReason) } : {}),
					...(p.modelId ? { modelId: String(p.modelId) } : {}),
				});
				break;
			}
			case "turn/completed":
				this.events.push({ type: "turn_completed", turnId: p.turnId, terminal: String(p.terminal), ...(p.error ? { error: p.error } : {}), ...(p.reason ? { reason: String(p.reason) } : {}) });
				break;
			case "approval/requested":
				void this.approve(p);
				break;
		}
	}

	private async onServerRequest(method: string, p: any): Promise<Record<string, unknown>> {
		// The session runs with approval mode allowAll and only pi's tools; pi applies its own policy
		// when it runs them. Anything Muse Code still asks about is approved.
		if (method === "approval/request") void this.approve(p);
		return {};
	}

	private async approve(p: any): Promise<void> {
		if (!p?.approvalId || this.decided.has(p.approvalId)) return;
		const choice = (p.availableChoices ?? []).find((c: any) => c.decision === "approved") ?? (p.availableChoices ?? []).find((c: any) => String(c.decision).startsWith("approved"));
		if (!choice) return;
		this.decided.add(p.approvalId);
		try {
			await this.spawned?.connection.command("approval/decide", { sessionId: p.sessionId ?? this.sessionId, approvalId: p.approvalId, choiceId: choice.choiceId, requirementId: p.currentRequirementId });
		} catch (e) {
			this.log(`approval ${p.approvalId}: ${errorText(e)}`);
		}
	}

	private onToolCall(callId: string | undefined): Promise<CallToolResult> {
		if (!callId) return Promise.resolve({ content: [{ type: "text", text: "pi bridge: tool call without a call id" }], isError: true });
		this.lastUsed = Date.now();
		const done = this.ready.get(callId);
		if (done) {
			this.ready.delete(callId);
			return Promise.resolve(done);
		}
		if (this.dead) return Promise.reject(new Error("Muse host closed"));
		return new Promise((resolve, reject) => this.parked.set(callId, { resolve, reject }));
	}

	async startTurn(input: InputPart[], effort: MuseEffort): Promise<void> {
		this.lastUsed = Date.now();
		const r = (await this.connection().command("turn/start", { sessionId: this.sessionId, input, reasoningEffort: effort })) as any;
		if (typeof r.turnId === "string") this.turnId = r.turnId;
	}

	/** Add input to the running turn; Muse Code shows it to the model at the next tool boundary. */
	async steer(input: InputPart[]): Promise<void> {
		this.lastUsed = Date.now();
		await this.connection().command("turn/steer", { sessionId: this.sessionId, expectedTurnId: this.turnId, input });
	}

	/** Answer a parked (or soon to be issued) MCP tool call with pi's result. */
	deliver(result: ToolResultMessage): void {
		const id = result.toolCallId;
		this.awaiting.delete(id);
		const r: CallToolResult = {
			content: result.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mimeType: c.mimeType })),
			...(result.isError ? { isError: true } : {}),
		};
		if (r.content.length === 0) r.content.push({ type: "text", text: "(no output)" });
		const p = this.parked.get(id);
		if (p) {
			this.parked.delete(id);
			p.resolve(r);
		} else this.ready.set(id, r);
	}

	async setModel(model: string): Promise<void> {
		if (model === this.model) return;
		await this.connection().command("session/setModel", { sessionId: this.sessionId, model: { modelId: model } });
		this.model = model;
	}

	async interrupt(): Promise<void> {
		try {
			await this.connection().command("turn/interrupt", { sessionId: this.sessionId, ...(this.turnId ? { turnId: this.turnId } : {}) });
		} catch {}
	}

	private connection() {
		if (!this.spawned || this.dead) throw new Error("Muse host is not running");
		return this.spawned.connection;
	}

	close(): void {
		if (this.dead) return;
		this.dead = true;
		if (this.routeId) this.host.bridge.unregister(this.routeId);
		for (const p of this.parked.values()) p.reject(new Error("Muse host closed"));
		this.parked.clear();
		if (this.spawned) void this.spawned.close().catch(() => {});
		else this.onExit();
	}

	private onExit(): void {
		if (!this.dead) this.events.push({ type: "host_error", message: errorText(new Error("Muse Code exited unexpectedly"), this.stderrTail) });
		this.dead = true;
		if (this.routeId) this.host.bridge.unregister(this.routeId);
		for (const p of this.parked.values()) p.reject(new Error("Muse host exited"));
		this.parked.clear();
		this.events.close();
		removeHostConfig(this.xdg);
		this.markExited();
	}

	get stderr(): string {
		return this.stderrTail;
	}
}

/** Muse Code's live model catalog, or undefined when it cannot be read (no login, no network). */
export async function listModels(host: Omit<HostEnv, "bridge" | "skillsOff">): Promise<CatalogRow[] | undefined> {
	const id = `models-${randomUUID().replace(/-/g, "")}`;
	const xdg = writeHostConfig(host.baseDir, id, host.userConfigDir, { systemPrompt: "", toolset: [], skillsOff: {}, ...(host.settingsOverlay ? { overlay: host.settingsOverlay } : {}) });
	const handshake = spawnMspConnection({ command: host.museBin, args: ["serve", "--no-session-log"], env: cleanEnv({ ...host.env, XDG_CONFIG_HOME: xdg }) });
	try {
		const spawned = await handshake.initialize({ clientInfo: CLIENT });
		try {
			const r = (await spawned.connection.command("model/list", {})) as any;
			if (r.source !== "providerCatalog" || !Array.isArray(r.models) || r.models.length === 0) return undefined;
			return r.models as CatalogRow[];
		} finally {
			await spawned.close().catch(() => {});
		}
	} catch {
		void handshake.close().catch(() => {});
		return undefined;
	} finally {
		removeHostConfig(xdg);
	}
}
