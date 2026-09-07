import { App, Component, TAbstractFile, TFile, getFrontMatterInfo } from "obsidian";

const MAX_CACHED_NOTES = 2000;
const COUNT_CHUNK_SIZE = 32768;

interface CountCache {
	file: TFile;
	mtime: number;
	size: number;
	words: number;
}

export type NoteStatistics = { status: "ready"; words: number } | { status: "error" };

export function wordCountLevel(words: number): number {
	return words === 0 ? 0 : words < 300 ? 1 : words < 800 ? 2 : words < 2000 ? 3 : 4;
}

/** Count whitespace-separated body tokens containing a letter or number.
 * Work in bounded slices, retaining token state across slice boundaries. This
 * avoids both a giant split array and blocking the UI on a very large note.
 */
async function countWords(content: string, current: () => boolean): Promise<number | null> {
	let words = 0;
	let countedToken = false;
	const start = getFrontMatterInfo(content).contentStart;
	for (let offset = start; offset < content.length;) {
		if (!current()) return null;
		let end = Math.min(content.length, offset + COUNT_CHUNK_SIZE);
		// Keep a Unicode surrogate pair together at a slice boundary.
		const last = content.charCodeAt(end - 1);
		if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--;
		const chunk = content.slice(offset, end);
		const tokens = /\s+|[^\s]+/gu;
		for (const match of chunk.matchAll(tokens)) {
			if (/^\s/u.test(match[0])) countedToken = false;
			else if (!countedToken && /[\p{L}\p{N}]/u.test(match[0])) {
				words++;
				countedToken = true;
			}
		}
		offset = end;
		if (offset < content.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	}
	return words;
}

/** Shared, lazy count cache. No file contents are read until a view requests one. */
export class JournalStatistics extends Component {
	private cache = new Map<string, CountCache>();
	private revisions = new WeakMap<TFile, number>();
	private listeners = new Set<(paths: string[], folder: boolean) => void>();
	private running = 0;
	private waiting: Array<() => void> = [];
	private closed = false;

	constructor(private app: App) { super(); }

	onload(): void {
		const changed = (file: TAbstractFile) => {
			if (file instanceof TFile) this.invalidate(file, [file.path]);
			else this.invalidateFolder([file.path]);
		};
		this.registerEvent(this.app.vault.on("create", changed));
		this.registerEvent(this.app.vault.on("modify", changed));
		this.registerEvent(this.app.vault.on("delete", changed));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile) this.invalidate(file, [oldPath, file.path]);
			else this.invalidateFolder([oldPath, file.path]);
		}));
	}

	onunload(): void {
		this.closed = true;
		this.cache.clear();
		this.listeners.clear();
	}

	subscribe(listener: (paths: string[], folder: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private invalidate(file: TFile, paths: string[]): void {
		if (this.revisions.has(file)) this.revisions.set(file, this.revisions.get(file)! + 1);
		for (const path of paths) this.cache.delete(path);
		for (const listener of this.listeners) listener(paths, false);
	}

	private invalidateFolder(paths: string[]): void {
		for (const key of this.cache.keys()) {
			if (paths.some((path) => key.startsWith(`${path}/`))) this.cache.delete(key);
		}
		for (const listener of this.listeners) listener(paths, true);
	}

	peek(file: TFile): NoteStatistics | null {
		const cached = this.cache.get(file.path);
		if (!cached || cached.file !== file || cached.mtime !== file.stat.mtime || cached.size !== file.stat.size) return null;
		this.cache.delete(file.path);
		this.cache.set(file.path, cached);
		return { status: "ready", words: cached.words };
	}

	async count(file: TFile, current: () => boolean): Promise<NoteStatistics | null> {
		if (this.closed || !current()) return null;
		// All views share two read slots. Re-check cancellation and cache after
		// acquiring a slot, so obsolete years never start another file read.
		if (this.running >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
		else this.running++;
		try {
			if (this.closed || !current()) return null;
			const cached = this.peek(file);
			if (cached) return cached;
			const path = file.path;
			const { mtime, size } = file.stat;
			const revisions = this.revisions;
			const revision = revisions.get(file) ?? 0;
			revisions.set(file, revision);
			const unchanged = () => !this.closed && current() && this.revisions === revisions &&
				(revisions.get(file) ?? 0) === revision && file.path === path &&
				file.stat.mtime === mtime && file.stat.size === size &&
				this.app.vault.getAbstractFileByPath(path) === file;
			const content = await this.app.vault.cachedRead(file);
			const words = await countWords(content, unchanged);
			if (words === null || !unchanged()) return null;
			this.cache.set(path, { file, mtime, size, words });
			if (this.cache.size > MAX_CACHED_NOTES) {
				const oldest = this.cache.keys().next().value as string | undefined;
				if (oldest !== undefined) this.cache.delete(oldest);
			}
			return { status: "ready", words };
		} catch (error) {
			if (this.closed || !current()) return null;
			console.warn(`Journal View: could not count words in ${file.path}`, error);
			return { status: "error" };
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.running--;
		}
	}
}
