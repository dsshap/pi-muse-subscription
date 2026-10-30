import type { AssistantMessage, ImageContent, SystemMessage, TextContent, Tool, ToolResultMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { getCurrentTools, getInitialSystemMessage, getSystemMessageText, renderSystemMessageUpdate, toToolDeclaration } from "@earendil-works/pi-ai";
import { sha, stableStringify } from "./util.ts";

/** Name of the MCP server that carries pi's tools into Muse Code. */
export const MCP_SERVER = "pi";
/** Muse Code's toolset selector for every tool of that server, and nothing else. */
export const MCP_TOOLSET = `mcp__${MCP_SERVER}__*`;

/** A transcript message the provider consumes: everything but the leading system message. */
export type TurnMessage = UserMessage | AssistantMessage | ToolResultMessage | SystemMessage;

/** One part of a Muse turn input. */
export type InputPart = { type: "text"; text: string } | { type: "image"; base64Data: string; mediaType: string };

export interface Transcript {
	/** Leading system prompt text; fixed for the lifetime of a Muse host. */
	systemPrompt: string;
	/** Tools in effect for this request (after every transcript delta). */
	tools: Tool[];
	toolsHash: string;
	messages: TurnMessage[];
	/** chain[i] identifies the conversation state after messages[0..i). chain[0] is the prompt alone. */
	chain: string[];
}

/**
 * Prepare pi's transcript. Failed or aborted assistant turns are dropped, as pi's built-in
 * providers do, together with the tool results that answer their calls.
 */
export function readTranscript(context: TranscriptContext): Transcript {
	const leading = getInitialSystemMessage(context.messages);
	const systemPrompt = leading ? getSystemMessageText(leading) : "";
	const tools = getCurrentTools(context.messages).map(toToolDeclaration);
	const messages: TurnMessage[] = [];
	const droppedCalls = new Set<string>();
	for (const m of context.messages) {
		if (m === leading) continue;
		if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
			for (const c of m.content) if (c.type === "toolCall") droppedCalls.add(c.id);
			continue;
		}
		if (m.role === "toolResult" && droppedCalls.has(m.toolCallId)) continue;
		messages.push(m as TurnMessage);
	}
	const chain = [sha(`prompt\0${systemPrompt}`)];
	for (const m of messages) chain.push(sha(`${chain[chain.length - 1]}\0${fingerprint(m)}`));
	return { systemPrompt, tools, toolsHash: sha(stableStringify(tools)), messages, chain };
}

/** Content identity of a message: what the model sees, without timestamps, usage or ids pi adds. */
export function fingerprint(m: TurnMessage): string {
	switch (m.role) {
		case "user":
			return stableStringify(["u", normContent(m.content)]);
		case "toolResult":
			return stableStringify(["r", m.toolCallId, normContent(m.content), !!m.isError]);
		case "system":
			return stableStringify(["s", renderSystemMessageUpdate(m)]);
		case "assistant":
			return stableStringify([
				"a",
				m.content
					.filter((c) => !(c.type === "text" && c.text.length === 0))
					.map((c) => (c.type === "text" ? ["t", c.text] : c.type === "thinking" ? ["k", c.thinking] : ["c", c.id, c.name, c.arguments])),
			]);
	}
}

function normContent(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return [["t", content]];
	return content.map((c) => (c.type === "text" ? ["t", c.text] : ["i", c.mimeType, sha(c.data)]));
}

/** pi's tool name for a Muse tool name (`mcp__pi__read` or the namespaced `mcp__pi.read`), else undefined. */
export function piToolName(name: string): string | undefined {
	for (const prefix of [`mcp__${MCP_SERVER}__`, `mcp__${MCP_SERVER}.`]) if (name.startsWith(prefix)) return name.slice(prefix.length);
	return undefined;
}

/** A later system message (prompt or section change), delivered as a system reminder in the user turn. */
export function systemUpdateText(m: SystemMessage): string | undefined {
	const text = renderSystemMessageUpdate(m).trim();
	return text ? `<system-reminder>\n${text}\n</system-reminder>` : undefined;
}

function contentParts(content: string | (TextContent | ImageContent)[]): InputPart[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	return content
		.filter((c) => c.type !== "text" || c.text.length > 0)
		.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", base64Data: c.data, mediaType: c.mimeType }));
}

/**
 * Turn input for consecutive non-assistant messages. Tool results normally travel through MCP;
 * any that reach here have no parked call to answer and are shown to the model as text.
 */
export function turnInput(tail: TurnMessage[]): InputPart[] {
	const parts: InputPart[] = [];
	for (const m of tail) {
		if (m.role === "user") parts.push(...contentParts(m.content));
		else if (m.role === "system") {
			const text = systemUpdateText(m);
			if (text) parts.push({ type: "text", text });
		} else if (m.role === "toolResult") parts.push({ type: "text", text: toolResultText(m) });
	}
	return parts;
}

function toolResultText(m: ToolResultMessage): string {
	const body = m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n") || "(no output)";
	return `<tool_result tool="${m.toolName}" id="${m.toolCallId}"${m.isError ? ' error="true"' : ""}>\n${body}\n</tool_result>`;
}

/**
 * Earlier conversation Muse Code has no record of (another provider's turns, a compacted session,
 * a session from before the extension), rendered as text for the first turn of a fresh session.
 */
export function historyText(messages: TurnMessage[]): string {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
			out.push(`<user>\n${text}\n</user>`);
		} else if (m.role === "system") {
			const text = systemUpdateText(m);
			if (text) out.push(text);
		} else if (m.role === "toolResult") {
			out.push(toolResultText(m));
		} else {
			const body = m.content
				.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `<tool_call tool="${c.name}" id="${c.id}">${JSON.stringify(c.arguments ?? {})}</tool_call>` : ""))
				.filter((s) => s.length > 0)
				.join("\n");
			if (body) out.push(`<assistant>\n${body}\n</assistant>`);
		}
	}
	return `<conversation_history>\nThe conversation so far, carried over from an earlier session. You are the assistant in it; its tool calls ran and their results are shown. Continue from the latest message below.\n\n${out.join("\n\n")}\n</conversation_history>`;
}
