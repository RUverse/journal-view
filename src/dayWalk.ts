import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT, DailyNoteIndex } from "./noteIndex";

/** Hard stop so a runaway scroll cannot allocate forever (~13 years). */
export const MAX_OFFSET = 5000;

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
	 * Days the filter is not allowed to take away, as offsets: today, and the
	 * day the view was last sent to. Sorted, so a walk can ask which comes next.
	 */
	private readonly pinned: number[];

	constructor(
		readonly today: Moment,
		private index: DailyNoteIndex,
		private hideEmpty: () => boolean,
		pinned?: Moment,
	) {
		const offset = pinned ? pinned.clone().startOf("day").diff(today, "days") : 0;
		const kept = Math.abs(offset) <= MAX_OFFSET ? [0, offset] : [0];
		this.pinned = Array.from(new Set(kept)).sort((a, b) => a - b);
	}

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
	 * hidden this skips straight to the next day that actually has a note, so
	 * the view never has to materialise a run of blank days to cross a gap -
	 * except for a pinned day, which belongs in the journal whether it has a
	 * note or not, so a walk that would step over one stops there instead.
	 */
	next(from: number, direction: -1 | 1): number | null {
		let offset: number;
		if (this.hideEmpty()) {
			const key = this.keyFor(from);
			const found = direction < 0 ? this.index.prev(key) : this.index.next(key);
			const noted = found ? this.offsetFor(found) : null;
			// Whichever comes first: the next day with a note, or the next day
			// that is kept regardless.
			const candidates = [noted, this.nextPinned(from, direction)].filter(
				(value): value is number => value !== null,
			);
			if (!candidates.length) return null;
			offset = direction < 0 ? Math.max(...candidates) : Math.min(...candidates);
		} else {
			offset = from + direction;
		}
		return Math.abs(offset) > MAX_OFFSET ? null : offset;
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
	 * The offset a window should be built around. Hiding empty days can take
	 * away the very day the reader was looking at, so an anchor that will not
	 * survive is moved to whichever surviving day is closest to it - unless it
	 * is pinned, which is how a day the reader asked for by date is kept.
	 */
	origin(around?: Moment): number {
		if (!around) return 0;
		const offset = around.clone().startOf("day").diff(this.today, "days");
		if (Math.abs(offset) > MAX_OFFSET) return 0;
		if (!this.hideEmpty()) return offset;
		if (this.isPinned(offset) || this.index.has(this.keyFor(offset))) return offset;

		const before = this.next(offset, -1);
		const after = this.next(offset, 1);
		if (before === null) return after ?? 0;
		if (after === null) return before;
		return offset - before <= after - offset ? before : after;
	}
}
