import { App, TFile } from "obsidian";
import type { DailyNoteResolver, ResolvedDailyConfig } from "./dailyNotes";
import { createMoment } from "./moment";

export const DAY_KEY_FORMAT = "YYYY-MM-DD";

/**
 * Knows which days actually have a note, so the view can jump straight from one
 * existing day to the next instead of walking the calendar one day at a time.
 *
 * Keys are `YYYY-MM-DD`, which sorts chronologically as plain strings.
 */
export class DailyNoteIndex {
	private keys = new Set<string>();
	private sorted: string[] = [];
	private sortedDirty = true;
	private signature = "";

	/** Bumped on every change, so views can tell when to look again. */
	version = 0;

	constructor(
		private app: App,
		private resolver: DailyNoteResolver,
	) {}

	rebuild(): void {
		const config = this.resolver.config();
		this.keys.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const key = this.keyForPath(file.path, config);
			if (key) this.keys.add(key);
		}
		this.signature = JSON.stringify(config);
		this.sortedDirty = true;
		this.version++;
	}

	/** Rebuilds only if the daily-note configuration moved since the last scan. */
	ensureCurrent(): void {
		if (JSON.stringify(this.resolver.config()) !== this.signature) this.rebuild();
	}

	/** The day a path represents, or null if it is not a daily note. */
	keyForPath(path: string, config?: ResolvedDailyConfig): string | null {
		if (!path.endsWith(".md")) return null;
		const { folder, format } = config ?? this.resolver.config();

		let relative = path.slice(0, -3);
		if (folder) {
			if (!relative.startsWith(`${folder}/`)) return null;
			relative = relative.slice(folder.length + 1);
		}

		const parsed = createMoment(relative, format, true);
		return parsed.isValid() ? parsed.format(DAY_KEY_FORMAT) : null;
	}

	handleCreate(file: TFile): boolean {
		const key = this.keyForPath(file.path);
		if (!key || this.keys.has(key)) return false;
		this.keys.add(key);
		this.sortedDirty = true;
		this.version++;
		return true;
	}

	handleDelete(path: string): boolean {
		const key = this.keyForPath(path);
		if (!key || !this.keys.has(key)) return false;
		// The note may have been recreated elsewhere under the same date.
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return false;
		this.keys.delete(key);
		this.sortedDirty = true;
		this.version++;
		return true;
	}

	has(key: string): boolean {
		return this.keys.has(key);
	}

	get size(): number {
		return this.keys.size;
	}

	/** The first day with a note strictly after `key`. */
	next(key: string): string | null {
		const list = this.list();
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (list[mid] <= key) low = mid + 1;
			else high = mid;
		}
		return low < list.length ? list[low] : null;
	}

	/** The last day with a note strictly before `key`. */
	prev(key: string): string | null {
		const list = this.list();
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (list[mid] < key) low = mid + 1;
			else high = mid;
		}
		return low > 0 ? list[low - 1] : null;
	}

	/**
	 * Every indexed day after `key` in `direction`, wrapping once at the end.
	 * The starting key itself is omitted. Find uses this to scan outward without
	 * materialising empty calendar days.
	 */
	keysFrom(key: string, direction: -1 | 1): string[] {
		// Daily-note keys are YYYY-MM-DD, so lexical and chronological order agree.
		const list = this.list();
		if (direction > 0) {
			return [...list.filter((candidate) => candidate > key), ...list.filter((candidate) => candidate < key)];
		}
		return [
			...list.filter((candidate) => candidate < key).reverse(),
			...list.filter((candidate) => candidate > key).reverse(),
		];
	}

	private list(): string[] {
		if (this.sortedDirty) {
			this.sorted = Array.from(this.keys).sort();
			this.sortedDirty = false;
		}
		return this.sorted;
	}
}
