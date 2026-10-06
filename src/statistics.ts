import { App, Component, TAbstractFile, TFile, getFrontMatterInfo } from "obsidian";
import { noteWords } from "./vocabulary";

const MAX_CACHED_NOTES = 2000;
const COUNT_CHUNK_SIZE = 32768;

interface CountCache {
	file: TFile;
	mtime: number;
	size: number;
	words: number;
}

interface VocabularyCache extends CountCache {
	/** The note's distinct words, as ids into the shared word list. */
	ids: Uint32Array;
}

export type NoteStatistics = { status: "ready"; words: number } | { status: "error" };
export type NoteVocabulary = { status: "ready"; ids: Uint32Array } | { status: "error" };

interface GuardedRead {
	path: string;
	mtime: number;
	size: number;
	content: string;
	/** False once the file, or the caller's interest in it, has moved on since the read began. */
	unchanged: () => boolean;
}

export function wordCountLevel(words: number): number {
	return words === 0 ? 0 : words < 150 ? 1 : words < 400 ? 2 : words < 1000 ? 3 : 4;
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

/**
 * Shared, lazy count cache. No file contents are read until a view requests one.
 *
 * Counts are kept for a bounded number of recent notes. Vocabularies, which
 * only mean anything for the whole journal at once, are kept for every note
 * read, as compact id arrays into one shared, interned word list.
 */
export class JournalStatistics extends Component {
	private cache = new Map<string, CountCache>();
	private vocabularies = new Map<string, VocabularyCache>();
	private ids = new Map<string, number>();
	private words: string[] = [];
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
		this.vocabularies.clear();
		this.ids.clear();
		this.words = [];
		this.listeners.clear();
	}

	subscribe(listener: (paths: string[], folder: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private invalidate(file: TFile, paths: string[]): void {
		if (this.revisions.has(file)) this.revisions.set(file, this.revisions.get(file)! + 1);
		for (const path of paths) {
			this.cache.delete(path);
			this.vocabularies.delete(path);
		}
		for (const listener of this.listeners) listener(paths, false);
	}

	private invalidateFolder(paths: string[]): void {
		for (const cache of [this.cache, this.vocabularies]) {
			for (const key of cache.keys()) {
				if (paths.some((path) => key.startsWith(`${path}/`))) cache.delete(key);
			}
		}
		for (const listener of this.listeners) listener(paths, true);
	}

	/** One more than the largest id a vocabulary can hold so far. */
	get vocabularySize(): number {
		return this.words.length;
	}

	/** The word an id from a vocabulary stands for. */
	word(id: number): string {
		return this.words[id];
	}

	private isFresh(cached: CountCache, file: TFile): boolean {
		return cached.file === file && cached.mtime === file.stat.mtime && cached.size === file.stat.size;
	}

	peek(file: TFile): NoteStatistics | null {
		const cached = this.cache.get(file.path);
		if (cached && this.isFresh(cached, file)) {
			this.cache.delete(file.path);
			this.cache.set(file.path, cached);
			return { status: "ready", words: cached.words };
		}
		// Reading a vocabulary counts the note too, so a journal-wide scan fills every year.
		const read = this.vocabularies.get(file.path);
		return read && this.isFresh(read, file) ? { status: "ready", words: read.words } : null;
	}

	peekVocabulary(file: TFile): NoteVocabulary | null {
		const cached = this.vocabularies.get(file.path);
		return cached && this.isFresh(cached, file) ? { status: "ready", ids: cached.ids } : null;
	}

	async count(file: TFile, current: () => boolean): Promise<NoteStatistics | null> {
		return this.withSlot(file, current, () => this.peek(file), async (read) => {
			const words = await countWords(read.content, read.unchanged);
			if (words === null || !read.unchanged()) return null;
			this.cache.set(read.path, { file, mtime: read.mtime, size: read.size, words });
			if (this.cache.size > MAX_CACHED_NOTES) {
				const oldest = this.cache.keys().next();
				if (!oldest.done) this.cache.delete(oldest.value);
			}
			return { status: "ready", words };
		});
	}

	async vocabulary(file: TFile, current: () => boolean): Promise<NoteVocabulary | null> {
		return this.withSlot(file, current, () => this.peekVocabulary(file), async (read) => {
			const words = await countWords(read.content, read.unchanged);
			const found = words === null ? null : await noteWords(read.content, read.unchanged);
			if (words === null || found === null || !read.unchanged()) return null;
			const ids = Uint32Array.from(found, (word) => this.intern(word));
			this.vocabularies.set(read.path, { file, mtime: read.mtime, size: read.size, words, ids });
			return { status: "ready", ids };
		});
	}

	private intern(word: string): number {
		let id = this.ids.get(word);
		if (id === undefined) {
			id = this.words.length;
			this.ids.set(word, id);
			this.words.push(word);
		}
		return id;
	}

	/**
	 * Runs `work` on the file's contents in one of the two read slots all views
	 * share. Cancellation and the cache are checked again once a slot is free,
	 * so obsolete requests never start another file read.
	 */
	private async withSlot<T>(
		file: TFile,
		current: () => boolean,
		cached: () => T | null,
		work: (read: GuardedRead) => Promise<T | null>,
	): Promise<T | { status: "error" } | null> {
		if (this.closed || !current()) return null;
		if (this.running >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
		else this.running++;
		try {
			if (this.closed || !current()) return null;
			const hit = cached();
			if (hit) return hit;
			const path = file.path;
			const { mtime, size } = file.stat;
			const revision = this.revisions.get(file) ?? 0;
			this.revisions.set(file, revision);
			const unchanged = () => !this.closed && current() &&
				(this.revisions.get(file) ?? 0) === revision && file.path === path &&
				file.stat.mtime === mtime && file.stat.size === size &&
				this.app.vault.getAbstractFileByPath(path) === file;
			const content = await this.app.vault.cachedRead(file);
			return await work({ path, mtime, size, content, unchanged });
		} catch (error) {
			if (this.closed || !current()) return null;
			console.warn(`Journal View: could not read ${file.path} for statistics`, error);
			return { status: "error" };
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.running--;
		}
	}
}
