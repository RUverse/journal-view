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

/**
 * The day to go to for a month (0-based): its first shown day, or, in a month
 * with none, its first visible day while empty days are shown and otherwise
 * the shown day nearest it. Today counts as shown, which it always is.
 */
export function monthTarget(
	shown: DaySequence,
	year: number,
	month: number,
	todayKey: string,
	hideEmpty: boolean,
	isVisible: (key: string) => boolean,
): string | null {
	const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const keyOf = (day: number) => new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
	const firstKey = keyOf(1);
	const lastKey = keyOf(days);
	const candidates = [shown.next(keyOf(0)), shown.prev(firstKey), todayKey].filter(
		(key): key is string => key !== null,
	);
	const within = candidates.filter((key) => key >= firstKey && key <= lastKey).sort()[0];
	if (within) return within;
	if (!hideEmpty) {
		for (let day = 1; day <= days; day++) if (isVisible(keyOf(day))) return keyOf(day);
	}
	// Days either side of the month, counted from its nearer end.
	const time = (key: string) => Date.parse(key) / 86_400_000;
	const away = (key: string) => (key < firstKey ? time(firstKey) - time(key) : time(key) - time(lastKey));
	return candidates.sort((a, b) => away(a) - away(b))[0] ?? null;
}

/** Sorts before and after every day key. */
const BEFORE_ALL = "";
const AFTER_ALL = "\uffff";

/**
 * Indexed days available for navigation: matching notes, plus file-only days
 * when both empty days and file history are enabled. A day whose note the
 * filters leave out stays out whatever files it has, since showing the day
 * would show the note.
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
	 * hidden this skips straight to the next matching note, so the view never
	 * has to materialise a run of blank days to cross a gap, except for Today,
	 * so a walk that would step over it stops
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
