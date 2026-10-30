import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyMusePrompt, musePreamble } from "../src/prompt.ts";

const options = () =>
	({
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read files", bash: "Run commands" },
		toolGuidelines: { read: ["Use read, not cat."] },
		promptGuidelines: ["Be kind."],
	}) as any;

describe("prompt", () => {
	it("keeps pi's tools and every contributed guideline", () => {
		const p = musePreamble(options(), { readme: "R", docs: "D", examples: "E" });
		for (const s of ["- read: Read files", "- bash: Run commands", "- Use read, not cat.", "- Be kind.", "Use bash for file discovery"]) assert.ok(p.includes(s), s);
	});

	it("applies only to this provider and never over the user's SYSTEM.md", () => {
		const ev = { systemPromptOptions: options() };
		applyMusePrompt(ev, { provider: "anthropic" }, "muse-sdk", "muse");
		assert.equal(ev.systemPromptOptions.customPrompt, undefined);
		applyMusePrompt(ev, { provider: "muse-sdk" }, "muse-sdk", "pi");
		assert.equal(ev.systemPromptOptions.customPrompt, undefined);
		applyMusePrompt(ev, { provider: "muse-sdk" }, "muse-sdk", "muse");
		assert.match(ev.systemPromptOptions.customPrompt, /Muse model from Meta/);
		const mine = { systemPromptOptions: { ...options(), customPrompt: "MINE" } };
		applyMusePrompt(mine, { provider: "muse-sdk" }, "muse-sdk", "muse");
		assert.equal(mine.systemPromptOptions.customPrompt, "MINE");
	});
});
