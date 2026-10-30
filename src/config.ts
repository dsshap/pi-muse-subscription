import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
	/** The `muse` executable. Default: `muse` on PATH. */
	museBin?: string;
	/** "muse" (default): a pi prompt prefix written for Muse models. "pi": pi's default prompt. */
	promptMode?: "muse" | "pi";
	maxSessions?: number;
	idleMinutes?: number;
	/** Muse Code Contributor mode for these requests. Default: your saved Muse Code setting, else off. */
	contributorMode?: "on" | "off";
}

function readJson(file: string): Record<string, unknown> | undefined {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

const intIn = (lo: number, hi: number) => (n: unknown): n is number => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
const validMaxSessions = intIn(1, 16);
const validIdleMinutes = intIn(1, 24 * 60);
const onOff = (v: unknown): "on" | "off" | undefined => (v === "on" || v === "off" ? v : undefined);

/** Muse Code's own configuration directory. */
export function museConfigDir(env: Record<string, string | undefined>, home: string): string {
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "muse");
}

/** Contributor mode as saved in Muse Code's settings, when it was ever saved. */
export function savedContributorMode(configDir: string): "on" | "off" | undefined {
	const v = readJson(join(configDir, "settings.json"))?.contributor_mode_enabled;
	return v === true ? "on" : v === false ? "off" : undefined;
}

/**
 * The global config (pi's agent directory) and the environment may choose the executable. A
 * project's `.pi/muse-sdk.json` may only tune harmless settings: it is read before project trust.
 */
export function resolveConfig(where: { cwd: string; agentDir: string; home: string; env: Record<string, string | undefined> }): Config & { contributorMode: "on" | "off" } {
	const global = (readJson(join(where.agentDir, "muse-sdk.json")) ?? {}) as Config;
	const project = (readJson(join(where.cwd, ".pi", "muse-sdk.json")) ?? {}) as Config;
	const env = where.env;
	return {
		...(validMaxSessions(global.maxSessions) ? { maxSessions: global.maxSessions } : {}),
		...(validIdleMinutes(global.idleMinutes) ? { idleMinutes: global.idleMinutes } : {}),
		...(validMaxSessions(project.maxSessions) ? { maxSessions: project.maxSessions } : {}),
		...(validIdleMinutes(project.idleMinutes) ? { idleMinutes: project.idleMinutes } : {}),
		museBin: env.PI_MUSE_SDK_MUSE_PATH || (typeof global.museBin === "string" ? global.museBin : undefined),
		promptMode: env.PI_MUSE_SDK_PROMPT === "pi" || (env.PI_MUSE_SDK_PROMPT === undefined && global.promptMode === "pi") ? "pi" : "muse",
		contributorMode: onOff(env.PI_MUSE_SDK_CONTRIBUTOR) ?? onOff(global.contributorMode) ?? savedContributorMode(museConfigDir(env, where.home)) ?? "off",
	};
}
