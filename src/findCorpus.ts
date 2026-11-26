import { App, Component, TAbstractFile, TFile } from "obsidian";
import { editorBody } from "./noteBody";

/** How long note texts outlive the last find bar that used them (ms). */
const RELEASE_DELAY = 5 * 60 * 1000;
/** Reads retried when the note changes while being read, before using only a current cached value. */
const READ_ATTEMPTS = 3;

interface PendingRead {
	path: string;
	mtime: number;
	size: number;
	revision: number;
	promise: Promise<string>;
	text?: string;
}

interface CachedText {
	file: TFile;
	mtime: number;
	size: number;
	text: string;
}

/**
 * Note bodies kept for journal-wide find, exactly as an editor holds them, so
 * an offset found in one still points at the same text once its day is open.
 *
 * Nothing is read until a find asks. Every view's find shares the one cache,
 * and the texts are let go a while after the last find bar holding them
 * closes: reopening find soon after is instant, and an idle journal does not
 * keep every note in memory.
 */
export class FindCorpus extends Component {
	private texts = new Map<string, CachedText>();
	private pending = new Map<TFile, PendingRead>();
	/** Bumped when a file changes, so a read already under way is not kept. */
	private revisions = new WeakMap<TFile, number>();
	private listeners = new Set<(paths: string[]) => void>();
	private holds = 0;
	private releaseTimer = 0;
	private closed = false;

	constructor(private app: App) { super(); }

	onload(): void {
		const changed = (file: TAbstractFile, paths: string[]) => {
			if (file instanceof TFile) this.invalidate(file, paths);
			else this.invalidateFolder(paths);
		};
		this.registerEvent(this.app.vault.on("create", (file) => changed(file, [file.path])));
		this.registerEvent(this.app.vault.on("modify", (file) => changed(file, [file.path])));
		this.registerEvent(this.app.vault.on("delete", (file) => changed(file, [file.path])));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => changed(file, [oldPath, file.path])));
		// Filters read a note's properties, which are parsed after it changes.
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.notify([file.path])));
	}

	onunload(): void {
		this.closed = true;
		window.clearTimeout(this.releaseTimer);
		this.releaseTimer = 0;
		this.texts.clear();
		this.pending.clear();
		this.listeners.clear();
	}

	/** Keeps texts while the caller searches; call the returned function once done. */
	retain(): () => void {
		this.holds++;
		window.clearTimeout(this.releaseTimer);
		this.releaseTimer = 0;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.holds > 0 || this.closed) return;
			this.releaseTimer = window.setTimeout(() => {
				this.releaseTimer = 0;
				if (!this.holds) this.texts.clear();
			}, RELEASE_DELAY);
		};
	}

	/** Hears which paths changed, so a search can count them again. */
	subscribe(listener: (paths: string[]) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** The note's body if it is cached and still current, without reading. */
	peek(file: TFile): string | null {
		const cached = this.texts.get(file.path);
		if (!cached || cached.file !== file) return null;
		return cached.mtime === file.stat.mtime && cached.size === file.stat.size ? cached.text : null;
	}

	/** The note's body, read and cached if needed; null when it cannot be read. */
	async read(file: TFile): Promise<string | null> {
		for (let attempt = 0; ; attempt++) {
			if (this.closed) return null;
			const hit = this.peek(file);
			if (hit !== null) return hit;
			const path = file.path;
			const { mtime, size } = file.stat;
			const revision = this.revisions.get(file) ?? 0;
			this.revisions.set(file, revision);
			let text: string | null = null;
			let failure: { error: unknown } | undefined;
			let read = this.pending.get(file);
			try {
				if (!read || read.path !== path || read.mtime !== mtime || read.size !== size || read.revision !== revision) {
					read = { path, mtime, size, revision, promise: this.app.vault.cachedRead(file) };
					this.pending.set(file, read);
				}
				const content = await read.promise;
				text = read.text ??= editorBody(content);
			} catch (error) {
				failure = { error };
			}
			const ownsRead = this.pending.get(file) === read;
			if (ownsRead) this.pending.delete(file);
			if (this.closed || this.app.vault.getAbstractFileByPath(file.path) !== file) return null;
			const unchanged =
				(this.revisions.get(file) ?? 0) === revision &&
				file.path === path &&
				file.stat.mtime === mtime &&
				file.stat.size === size;
			if (unchanged) {
				if (failure && ownsRead) console.warn(`Journal View: could not search ${path}`, failure.error);
				if (text !== null && this.holds > 0) this.texts.set(path, { file, mtime, size, text });
				return text;
			}
			if (attempt + 1 >= READ_ATTEMPTS) return this.peek(file);
		}
	}

	private invalidate(file: TFile, paths: string[]): void {
		if (this.revisions.has(file)) this.revisions.set(file, this.revisions.get(file)! + 1);
		for (const path of paths) this.texts.delete(path);
		this.notify(paths);
	}

	private invalidateFolder(paths: string[]): void {
		const changed: string[] = [];
		for (const key of this.texts.keys()) {
			if (paths.some((path) => key.startsWith(`${path}/`))) changed.push(key);
		}
		for (const [file, read] of this.pending) {
			if (!paths.some((path) => read.path.startsWith(`${path}/`) || file.path.startsWith(`${path}/`))) continue;
			this.revisions.set(file, (this.revisions.get(file) ?? 0) + 1);
			changed.push(read.path, file.path);
		}
		for (const path of changed) this.texts.delete(path);
		this.notify([...paths, ...new Set(changed)]);
	}

	private notify(paths: string[]): void {
		for (const listener of this.listeners) listener(paths);
	}
}
