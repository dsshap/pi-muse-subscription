import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";
import { MCP_SERVER } from "./convert.ts";

export type CallToolResult = { content: any[]; isError?: boolean };
/** Answers one MCP tool call; `callId` is the model's tool-call id, which Muse Code sends as `_meta.callId`. */
export type CallHandler = (callId: string | undefined, name: string) => Promise<CallToolResult>;

interface Route {
	tools: Tool[];
	token: string;
	call: CallHandler;
}

/**
 * pi's tools as a loopback MCP server (streamable HTTP, stateless). Each Muse host gets its own
 * path and bearer token. A tool call's HTTP request stays open until pi delivers the result, so
 * the server never times requests out; Muse Code's own limit is `tool_timeout_sec` in its config.
 */
export class McpBridge {
	private server?: Server;
	private listening?: Promise<number>;
	private readonly routes = new Map<string, Route>();

	async register(id: string, tools: Tool[], call: CallHandler): Promise<{ url: string; token: string }> {
		const port = await this.listen();
		const token = randomBytes(24).toString("hex");
		this.routes.set(id, { tools, token, call });
		return { url: `http://127.0.0.1:${port}/mcp/${id}`, token };
	}

	unregister(id: string): void {
		this.routes.delete(id);
	}

	close(): void {
		this.server?.close();
		this.server?.closeAllConnections?.();
		this.server = undefined;
		this.listening = undefined;
	}

	private listen(): Promise<number> {
		this.listening ??= new Promise((resolve, reject) => {
			const server = createServer((req, res) => void this.handle(req, res));
			server.requestTimeout = 0;
			server.timeout = 0;
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.unref();
				resolve((server.address() as { port: number }).port);
			});
			this.server = server;
		});
		return this.listening;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const id = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec((req.url ?? "").split("?")[0])?.[1];
			const route = id ? this.routes.get(id) : undefined;
			if (!route) return void res.writeHead(404).end();
			if (req.headers.authorization !== `Bearer ${route.token}`) return void res.writeHead(401).end();
			let raw = "";
			req.setEncoding("utf8");
			for await (const chunk of req) raw += chunk;
			const list = route.tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: { type: "object", ...(JSON.parse(JSON.stringify(t.parameters ?? {})) as object) },
			}));
			const server = new McpServer({ name: MCP_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list as any }));
			server.setRequestHandler(CallToolRequestSchema, async (r) => (await route.call((r.params as any)?._meta?.callId, r.params.name)) as any);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => {
				void transport.close();
				void server.close();
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
		} catch {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		}
	}
}
