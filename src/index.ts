import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { AnchorRegistry } from "./anchors.ts";
import { McpBridge } from "./bridge.ts";
import { museConfigDir, resolveConfig } from "./config.ts";
import { listSkillsOff, type SkillsOff, sweepHostConfigs } from "./home.ts";
import { type HostEnv, listModels, MuseHost } from "./host.ts";
import { museModels } from "./models.ts";
import { applyMusePrompt } from "./prompt.ts";
import { API, MuseSdkProvider } from "./provider.ts";

export const PROVIDER = "muse-sdk";

/**
 * pi extension: Meta's Muse models through the Muse Code SDK, authenticated by the local Muse Code
 * login (subscription). pi keeps its own agent loop, tools, prompt and compaction; a `muse serve`
 * host is used only as the authenticated model transport.
 */
export default function (pi: ExtensionAPI) {
	const env = process.env;
	const config = resolveConfig({ cwd: process.cwd(), agentDir: getAgentDir(), home: homedir(), env });
	const baseDir = join(getAgentDir(), "muse-sdk");
	const debugPath = env.PI_MUSE_SDK_DEBUG;
	const debug = debugPath ? (msg: string) => appendFileSync(debugPath, `${new Date().toISOString()} ${msg}\n`) : undefined;
	const museBin = config.museBin ?? "muse";
	const userConfigDir = museConfigDir(env, homedir());
	sweepHostConfigs(baseDir);

	let skills: Promise<SkillsOff> | undefined;
	const bridge = new McpBridge();
	const hostEnv: HostEnv = {
		museBin,
		contributorMode: config.contributorMode,
		bridge,
		baseDir,
		userConfigDir,
		skillsOff: () => (skills ??= listSkillsOff(museBin, baseDir, env)),
		env,
		debug,
		// Test hook: extra Muse Code settings, e.g. a fake model endpoint for offline end-to-end tests.
		...(env.PI_MUSE_SDK_TEST_SETTINGS ? { settingsOverlay: JSON.parse(env.PI_MUSE_SDK_TEST_SETTINGS) } : {}),
	};
	const provider = new MuseSdkProvider({
		registry: new AnchorRegistry(join(baseDir, "anchors.jsonl")),
		openSession: (spec) => MuseHost.open(spec, hostEnv),
		...(config.maxSessions ? { maxSessions: config.maxSessions } : {}),
		...(config.idleMinutes ? { idleMs: config.idleMinutes * 60_000 } : {}),
		debug,
	});

	const register = (models = museModels()) =>
		pi.registerProvider(PROVIDER, {
			name: "Muse (subscription via Muse Code SDK)",
			// Muse Code authenticates itself; pi only needs a non-empty key to treat the provider as configured.
			apiKey: "muse-code-login",
			api: API as any,
			baseUrl: "muse-code-sdk://local",
			models,
			streamSimple: provider.streamSimple,
		});
	register();

	// Pick up the models the user's plan offers from Muse Code's live catalog.
	let refreshed = false;
	pi.on("session_start", () => {
		if (refreshed) return;
		refreshed = true;
		void listModels(hostEnv).then((rows) => {
			if (rows) register(museModels(rows));
		});
	});

	const docs = { readme: getReadmePath(), docs: getDocsPath(), examples: getExamplesPath() };
	pi.on("before_agent_start", (event, ctx) => applyMusePrompt(event, ctx.model, PROVIDER, config.promptMode ?? "muse", docs));

	const shutdown = () => {
		provider.shutdown();
		bridge.close();
	};
	pi.on("session_shutdown", shutdown);
	process.once("exit", shutdown);
}
