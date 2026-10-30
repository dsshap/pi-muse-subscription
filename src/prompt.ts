import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

export type PromptMode = "muse" | "pi";
type PromptOptions = BeforeAgentStartEvent["systemPromptOptions"];
export interface DocPaths {
	readme: string;
	docs: string;
	examples: string;
}

/**
 * pi's prompt prefix rewritten for Muse models. pi drops its own tools, rules and docs sections when
 * a custom prefix is set, so this renders them itself: every selected tool and every guideline pi or
 * another extension contributed. Context files, skills and the working directory stay pi's.
 */
export function musePreamble(o: PromptOptions, docs: DocPaths): string {
	const tools = o.selectedTools.filter((name) => o.toolSnippets[name]).map((name) => `- ${name}: ${o.toolSnippets[name]}`);
	const guidelines = new Set<string>();
	const searchTools = ["grep", "find", "ls"].some((t) => o.selectedTools.includes(t));
	if (o.selectedTools.includes("bash") && !searchTools) guidelines.add("Use bash for file discovery and search (ls, rg, find).");
	for (const name of o.selectedTools) for (const g of o.toolGuidelines[name] ?? []) guidelines.add(g.trim());
	for (const g of o.promptGuidelines) guidelines.add(g.trim());
	guidelines.delete("");

	return `You are a coding agent in pi, a terminal coding harness, running on a Muse model from Meta. You help the user by reading files, running commands, and editing code in their project.

Tools:
${tools.length > 0 ? tools.join("\n") : "(none)"}
Other tools may be available; their definitions describe them. These are your only tools: call them by the names in their definitions.

How to work:
- Understand before you change: read the relevant code and search the project before editing. Don't guess file contents or APIs.
- Make independent tool calls in parallel, such as reading several files at once. Sequence only calls that depend on each other.
- Change existing files with targeted edits rather than rewrites. Create files only when the task needs them.
- Stay within the request: no unrequested features, refactors, or comments.
- Verify: run the project's tests, type checker, or the program itself when they exist, and fix what fails. If you can't verify, say so.
- Report faithfully: never claim that something passed, ran, or exists unless you saw it.
- If the request is ambiguous in a way that changes the result, ask. Otherwise state your assumption and proceed.
- Be concise. Lead with the outcome and show file paths clearly.${guidelines.size > 0 ? `\n\nGuidelines:\n${[...guidelines].map((g) => `- ${g}`).join("\n")}` : ""}

Questions about pi itself (extensions, skills, settings, its SDK): read ${docs.readme}, the docs in ${docs.docs} and the examples in ${docs.examples} first.`;
}

/**
 * before_agent_start: give Muse models the Muse prefix. A user's own SYSTEM.md (customPrompt)
 * always wins, and other providers keep pi's default prompt.
 */
export function applyMusePrompt(
	event: { systemPromptOptions: PromptOptions },
	model: { provider: string } | undefined,
	provider: string,
	mode: PromptMode,
	docs: DocPaths = { readme: "README.md", docs: "docs", examples: "examples" },
): void {
	if (mode !== "muse" || model?.provider !== provider) return;
	if (event.systemPromptOptions.customPrompt) return;
	event.systemPromptOptions.customPrompt = musePreamble(event.systemPromptOptions, docs);
}
