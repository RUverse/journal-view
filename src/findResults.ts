import { keyAfter, keyBefore } from "./noteIndex";

/** A match by where it sits in the journal: its day, its note, and which of the note's matches. */
export interface FindPosition {
	key: string;
	path: string;
	/** Which of the note's matches, counted in text order. */
	index: number;
}

interface NoteMatches {
	path: string;
	/** Where the note sits within its day. */
	order: number;
	count: number;
	/** The search pass that last counted the note. */
	generation: number;
}

interface DayMatches {
	/** Notes with at least one match, in the order the day shows them. */
	notes: NoteMatches[];
	count: number;
}

/**
 * How many times every note in the journal matches the query - counts only,
 * since the ranges of a note no one is looking at are cheap to find again,
 * and a one-letter query can match millions of times.
 *
 * Positions run down the timeline: days in `step` order, as `sortStep()`
 * gives it, and within a day its notes and their matches in reading order.
 */
export class FindResults {
	private days = new Map<string, DayMatches>();
	/** Days with matches, in date order. */
	private keys: string[] = [];
	private noteKeys = new Map<string, string>();
	total = 0;

	clear(): void {
		this.days.clear();
		this.keys = [];
		this.noteKeys.clear();
		this.total = 0;
	}

	/** The note's matches as last counted, or null when it has none. */
	note(path: string): { key: string; order: number; count: number } | null {
		const key = this.noteKeys.get(path);
		const note = key ? this.days.get(key)?.notes.find((candidate) => candidate.path === path) : undefined;
		return key && note ? { key, order: note.order, count: note.count } : null;
	}

	/** Records how many times the note matches, replacing whatever it had. */
	set(key: string, path: string, order: number, count: number, generation: number): void {
		this.delete(path);
		if (count <= 0) return;
		let day = this.days.get(key);
		if (!day) {
			day = { notes: [], count: 0 };
			this.days.set(key, day);
			let low = 0;
			let high = this.keys.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (this.keys[mid] < key) low = mid + 1;
				else high = mid;
			}
			this.keys.splice(low, 0, key);
		}
		const note: NoteMatches = { path, order, count, generation };
		let at = day.notes.findIndex(
			(other) => other.order > order || (other.order === order && other.path > path),
		);
		if (at < 0) at = day.notes.length;
		day.notes.splice(at, 0, note);
		day.count += count;
		this.noteKeys.set(path, key);
		this.total += count;
	}

	delete(path: string): void {
		const key = this.noteKeys.get(path);
		if (!key) return;
		this.noteKeys.delete(path);
		const day = this.days.get(key);
		const at = day?.notes.findIndex((note) => note.path === path) ?? -1;
		if (!day || at < 0) return;
		const [note] = day.notes.splice(at, 1);
		day.count -= note.count;
		this.total -= note.count;
		if (day.notes.length) return;
		this.days.delete(key);
		const index = this.keys.indexOf(key);
		if (index >= 0) this.keys.splice(index, 1);
	}

	/** Drops every note no pass since `generation` counted: deleted, renamed away, or filtered out. */
	prune(generation: number): void {
		const stale: string[] = [];
		for (const day of this.days.values()) {
			for (const note of day.notes) if (note.generation < generation) stale.push(note.path);
		}
		for (const path of stale) this.delete(path);
	}

	/** Where `at` falls among all matches, from 0 at the top of the timeline; -1 when it is not one. */
	indexOf(at: FindPosition, step: -1 | 1): number {
		const day = this.days.get(at.key);
		const note = day?.notes.find((candidate) => candidate.path === at.path);
		if (!day || !note || at.index < 0 || at.index >= note.count) return -1;
		let index = 0;
		for (const key of this.keys) {
			const before = step > 0 ? key < at.key : key > at.key;
			if (before) index += this.days.get(key)!.count;
		}
		for (const other of day.notes) {
			if (other === note) break;
			index += other.count;
		}
		return index + at.index;
	}

	/** The day with matches nearest after `key` down the timeline, without wrapping. */
	nextKey(key: string, step: -1 | 1): string | null {
		return step > 0 ? keyAfter(this.keys, key) : keyBefore(this.keys, key);
	}

	/** The day with matches at the top of the timeline. */
	firstKey(step: -1 | 1): string | null {
		return (step > 0 ? this.keys[0] : this.keys[this.keys.length - 1]) ?? null;
	}

	/** The first match of a day, in reading order. */
	first(key: string): FindPosition | null {
		const note = this.days.get(key)?.notes[0];
		return note ? { key, path: note.path, index: 0 } : null;
	}

	/** The last match of a day, in reading order. */
	last(key: string): FindPosition | null {
		const notes = this.days.get(key)?.notes;
		const note = notes?.[notes.length - 1];
		return note ? { key, path: note.path, index: note.count - 1 } : null;
	}

	/** The match after `at` down the timeline, wrapping from the bottom to the top. */
	after(at: FindPosition, step: -1 | 1): FindPosition | null {
		const notes = this.days.get(at.key)?.notes ?? [];
		const index = notes.findIndex((note) => note.path === at.path);
		if (index >= 0) {
			if (at.index + 1 < notes[index].count) return { ...at, index: at.index + 1 };
			if (index + 1 < notes.length) return { key: at.key, path: notes[index + 1].path, index: 0 };
		}
		const key = this.nextKey(at.key, step) ?? this.firstKey(step);
		return key ? this.first(key) : null;
	}

	/** The match before `at` down the timeline, wrapping from the top to the bottom. */
	before(at: FindPosition, step: -1 | 1): FindPosition | null {
		const notes = this.days.get(at.key)?.notes ?? [];
		const index = notes.findIndex((note) => note.path === at.path);
		if (index >= 0) {
			if (at.index > 0) return { ...at, index: Math.min(at.index, notes[index].count) - 1 };
			if (index > 0) return { key: at.key, path: notes[index - 1].path, index: notes[index - 1].count - 1 };
		}
		const back = (-step) as -1 | 1;
		const key = this.nextKey(at.key, back) ?? this.firstKey(back);
		return key ? this.last(key) : null;
	}
}
