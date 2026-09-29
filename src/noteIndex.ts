import { App, TFile } from "obsidian";
import type { DailyNoteResolver, ResolvedDailyConfig } from "./dailyNotes";
import { createMoment } from "./moment";

export const DAY_KEY_FORMAT = "YYYY-MM-DD";

/** Chronologically ordered set of daily-note keys used by walkers and navigation. */
export interface OrderedDayIndex {
	readonly version: number;
	has(key: string): boolean;
	readonly size: number;
	range(): { first: string; last: string } | null;
	next(key: string): string | null;
	prev(key: string): string | null;
	keysFrom(key: string, direction: -1 | 1): string[];
}

/** Where a path sits in the journal: the day it belongs to, and when in that day. */
export interface DailyNoteLocation {
	key: string;
	/** Parsed from the file name; the start of the day unless the format records a time. */
	time: number;
}

interface IndexedNote extends DailyNoteLocation {
	path: string;
}

const noteNames = new Intl.Collator(undefined, { numeric: true });

/**
 * The order notes are shown in within a day: by the time their file name
 * records, then by name. A name that is a prefix of another sorts first, so
 * `2026-08-16` comes before `2026-08-16 evening`.
 */
function compareNotes(left: IndexedNote, right: IndexedNote): number {
	return left.time - right.time || noteNames.compare(left.path.slice(0, -3), right.path.slice(0, -3));
}

/**
 * Knows which days actually have a note, so the view can jump straight from one
 * existing day to the next instead of walking the calendar one day at a time -
 * and which notes each of those days holds, since a date format that records
 * a time of day can give one day several.
 *
 * Keys are `YYYY-MM-DD`, which sorts chronologically as plain strings.
 */
export class DailyNoteIndex implements OrderedDayIndex {
	/** Every indexed note, grouped by day and kept in display order. */
	private days = new Map<string, IndexedNote[]>();
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
		this.days.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const location = this.locate(file.path, config);
			if (location) this.add({ path: file.path, ...location });
		}
		this.signature = JSON.stringify(config);
		this.sortedDirty = true;
		this.version++;
	}

	/** Rebuilds only if the daily-note configuration moved since the last scan. */
	ensureCurrent(): void {
		if (JSON.stringify(this.resolver.config()) !== this.signature) this.rebuild();
	}

	/** One resolved configuration for callers scanning more than one path. */
	resolvedConfig(): ResolvedDailyConfig {
		return this.resolver.config();
	}

	/** The day a path represents, or null if it is not a daily note. */
	keyForPath(path: string, config?: ResolvedDailyConfig): string | null {
		return this.locate(path, config)?.key ?? null;
	}

	/** The day and time a path represents, or null if it is not a daily note. */
	locate(path: string, config?: ResolvedDailyConfig): DailyNoteLocation | null {
		if (!path.endsWith(".md")) return null;
		const { folder, format } = config ?? this.resolver.config();

		let relative = path.slice(0, -3);
		if (folder) {
			if (!relative.startsWith(`${folder}/`)) return null;
			relative = relative.slice(folder.length + 1);
		}

		const parsed = createMoment(relative, format, true);
		return parsed.isValid() ? { key: parsed.format(DAY_KEY_FORMAT), time: parsed.valueOf() } : null;
	}

	/** The notes indexed for a day, in the order they are shown. */
	pathsFor(key: string): string[] {
		return this.days.get(key)?.map((note) => note.path) ?? [];
	}

	handleCreate(file: TFile): boolean {
		const location = this.locate(file.path);
		if (!location || this.days.get(location.key)?.some((note) => note.path === file.path)) return false;
		this.add({ path: file.path, ...location });
		this.version++;
		return true;
	}

	handleDelete(path: string): boolean {
		const key = this.keyForPath(path);
		const notes = key ? this.days.get(key) : undefined;
		const at = notes?.findIndex((note) => note.path === path) ?? -1;
		if (!key || !notes || at < 0) return false;
		// The note may have been recreated elsewhere under the same date.
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return false;
		notes.splice(at, 1);
		if (!notes.length) {
			this.days.delete(key);
			this.sortedDirty = true;
		}
		this.version++;
		return true;
	}

	has(key: string): boolean {
		return this.days.has(key);
	}

	/** The number of days with at least one note. */
	get size(): number {
		return this.days.size;
	}

	/** The first and last indexed day, or null when the vault has no daily notes. */
	range(): { first: string; last: string } | null {
		const list = this.list();
		if (!list.length) return null;
		return { first: list[0], last: list[list.length - 1] };
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

	private add(note: IndexedNote): void {
		const notes = this.days.get(note.key);
		if (!notes) {
			this.days.set(note.key, [note]);
			this.sortedDirty = true;
			return;
		}
		let at = notes.findIndex((other) => compareNotes(note, other) < 0);
		if (at < 0) at = notes.length;
		notes.splice(at, 0, note);
	}

	private list(): string[] {
		if (this.sortedDirty) {
			this.sorted = Array.from(this.days.keys()).sort();
			this.sortedDirty = false;
		}
		return this.sorted;
	}
}
