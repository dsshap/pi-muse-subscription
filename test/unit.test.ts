import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeContext, Type, type Message } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "../src/anchors.ts";
import { resolveConfig } from "../src/config.ts";
import { historyText, piToolName, readTranscript, turnInput } from "../src/convert.ts";
import { cleanEnv, hostSettings } from "../src/home.ts";
import { museEffort, museModels } from "../src/models.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

describe("convert", () => {
	it("maps Muse tool names back to pi's", () => {
		assert.equal(piToolName("mcp__pi__read"), "read");
		assert.equal(piToolName("mcp__pi.bash"), "bash");
		assert.equal(piToolName("muse.read_file"), undefined);
	});

	it("chains transcript states by content, not timestamps", () => {
		const a = readTranscript(normalizeContext({ systemPrompt: "S", tools: [], messages: [user("hi")] }));
		const b = readTranscript(normalizeContext({ systemPrompt: "S", tools: [], messages: [{ ...user("hi"), timestamp: 99 }] }));
		const c = readTranscript(normalizeContext({ systemPrompt: "T", tools: [], messages: [user("hi")] }));
		assert.deepEqual(a.chain, b.chain);
		assert.notEqual(a.chain[1], c.chain[1]);
	});

	it("turns user content into Muse input parts", () => {
		const parts = turnInput([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "QUJD", mimeType: "image/png" }], timestamp: 1 }]);
		assert.deepEqual(parts, [
			{ type: "text", text: "look" },
			{ type: "image", base64Data: "QUJD", mediaType: "image/png" },
		]);
	});

	it("renders foreign history with tool calls and results", () => {
		const text = historyText([
			user("q"),
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }], api: "x", provider: "x", model: "x", usage: {} as any, stopReason: "toolUse", timestamp: 1 } as any,
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "DATA" }], isError: true, timestamp: 1 },
		]);
		assert.match(text, /<user>\nq\n<\/user>/);
		assert.match(text, /<tool_call tool="read" id="t1">\{"path":"a"\}<\/tool_call>/);
		assert.match(text, /<tool_result tool="read" id="t1" error="true">\nDATA/);
	});
});

describe("models", () => {
	it("maps pi thinking levels onto Muse efforts", () => {
		assert.equal(museEffort(undefined), "none");
		assert.equal(museEffort("xhigh"), "xhigh");
		const wonder = museModels().find((m) => m.id === "muse-wonder-1.0")!;
		assert.equal((wonder.thinkingLevelMap as any).off, null, "Muse models cannot turn reasoning off");
		assert.equal((wonder.thinkingLevelMap as any).max, "max");
		assert.equal(museEffort("off", wonder.thinkingLevelMap as any), "minimal", "no thinking = the lowest effort the model offers");
		assert.equal(museEffort(undefined, wonder.thinkingLevelMap as any), "minimal");
		const spark12 = museModels().find((m) => m.id === "muse-spark-1.2")!;
		assert.equal((spark12.thinkingLevelMap as any).max, null);
		assert.equal(wonder.cost.input, 0);
	});

	it("plans below Muse Code's own context limit", () => {
		const [m] = museModels([{ modelId: "x", contextLimit: 1_007_997, outputLimit: 64_000 }]);
		assert.ok(m.contextWindow < 1_007_997 * 0.99);
		assert.equal(m.maxTokens, 64_000);
	});
});

describe("config", () => {
	const dirs = () => {
		const root = mkdtempSync(join(tmpdir(), "pi-muse-cfg-"));
		mkdirSync(join(root, "agent"));
		mkdirSync(join(root, "proj", ".pi"), { recursive: true });
		mkdirSync(join(root, "home", ".config", "muse"), { recursive: true });
		return root;
	};

	it("lets a project tune only harmless settings", () => {
		const root = dirs();
		writeFileSync(join(root, "proj", ".pi", "muse-sdk.json"), JSON.stringify({ museBin: "/tmp/evil", contributorMode: "on", maxSessions: 2 }));
		const c = resolveConfig({ cwd: join(root, "proj"), agentDir: join(root, "agent"), home: join(root, "home"), env: {} });
		assert.equal(c.museBin, undefined);
		assert.equal(c.contributorMode, "off");
		assert.equal(c.maxSessions, 2);
	});

	it("follows the saved Muse Code contributor setting, else off", () => {
		const root = dirs();
		const where = { cwd: join(root, "proj"), agentDir: join(root, "agent"), home: join(root, "home"), env: {} as Record<string, string> };
		assert.equal(resolveConfig(where).contributorMode, "off");
		writeFileSync(join(root, "home", ".config", "muse", "settings.json"), JSON.stringify({ contributor_mode_enabled: true }));
		assert.equal(resolveConfig(where).contributorMode, "on");
		assert.equal(resolveConfig({ ...where, env: { PI_MUSE_SDK_CONTRIBUTOR: "off" } }).contributorMode, "off");
	});
});

describe("host settings", () => {
	it("never passes an API key that would switch to pay-as-you-go billing", () => {
		const env = cleanEnv({ META_API_KEY: "sk", PATH: "/bin", X: undefined });
		assert.equal(env.META_API_KEY, undefined);
		assert.equal(env.PATH, "/bin");
		assert.equal("X" in env, false);
	});

	it("runs pi's prompt and tools with Muse Code's own context and observers off", () => {
		const s = hostSettings({ systemPrompt: "P", toolset: ["mcp__pi__*"], mcpUrl: "http://127.0.0.1:1/mcp/x", skillsOff: { bundled: { "a": "off" } } }) as any;
		assert.equal(s.run.system_prompt, "P");
		assert.deepEqual(s.run.toolset, ["mcp__pi__*"]);
		assert.ok(Object.values(s.runtime_capabilities).every((v: any) => v.enabled === false));
		assert.equal(s.mcp_servers.pi.headers.Authorization, "${PI_MUSE_MCP_AUTH}", "the token stays out of the file");
		assert.ok(s.mcp_servers.pi.tool_timeout_sec >= 24 * 3600);
		assert.equal(hostSettings({ systemPrompt: "P", toolset: [], skillsOff: {} }).mcp_servers, undefined);
	});
});

describe("anchors", () => {
	it("tracks each session's last clean turn across processes", () => {
		const file = join(mkdtempSync(join(tmpdir(), "pi-muse-anchors-")), "a.jsonl");
		const r = new AnchorRegistry(file);
		r.put("k1", { sessionId: "s", turnId: "t1", cwd: "/w" });
		assert.equal(r.tail("s"), "t1");
		r.openTurn("s");
		assert.equal(r.tail("s"), undefined, "a started turn may be partial");
		const again = new AnchorRegistry(file);
		assert.deepEqual(again.get("k1"), { sessionId: "s", turnId: "t1", cwd: "/w" });
		assert.equal(again.tail("s"), undefined);
	});
});
