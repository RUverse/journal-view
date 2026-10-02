import { App, TFile } from "obsidian";
import type { DailyNoteResolver, ResolvedDailyConfig } from "./dailyNotes";
import { createMoment } from "./moment";

export const DAY_KEY_FORMAT = "YYYY-MM-DD";

/** Days in date order, which the walker and the calendar step through. */
export interface DaySequence {
	has(key: string): boolean;
	range(): { first: string; last: string } | null;
	/** The first day strictly after `key`. */
	next(key: string): string | null;
	/** The last day strictly before `key`. */
	prev(key: string): string | null;
}

/** Chronologically ordered set of daily-note keys used by walkers and navigation. */
export interface OrderedDayIndex extends DaySequence {
	readonly version: number;
	readonly size: number;
	keysFrom(key: string, direction: -1 | 1): string[];
}

/** The first of the sorted `keys` strictly after `key`. */
export function keyAfter(keys: readonly string[], key: string): string | null {
	let low = 0;
	let high = keys.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (keys[mid] <= key) low = mid + 1;
		else high = mid;
	}
	return low < keys.length ? keys[low] : null;
}

/** The last of the sorted `keys` strictly before `key`. */
export function keyBefore(keys: readonly string[], key: string): string | null {
	let low = 0;
	let high = keys.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (keys[mid] < key) low = mid + 1;
		else high = mid;
	}
	return low > 0 ? keys[low - 1] : null;
}

/** Where a path sits in the journal: the day it belongs to, and when in that day. */
export interface DailyNoteLocation {
	key: string;
	/** Parsed from the file name; the start of the day unless the format records a time. */
	time: number;
	/** Text after the date, taken in when a day holds several notes; empty otherwise. */
	suffix: string;
}

interface IndexedNote extends DailyNoteLocation {
	path: string;
}

const noteNames = new Intl.Collator(undefined, { numeric: true });

/** Text after the date has to be set off from it, by a space or punctuation. */
const SUFFIX_START = /^[\s\p{P}\p{S}]/u;
const SUFFIX_SEPARATOR = /^[\s\p{P}\p{S}]+/u;

/** What every date written in a format has in common, used to pass over other names cheaply. */
interface DateShape {
	/** The shortest and longest the written date can be. */
	min: number;
	max: number;
	/** It always starts with an ASCII digit, as `YYYY-MM-DD` does. */
	leadingDigit: boolean;
	/** It always holds a run of at least this many ASCII digits, such as a year. */
	digitRun: number;
}

const shapes = new Map<string, DateShape>();

function longestDigitRun(text: string): number {
	let longest = 0;
	for (const run of text.match(/[0-9]+/g) ?? []) longest = Math.max(longest, run.length);
	return longest;
}

/**
 * Works out the shape of dates written in `format` by writing out every day
 * of a leap year, at times that vary in width. Parsing is what costs, and a
 * vault kept in the same folder as its daily notes asks this of every note.
 */
function dateShape(format: string): DateShape {
	let shape = shapes.get(format);
	if (!shape) {
		shape = { min: Infinity, max: 0, leadingDigit: true, digitRun: Infinity };
		const day = createMoment("2000-01-01", DAY_KEY_FORMAT, true);
		for (let index = 0; index < 366; index++, day.add(1, "days")) {
			for (const [hour, minute] of [[0, 0], [9, 5], [13, 30]]) {
				const written = day.clone().set({ hour, minute, second: minute }).format(format);
				shape.min = Math.min(shape.min, written.length);
				shape.max = Math.max(shape.max, written.length);
				shape.leadingDigit &&= /^[0-9]/.test(written);
				shape.digitRun = Math.min(shape.digitRun, longestDigitRun(written));
			}
		}
		shapes.set(format, shape);
	}
	return shape;
}

/** False when `name` cannot begin with a date of this shape, found without parsing it. */
function mayHoldDate(name: string, shape: DateShape): boolean {
	if (name.length < shape.min) return false;
	if (shape.leadingDigit && !/^[0-9]/.test(name)) return false;
	return shape.digitRun < 2 || longestDigitRun(name) >= shape.digitRun;
}

/**
 * Reads a name that starts with a date written in `format` and goes on after
 * it, set off by a space or punctuation: `2026-08-16 Birthday`. The date is
 * parsed as strictly as a plain daily note's name, which rules out loose
 * readings such as `2026-08-161`, and the rest has to stay in the same folder.
 */
function locateWithSuffix(relative: string, format: string): DailyNoteLocation | null {
	const { min, max } = dateShape(format);
	for (let length = min; length <= Math.min(max, relative.length - 1); length++) {
		const rest = relative.slice(length);
		if (!SUFFIX_START.test(rest) || rest.includes("/")) continue;
		const parsed = createMoment(relative.slice(0, length), format, true);
		if (!parsed.isValid()) continue;
		return {
			key: parsed.format(DAY_KEY_FORMAT),
			time: parsed.valueOf(),
			suffix: rest.replace(SUFFIX_SEPARATOR, "") || rest.trim(),
		};
	}
	return null;
}

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
		const { folder, format, multipleNotes } = config ?? this.resolver.config();

		let relative = path.slice(0, -3);
		if (folder) {
			if (!relative.startsWith(`${folder}/`)) return null;
			relative = relative.slice(folder.length + 1);
		}

		if (!mayHoldDate(relative, dateShape(format))) return null;
		const parsed = createMoment(relative, format, true);
		if (parsed.isValid()) return { key: parsed.format(DAY_KEY_FORMAT), time: parsed.valueOf(), suffix: "" };
		return multipleNotes ? locateWithSuffix(relative, format) : null;
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
		return keyAfter(this.list(), key);
	}

	/** The last day with a note strictly before `key`. */
	prev(key: string): string | null {
		return keyBefore(this.list(), key);
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
