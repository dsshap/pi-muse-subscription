// The provider against Muse Code and Meta for real, on your subscription login:
// `muse` → /login first, then `npm run test:live`. Each test spends a few prompts of your plan.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { normalizeContext, Type, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "../src/anchors.ts";
import { McpBridge } from "../src/bridge.ts";
import { museConfigDir, savedContributorMode } from "../src/config.ts";
import { listSkillsOff, type SkillsOff } from "../src/home.ts";
import { type HostEnv, listModels, MuseHost } from "../src/host.ts";
import { museModels } from "../src/models.ts";
import { API, MuseSdkProvider } from "../src/provider.ts";

const live = !!process.env.PI_MUSE_SDK_LIVE;
const root = mkdtempSync(join(tmpdir(), "pi-muse-live-"));
const baseDir = join(root, "agent");
const museBin = process.env.PI_MUSE_SDK_MUSE_PATH ?? "muse";
const userConfigDir = museConfigDir(process.env, homedir());
const bridge = new McpBridge();
let skills: Promise<SkillsOff> | undefined;
const hostEnv: HostEnv = {
	museBin,
	contributorMode: savedContributorMode(userConfigDir) ?? "off",
	bridge,
	baseDir,
	userConfigDir,
	skillsOff: () => (skills ??= listSkillsOff(museBin, baseDir, process.env)),
	env: process.env,
};
const model = { ...museModels()[0], id: process.env.PI_MUSE_SDK_MODEL ?? "muse-spark-1.3", api: API, provider: "muse-sdk", baseUrl: "" } as unknown as Model<any>;
const tools = [{ name: "read", description: "Read a text file and return its contents", parameters: Type.Object({ path: Type.String() }) }];
const SYSTEM = "You are a terse assistant in a test harness. Use tools when asked to read files.";
const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });
const text = (m: AssistantMessage) => m.content.map((c: any) => c.text ?? "").join("");
after(() => bridge.close());

describe("live Muse Code", { skip: !live && "set PI_MUSE_SDK_LIVE=1 (spends subscription prompts)" }, () => {
	const cwd = mkdtempSync(join(root, "ws-"));
	writeFileSync(join(cwd, "note.txt"), "The magic word is pelican.\n");
	const file = join(root, "anchors.jsonl");
	const provider = () => new MuseSdkProvider({ registry: new AnchorRegistry(file), openSession: (spec) => MuseHost.open(spec, hostEnv), cwd: () => cwd });
	const call = async (p: MuseSdkProvider, messages: Message[]) => {
		const msg = (await p.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, tools, messages }), { reasoning: "low" as any }).result()) as AssistantMessage;
		assert.notEqual(msg.stopReason, "error", msg.errorMessage ?? "");
		return { msg, route: p.lastRoute };
	};

	it("lists the plan's models", async () => {
		const rows = await listModels(hostEnv);
		assert.ok(rows && rows.length > 0, "Muse Code returned its live catalog");
	});

	it("runs a tool loop, a second turn, and resumes after a restart", async () => {
		const p1 = provider();
		const hist: Message[] = [user("Read note.txt with the read tool and tell me the magic word, one word.")];
		const a1 = await call(p1, hist);
		assert.equal(a1.msg.stopReason, "toolUse");
		const c = a1.msg.content.find((x) => x.type === "toolCall") as any;
		assert.equal(c.name, "read");
		hist.push(a1.msg, { role: "toolResult", toolCallId: c.id, toolName: "read", content: [{ type: "text", text: "The magic word is pelican." }], isError: false, timestamp: Date.now() });
		const a2 = await call(p1, hist);
		assert.equal(a2.route, "live");
		assert.match(text(a2.msg).toLowerCase(), /pelican/);
		p1.shutdown();

		const p2 = provider();
		hist.push(a2.msg, user("What was the magic word again? One word."));
		const a3 = await call(p2, hist);
		assert.equal(a3.route, "resume");
		assert.match(text(a3.msg).toLowerCase(), /pelican/);
		assert.ok(a3.msg.usage.totalTokens > 0);
		p2.shutdown();
	});
});
