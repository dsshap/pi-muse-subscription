// The provider against a real `muse serve` (the installed Muse Code), offline: Muse Code's model
// endpoint is a local fake that records each request. Needs `muse` on PATH (or PI_MUSE_SDK_MUSE_PATH).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { normalizeContext, Type, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "../src/anchors.ts";
import { McpBridge } from "../src/bridge.ts";
import { listSkillsOff, type SkillsOff } from "../src/home.ts";
import { type HostEnv, listModels, MuseHost } from "../src/host.ts";
import { museModels } from "../src/models.ts";
import { API, MuseSdkProvider } from "../src/provider.ts";
import { FakeMeta, type Json, reply, roleTexts, toolNames } from "./fake-meta.ts";

const SYSTEM = "You are pi's test agent.";
const tools = [
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
];
const model = { ...museModels()[0], api: API, provider: "muse-sdk", baseUrl: "" } as unknown as Model<any>;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const toolResult = (id: string, text: string, toolName = "read"): Message => ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError: false, timestamp: 1 });
const text = (m: AssistantMessage) => m.content.map((c: any) => c.text ?? "").join("");
const outputs = (body: Json) => (body.input ?? []).filter((i: Json) => i.type === "function_call_output").map((i: Json) => [i.call_id, typeof i.output === "string" ? i.output : JSON.stringify(i.output)]);

const root = mkdtempSync(join(tmpdir(), "pi-muse-host-"));
const home = join(root, "home");
const userConfigDir = join(home, ".config", "muse");
mkdirSync(userConfigDir, { recursive: true });
writeFileSync(join(userConfigDir, "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "unused" } } }));
const museBin = process.env.PI_MUSE_SDK_MUSE_PATH ?? "muse";
const env = { PATH: process.env.PATH, HOME: home, TBH_CREDENTIAL_BACKEND: "file", TBH_DISABLE_TELEMETRY: "1" };
const fake = new FakeMeta();
const bridge = new McpBridge();
let skills: Promise<SkillsOff> | undefined;
let hostEnv: HostEnv;

before(async () => {
	await fake.start();
	hostEnv = {
		museBin,
		contributorMode: "off",
		bridge,
		baseDir: join(root, "agent", "muse-sdk"),
		userConfigDir,
		skillsOff: () => (skills ??= listSkillsOff(museBin, join(root, "agent", "muse-sdk"), env)),
		env,
		settingsOverlay: { endpoint_transport: { base_url: fake.baseUrl, auth: "bearer" } },
	};
});
after(async () => {
	bridge.close();
	await fake.close();
});

function harness(registryFile = join(root, `anchors-${Math.random()}.jsonl`)) {
	const cwd = mkdtempSync(join(root, "ws-"));
	const provider = new MuseSdkProvider({ registry: new AnchorRegistry(registryFile), openSession: (spec) => MuseHost.open(spec, hostEnv), cwd: () => cwd });
	const call = async (messages: Message[], opts: { reasoning?: string; signal?: AbortSignal; tools?: typeof tools } = {}) => {
		const before = fake.bodies.length;
		const s = provider.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, tools: opts.tools ?? tools, messages }), { reasoning: (opts.reasoning ?? "medium") as any, signal: opts.signal });
		const events: any[] = [];
		for await (const e of s) events.push(e);
		const msg = (await s.result()) as AssistantMessage;
		return { msg, route: provider.lastRoute, events, requests: fake.bodies.slice(before) };
	};
	return { provider, call, registryFile, cwd };
}

describe("muse serve host", () => {
	it("sends pi's prompt and only pi's tools, one request per turn", async () => {
		const h = harness();
		fake.queue(() => reply({ text: "hello from muse" }));
		const a = await h.call([user("hi")], { reasoning: "low" });
		assert.equal(a.msg.stopReason, "stop", a.msg.errorMessage ?? "");
		assert.equal(text(a.msg), "hello from muse");
		assert.equal(a.route, "fresh");
		assert.equal(a.requests.length, 1, "no observer or side calls");
		const body = a.requests[0];
		assert.equal(body.instructions, SYSTEM);
		assert.deepEqual(toolNames(body).sort(), ["mcp__pi/bash", "mcp__pi/read"]);
		assert.equal(body.reasoning?.effort, "low");
		assert.deepEqual(roleTexts(body, "user"), ["hi"]);
		const developer = roleTexts(body, "developer").join("\n");
		assert.ok(developer.length < 4000, `developer context stays small (${developer.length} chars)`);
		assert.ok(!developer.includes("<skill-catalog>"), "no Muse skill catalog");
		assert.ok(a.msg.usage.totalTokens > 0);
		h.provider.shutdown();
	});

	it("hands every call of a response to pi at once and returns the results to the same turn", async () => {
		const h = harness();
		fake.queue(
			() => reply({ reasoning: ["Plan: read both."], text: "Reading.", calls: [{ name: "mcp__pi.read", args: { path: "a.txt" }, id: "call_a" }, { name: "mcp__pi.bash", args: { command: "ls" }, id: "call_b" }] }),
			() => reply({ text: "both read" }),
		);
		const hist: Message[] = [user("read a.txt and list")];
		const a1 = await h.call(hist);
		assert.equal(a1.msg.stopReason, "toolUse", a1.msg.errorMessage ?? "");
		assert.deepEqual(
			a1.msg.content.filter((c) => c.type === "toolCall"),
			[
				{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "call_b", name: "bash", arguments: { command: "ls" } },
			],
		);
		assert.equal(text(a1.msg), "Reading.");
		const thinking = a1.msg.content.find((c) => c.type === "thinking") as any;
		assert.equal(thinking?.thinking, "Plan: read both.");
		hist.push(a1.msg, toolResult("call_a", "A CONTENTS"), toolResult("call_b", "x y", "bash"));
		const a2 = await h.call(hist);
		assert.equal(a2.route, "live");
		assert.equal(a2.msg.stopReason, "stop", a2.msg.errorMessage ?? "");
		assert.equal(text(a2.msg), "both read");
		assert.equal(a2.requests.length, 1);
		assert.deepEqual(outputs(a2.requests[0]), [
			["call_a", "A CONTENTS"],
			["call_b", "x y"],
		]);
		h.provider.shutdown();
	});

	it("steers a message typed during a tool run into the same turn", async () => {
		const h = harness();
		fake.queue(() => reply({ calls: [{ name: "mcp__pi.read", args: { path: "a.txt" }, id: "call_s" }] }), () => reply({ text: "noted" }));
		const hist: Message[] = [user("read a.txt")];
		const a1 = await h.call(hist);
		assert.equal(a1.msg.stopReason, "toolUse", a1.msg.errorMessage ?? "");
		hist.push(a1.msg, toolResult("call_s", "A"), user("also check b.txt"));
		const a2 = await h.call(hist);
		assert.equal(a2.route, "live");
		assert.equal(text(a2.msg), "noted");
		const req = a2.requests[0];
		assert.deepEqual(outputs(req), [["call_s", "A"]]);
		assert.ok(roleTexts(req, "user").some((t) => t.includes("also check b.txt")), JSON.stringify(roleTexts(req, "user")));
		h.provider.shutdown();
	});

	it("resumes Muse Code's session after a restart and forks it for an earlier branch", async () => {
		const file = join(root, "anchors-shared.jsonl");
		const h1 = harness(file);
		fake.queue(() => reply({ text: "one" }), () => reply({ text: "two" }));
		const hist: Message[] = [user("first")];
		const a1 = await h1.call(hist);
		hist.push(a1.msg, user("second"));
		const a2 = await h1.call(hist);
		assert.equal(a2.route, "live");
		h1.provider.shutdown();

		// A new pi process: the conversation continues from Muse Code's record, not a re-sent transcript.
		const h2 = new MuseSdkProvider({ registry: new AnchorRegistry(file), openSession: (spec) => MuseHost.open(spec, hostEnv), cwd: () => h1.cwd });
		const call2 = async (messages: Message[]) => {
			const before = fake.bodies.length;
			const msg = (await h2.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, tools, messages }), { reasoning: "medium" as any }).result()) as AssistantMessage;
			return { msg, route: h2.lastRoute, requests: fake.bodies.slice(before) };
		};
		fake.queue(() => reply({ text: "three" }));
		const resumed = [...hist, a2.msg, user("third")];
		const a3 = await call2(resumed);
		assert.equal(a3.route, "resume", a3.msg.errorMessage ?? "");
		assert.equal(text(a3.msg), "three");
		assert.deepEqual(roleTexts(a3.requests[0], "user"), ["first", "second", "third"]);

		// Branch from the first answer: Muse Code's session is forked after its first turn.
		fake.queue(() => reply({ text: "branched" }));
		const branch = [user("first"), a1.msg, user("other second")];
		const a4 = await call2(branch);
		assert.equal(a4.route, "fork", a4.msg.errorMessage ?? "");
		assert.equal(text(a4.msg), "branched");
		assert.deepEqual(roleTexts(a4.requests[0], "user"), ["first", "other second"]);
		h2.shutdown();
	});

	it("carries foreign history into a fresh session as text", async () => {
		const h = harness();
		const foreign: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "earlier answer" }, { type: "toolCall", id: "toolu_01", name: "read", arguments: { path: "x" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		};
		fake.queue(() => reply({ text: "continuing" }));
		const a = await h.call([user("old question"), foreign, toolResult("toolu_01", "X DATA"), user("new question")]);
		assert.equal(a.route, "synth", a.msg.errorMessage ?? "");
		assert.equal(text(a.msg), "continuing");
		const u = roleTexts(a.requests[0], "user").join("\n");
		for (const s of ["<conversation_history>", "old question", "earlier answer", "X DATA", "new question"]) assert.ok(u.includes(s), `${s} in ${u}`);
		h.provider.shutdown();
	});

	it("answers tool-less requests (compaction summaries) without tools or a kept session", async () => {
		const h = harness();
		fake.queue(() => reply({ text: "summary" }));
		const a = await h.call([user("summarize")], { tools: [] });
		assert.equal(text(a.msg), "summary", a.msg.errorMessage ?? "");
		assert.deepEqual(toolNames(a.requests[0]), []);
		assert.equal(a.requests[0].instructions, SYSTEM);
		h.provider.shutdown();
	});

	it("aborts a running response and recovers on the next request", async () => {
		const h = harness();
		fake.queue(() => reply({ text: "one" }));
		const hist: Message[] = [user("first")];
		const a1 = await h.call(hist);
		const ac = new AbortController();
		fake.queue(async () => {
			ac.abort();
			await new Promise((r) => setTimeout(r, 1500));
			return reply({ text: "too late" });
		});
		const aborted = await h.call([...hist, a1.msg, user("slow")], { signal: ac.signal });
		assert.equal(aborted.msg.stopReason, "aborted");
		fake.queue(() => reply({ text: "recovered" }));
		const a3 = await h.call([...hist, a1.msg, user("again")]);
		assert.equal(text(a3.msg), "recovered", a3.msg.errorMessage ?? "");
		assert.ok(a3.route === "fork" || a3.route === "resume", String(a3.route));
		assert.deepEqual(roleTexts(a3.requests[0], "user"), ["first", "again"]);
		h.provider.shutdown();
	});

	it("keeps a tool call parked while a pi tool runs for minutes", { skip: !process.env.PI_MUSE_SDK_SLOW, timeout: 15 * 60_000 }, async () => {
		const h = harness();
		fake.queue(() => reply({ calls: [{ name: "mcp__pi.bash", args: { command: "make" }, id: "call_long" }] }), () => reply({ text: "built" }));
		const hist: Message[] = [user("build")];
		const a1 = await h.call(hist);
		assert.equal(a1.msg.stopReason, "toolUse", a1.msg.errorMessage ?? "");
		await new Promise((r) => setTimeout(r, 6.5 * 60_000));
		hist.push(a1.msg, toolResult("call_long", "BUILD OK", "bash"));
		const a2 = await h.call(hist);
		assert.equal(a2.route, "live");
		assert.equal(text(a2.msg), "built", a2.msg.errorMessage ?? "");
		assert.deepEqual(outputs(a2.requests[0]), [["call_long", "BUILD OK"]]);
		h.provider.shutdown();
	});

	it("reads the live model catalog", async () => {
		const rows = await listModels({ ...hostEnv });
		// The fake endpoint's catalog is reported as Muse Code's provider catalog or not at all.
		if (rows) assert.ok(rows.some((r) => r.modelId === "muse-spark-1.3"));
	});
});
