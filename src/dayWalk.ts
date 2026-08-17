import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT } from "./noteIndex";
import type { OrderedDayIndex } from "./noteIndex";

/** Hard stop so empty-day scrolling cannot allocate forever (~13 years). */
export const MAX_OFFSET = 5000;

/**
 * Empty calendar days stay inside the hard stop. An indexed note is safe at
 * any distance when used as a rebuild origin because the view starts directly
 * on it rather than materialising every date in between.
 */
export function isOffsetReachable(offset: number, indexed: boolean): boolean {
	return Number.isFinite(offset) && (Math.abs(offset) <= MAX_OFFSET || indexed);
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
		private notes: OrderedDayIndex,
		private matchingNotes: OrderedDayIndex,
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
	 * hidden this skips straight to the next matching note, so
	 * the view never has to materialise a run of blank days to cross a gap -
	 * except for Today, so a walk that would step over it stops there instead.
	 */
	next(from: number, direction: -1 | 1): number | null {
		if (this.hideEmpty()) {
			const key = this.keyFor(from);
			const found = direction < 0 ? this.matchingNotes.prev(key) : this.matchingNotes.next(key);
			const noted = found ? this.offsetFor(found) : null;
			// Whichever comes first: the next day with a note, or the next day
			// that is kept regardless.
			const candidates = [noted, this.nextPinned(from, direction)].filter(
				(value): value is number => value !== null,
			);
			if (!candidates.length) return null;
			// Indexed candidates are reachable at any distance; pinned candidates
			// were checked when the walker was built.
			return direction < 0 ? Math.max(...candidates) : Math.min(...candidates);
		}
		let offset = from + direction;
		while (isOffsetReachable(offset, false)) {
			if (this.isVisible(offset)) return offset;
			offset += direction;
		}
		return null;
	}

	/** Whether this date belongs in the filtered journal. Today is unconditional. */
	isVisible(offset: number): boolean {
		if (this.isPinned(offset)) return true;
		const key = this.keyFor(offset);
		return this.notes.has(key) ? this.matchingNotes.has(key) : !this.hideEmpty();
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
		return isOffsetReachable(offset, this.matchingNotes.has(this.keyFor(offset)));
	}
}
