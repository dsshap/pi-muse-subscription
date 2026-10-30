import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ProviderChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

/** Muse Code's reasoning efforts, as sent on `turn/start`. */
export type MuseEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A row of Muse Code's `model/list` catalog (the fields this extension reads). */
export interface CatalogRow {
	modelId: string;
	displayLabel?: string;
	contextLimit?: number | null;
	outputLimit?: number | null;
	variants?: unknown;
}

/** Bundled snapshot so `--model` works before Muse Code's live catalog has been read. */
export const SNAPSHOT: CatalogRow[] = [
	{ modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", contextLimit: 1_007_997, outputLimit: 128_000, variants: ["minimal", "low", "medium", "high", "xhigh", "max"] },
	{ modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder 1.0", contextLimit: 1_007_997, outputLimit: 128_000, variants: ["minimal", "low", "medium", "high", "xhigh", "max"] },
	{ modelId: "muse-spark-1.2", displayLabel: "Muse Spark 1.2", contextLimit: 1_007_997, outputLimit: 128_000, variants: ["minimal", "low", "medium", "high", "xhigh"] },
];

/** Context window pi plans against: below Muse Code's own compaction point, so pi always compacts first. */
const CONTEXT = 1_000_000;
const OUTPUT = 128_000;

export function museModels(rows: readonly CatalogRow[] = SNAPSHOT): ProviderChatModelConfig[] {
	return rows.map((r) => {
		const variants = Array.isArray(r.variants) ? new Set(r.variants as string[]) : undefined;
		const map: Record<string, string | null> = { off: variants && !variants.has("none") ? null : "none" };
		for (const level of PI_LEVELS) map[level] = !variants || variants.has(level) ? level : null;
		const context = r.contextLimit ? Math.min(CONTEXT, Math.floor(r.contextLimit * 0.95)) : CONTEXT;
		return {
			id: r.modelId,
			name: `${r.displayLabel || r.modelId} (Muse subscription)`,
			reasoning: true,
			input: ["text", "image"],
			// Flat-rate subscription: no per-token price.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: context,
			maxTokens: r.outputLimit ?? OUTPUT,
			thinkingLevelMap: map,
		} as ProviderChatModelConfig;
	});
}

/**
 * Muse effort for a pi thinking level (already resolved through the model's thinkingLevelMap). No
 * thinking means the model's lowest effort when it cannot turn reasoning off (`off` maps to null).
 */
export function museEffort(level: string | undefined, levelMap?: Record<string, string | null | undefined>): MuseEffort {
	if (!level || level === "off" || level === "none") return levelMap && levelMap.off === null ? ((PI_LEVELS.find((l) => levelMap[l]) ?? "minimal") as MuseEffort) : "none";
	return (PI_LEVELS as readonly string[]).includes(level) ? (level as MuseEffort) : "high";
}
