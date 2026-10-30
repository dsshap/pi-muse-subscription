import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Skill activation map that turns every listed skill off: `{ scope: { path: "off" } }`. */
export type SkillsOff = Record<string, Record<string, "off">>;

/** Muse Code's observer agents. Each one is an extra model call per turn; pi drives its own loop. */
const REMINDERS = ["goal-reminder", "verify-reminder", "skill-reminder", "todo-reminder", "memory", "scope-reminder"];

export interface HostSettingsInput {
	systemPrompt: string;
	/** Muse Code toolset: pi's MCP tools, or none for a tool-less request. */
	toolset: string[];
	/** pi's MCP server for this host; its bearer token comes from PI_MUSE_MCP_AUTH. */
	mcpUrl?: string;
	skillsOff: SkillsOff;
	/** Extra settings (tests point Muse Code at a fake endpoint with this). */
	overlay?: Record<string, unknown>;
}

/**
 * Muse Code settings for one host: pi's prompt and tools only, and none of Muse Code's own context
 * (skills, observer agents, foreign rules) or compaction, which pi does itself.
 */
export function hostSettings(input: HostSettingsInput): Record<string, unknown> {
	return {
		schema_version: 1,
		run: {
			system_prompt: input.systemPrompt,
			toolset: input.toolset,
			workflow_trigger_mode: "off",
			context_usage_message_enabled: false,
			context_slimming: { meta_context_note_enabled: false, session_identity_enabled: false },
		},
		runtime_capabilities: Object.fromEntries(REMINDERS.map((r) => [`plugin:tbh-reminders:reminder:${r}`, { enabled: false }])),
		skills: { activation: input.skillsOff },
		context: { foreign_personal_rules: false, foreign_personal_skills: false },
		context_compaction: { soft_threshold: 0.99, hard_threshold: 0.995 },
		...(input.mcpUrl
			? {
					mcp_servers: {
						pi: {
							transport: "streamable_http",
							url: input.mcpUrl,
							headers: { Authorization: "${PI_MUSE_MCP_AUTH}" },
							mode: "required",
							// pi runs the tools and applies its own timeouts; a parked call may wait for a long build.
							tool_timeout_sec: 7 * 24 * 3600,
							startup_timeout_sec: 30,
						},
					},
				}
			: {}),
		...input.overlay,
	};
}

/**
 * A private Muse Code config directory (XDG_CONFIG_HOME) for one host. The user's login state is
 * linked in; it holds no secret (the token lives in the OS keychain). Returns the directory.
 */
export function writeHostConfig(baseDir: string, id: string, userConfigDir: string, input: HostSettingsInput): string {
	const xdg = join(baseDir, "hosts", id);
	const dir = join(xdg, "muse");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(hostSettings(input), null, 1), { mode: 0o600 });
	const auth = join(userConfigDir, "auth.json");
	if (existsSync(auth)) symlinkSync(auth, join(dir, "auth.json"));
	return xdg;
}

export function removeHostConfig(xdg: string | undefined): void {
	if (xdg) rmSync(xdg, { recursive: true, force: true });
}

/** Remove host directories a crashed pi process left behind. */
export function sweepHostConfigs(baseDir: string, olderThanMs = 24 * 3600_000): void {
	const root = join(baseDir, "hosts");
	try {
		for (const name of readdirSync(root)) {
			const p = join(root, name);
			if (Date.now() - statSync(p).mtimeMs > olderThanMs) rmSync(p, { recursive: true, force: true });
		}
	} catch {}
}

/** Every skill Muse Code would load for this user, as an all-off activation map. */
export async function listSkillsOff(museBin: string, baseDir: string, env: Record<string, string | undefined>): Promise<SkillsOff> {
	const xdg = join(baseDir, "hosts", `skills-${process.pid}`);
	mkdirSync(join(xdg, "muse"), { recursive: true, mode: 0o700 });
	try {
		const { stdout } = await run(museBin, ["skills", "list", "--json"], { env: cleanEnv({ ...env, XDG_CONFIG_HOME: xdg }), timeout: 30_000, maxBuffer: 16 << 20 });
		const parsed = JSON.parse(stdout);
		const rows: { scope?: string; path?: string }[] = Array.isArray(parsed) ? parsed : (parsed.skills ?? []);
		const off: SkillsOff = {};
		for (const r of rows) if (r.scope && r.path) (off[r.scope] ??= {})[r.path] = "off";
		return off;
	} catch {
		return {};
	} finally {
		rmSync(xdg, { recursive: true, force: true });
	}
}

/**
 * Environment for a Muse Code process: subscription auth only. META_API_KEY takes priority over the
 * account login in Muse Code and would move every request to pay-as-you-go billing.
 */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
	delete out.META_API_KEY;
	delete out.MUSE_CONTRIBUTOR_MODE;
	// Muse Code may otherwise replace its own binary under a running host.
	out.MUSE_NO_AUTO_UPDATE = "1";
	return out;
}
