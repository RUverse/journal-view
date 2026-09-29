import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT } from "./noteIndex";
import type { DaySequence } from "./noteIndex";

/** Hard stop so empty-day scrolling cannot allocate forever (~13 years). */
export const MAX_OFFSET = 5000;

/**
 * Empty calendar days stay inside the hard stop. When they are hidden, an
 * indexed note is safe at any distance because the walker jumps straight to
 * it rather than materialising every date in between.
 */
export function isOffsetReachable(offset: number, hideEmpty: boolean, indexed: boolean): boolean {
	return Number.isFinite(offset) && (Math.abs(offset) <= MAX_OFFSET || (hideEmpty && indexed));
}

/** Sorts before and after every day key. */
const BEFORE_ALL = "";
const AFTER_ALL = "\uffff";

/**
 * The days the journal shows while empty days are hidden: each day with a
 * note that passes the filters and, while files from each day are listed,
 * each day with files but no note. A day whose note the filters leave out
 * stays out whatever files it has, since showing the day would show the note.
 */
export class ShownDays implements DaySequence {
	constructor(
		private notes: DaySequence,
		private matchingNotes: DaySequence,
		/** Days with files, or null while those do not count. */
		private files: () => DaySequence | null,
	) {}

	has(key: string): boolean {
		if (this.matchingNotes.has(key)) return true;
		const files = this.files();
		return !!files && files.has(key) && !this.notes.has(key);
	}

	next(key: string): string | null {
		return this.step(key, 1);
	}

	prev(key: string): string | null {
		return this.step(key, -1);
	}

	range(): { first: string; last: string } | null {
		const first = this.next(BEFORE_ALL);
		const last = this.prev(AFTER_ALL);
		return first !== null && last !== null ? { first, last } : null;
	}

	/** The nearest shown day past `key`: a matching note, or files on a day without one. */
	private step(key: string, direction: -1 | 1): string | null {
		const along = (days: DaySequence, from: string) => (direction > 0 ? days.next(from) : days.prev(from));
		const noted = along(this.matchingNotes, key);
		const files = this.files();
		if (!files) return noted;
		const reached = (day: string) => noted !== null && (direction > 0 ? day >= noted : day <= noted);
		for (let day = along(files, key); day !== null && !reached(day); day = along(files, day)) {
			if (!this.notes.has(day)) return day;
		}
		return noted;
	}
}

/**
 * The journal addresses days by their distance from today, so the day the view
 * was built around is always offset 0 and the arithmetic stays integer. This
 * translates between that offset, the calendar date and the index's day key,
 * and decides which day comes next in either direction - which is where hiding
 * empty days is honoured.
 *
 * A walker is built for one window of days and holds the `today` that window
 * was measured against; a rebuild (midnight, a settings change) makes a new one.
 */
export class DayWalker {
	/**
	 * Today is the only date the filter is not allowed to take away.
	 */
	private readonly pinned = [0];

	constructor(
		readonly today: Moment,
		private notes: DaySequence,
		private shown: ShownDays,
		private hideEmpty: () => boolean,
	) {}

	dateFor(offset: number): Moment {
		return this.today.clone().add(offset, "days");
	}

	keyFor(offset: number): string {
		return this.dateFor(offset).format(DAY_KEY_FORMAT);
	}

	offsetFor(key: string): number {
		return createMoment(key, DAY_KEY_FORMAT).startOf("day").diff(this.today, "days");
	}

	/**
	 * The next day the view should render in `direction`. With empty days
	 * hidden this skips straight to the next shown day - a matching note, or
	 * files - so the view never has to materialise a run of blank days to
	 * cross a gap, except for Today, so a walk that would step over it stops
	 * there instead.
	 */
	next(from: number, direction: -1 | 1): number | null {
		if (this.hideEmpty()) {
			const key = this.keyFor(from);
			const found = direction < 0 ? this.shown.prev(key) : this.shown.next(key);
			const noted = found ? this.offsetFor(found) : null;
			// Whichever comes first: the next shown day, or the next day that
			// is kept regardless.
			const candidates = [noted, this.nextPinned(from, direction)].filter(
				(value): value is number => value !== null,
			);
			if (!candidates.length) return null;
			// Indexed candidates are reachable at any distance; pinned candidates
			// were checked when the walker was built.
			return direction < 0 ? Math.max(...candidates) : Math.min(...candidates);
		}
		let offset = from + direction;
		while (isOffsetReachable(offset, false, false)) {
			if (this.isVisible(offset)) return offset;
			offset += direction;
		}
		return null;
	}

	/** Whether this date belongs in the filtered journal. Today is unconditional. */
	isVisible(offset: number): boolean {
		if (this.isPinned(offset)) return true;
		const key = this.keyFor(offset);
		return this.shown.has(key) || (!this.notes.has(key) && !this.hideEmpty());
	}

	/** True for a day that is shown whether or not it has a note. */
	isPinned(offset: number): boolean {
		return this.pinned.includes(offset);
	}

	/** The nearest pinned day strictly in `direction` from `from`. */
	private nextPinned(from: number, direction: -1 | 1): number | null {
		let best: number | null = null;
		for (const offset of this.pinned) {
			if (direction < 0 ? offset >= from : offset <= from) continue;
			if (best === null || (direction < 0 ? offset > best : offset < best)) best = offset;
		}
		return best;
	}

	/**
	 * The offset a window should be built around. Filters can take away the day
	 * the reader was looking at, so a non-surviving anchor moves to the nearest
	 * visible date instead.
	 */
	origin(around?: Moment): number {
		if (!around) return 0;
		const offset = around.clone().startOf("day").diff(this.today, "days");
		if (!this.isReachable(offset)) return 0;
		if (this.isVisible(offset)) return offset;

		const before = this.next(offset, -1);
		const after = this.next(offset, 1);
		if (before === null) return after ?? 0;
		if (after === null) return before;
		return offset - before <= after - offset ? before : after;
	}

	private isReachable(offset: number): boolean {
		return isOffsetReachable(offset, this.hideEmpty(), this.shown.has(this.keyFor(offset)));
	}
}
