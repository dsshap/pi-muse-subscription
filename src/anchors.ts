import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Where a conversation state lives in Muse Code's own sessions: right after the completed turn
 * `turnId` of session `sessionId`. Keyed by the pi transcript chain hash, so a pi session that
 * diverges from a live Muse host (abort, /tree, fork, restart) continues from Muse's own record
 * of that turn instead of a re-sent transcript.
 */
export interface Anchor {
	sessionId: string;
	turnId: string;
	cwd: string;
}

const MAX_ENTRIES = 20_000;

export class AnchorRegistry {
	private map = new Map<string, Anchor>();
	/** The last turn of each Muse session that is known to end cleanly (null: a turn after it may be partial). */
	private tails = new Map<string, string | null>();
	private loaded = false;
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.file)) return;
		const lines = readFileSync(this.file, "utf8").split("\n");
		for (const line of lines) {
			if (!line) continue;
			try {
				const e = JSON.parse(line);
				if (typeof e.tail === "string") this.tails.set(e.tail, typeof e.t === "string" ? e.t : null);
				else if (typeof e.k === "string") this.map.set(e.k, { sessionId: e.s, turnId: e.t, cwd: e.c });
			} catch {}
		}
		if (lines.length > MAX_ENTRIES * 2) this.compact();
	}

	private compact(): void {
		const entries = [...this.map.entries()].slice(-MAX_ENTRIES);
		this.map = new Map(entries);
		const live = new Set(entries.map(([, a]) => a.sessionId));
		const tails = [...this.tails.entries()].filter(([s]) => live.has(s));
		this.tails = new Map(tails);
		try {
			writeFileSync(this.file, [...entries.map(([k, a]) => anchorLine(k, a)), ...tails.map(([s, t]) => tailLine(s, t))].join(""));
		} catch {}
	}

	get(key: string): Anchor | undefined {
		this.load();
		return this.map.get(key);
	}

	/** The session's last clean turn, or undefined when unknown or followed by a partial turn. */
	tail(sessionId: string): string | undefined {
		this.load();
		return this.tails.get(sessionId) ?? undefined;
	}

	put(key: string, anchor: Anchor): void {
		this.load();
		this.map.delete(key);
		this.map.set(key, anchor);
		this.tails.set(anchor.sessionId, anchor.turnId);
		this.append(anchorLine(key, anchor) + tailLine(anchor.sessionId, anchor.turnId));
	}

	/** A turn started on the session: until it completes cleanly, the session's tail is unknown. */
	openTurn(sessionId: string): void {
		this.load();
		if (this.tails.get(sessionId) === null) return;
		this.tails.set(sessionId, null);
		this.append(tailLine(sessionId, null));
	}

	private append(text: string): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, text);
		} catch {
			// Persistence is an optimization; the in-memory maps still serve this process.
		}
	}
}

function anchorLine(k: string, a: Anchor): string {
	return `${JSON.stringify({ k, s: a.sessionId, t: a.turnId, c: a.cwd })}\n`;
}

function tailLine(sessionId: string, turnId: string | null): string {
	return `${JSON.stringify({ tail: sessionId, t: turnId })}\n`;
}
