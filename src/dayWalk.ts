import { moment } from "obsidian";
import type { Moment } from "moment";
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
	constructor(
		readonly today: Moment,
		private index: DailyNoteIndex,
		private hideEmpty: () => boolean,
	) {}

	dateFor(offset: number): Moment {
		return this.today.clone().add(offset, "days");
	}

	keyFor(offset: number): string {
		return this.dateFor(offset).format(DAY_KEY_FORMAT);
	}

	offsetFor(key: string): number {
		return moment(key, DAY_KEY_FORMAT).startOf("day").diff(this.today, "days");
	}

	/**
	 * The next day the view should render in `direction`. With empty days
	 * hidden this skips straight to the next day that actually has a note, so
	 * the view never has to materialise a run of blank days to cross a gap -
	 * except for today, which belongs in the journal whether it has a note or
	 * not, so a walk that would step over it stops there instead.
	 */
	next(from: number, direction: -1 | 1): number | null {
		let offset: number;
		if (this.hideEmpty()) {
			const key = this.keyFor(from);
			const found = direction < 0 ? this.index.prev(key) : this.index.next(key);
			const next = found ? this.offsetFor(found) : null;
			const skipsToday =
				direction < 0 ? from > 0 && (next === null || next < 0) : from < 0 && (next === null || next > 0);
			if (skipsToday) offset = 0;
			else if (next === null) return null;
			else offset = next;
		} else {
			offset = from + direction;
		}
		return Math.abs(offset) > MAX_OFFSET ? null : offset;
	}

	/**
	 * The offset a window should be built around. Hiding empty days can take
	 * away the very day the reader was looking at, so an anchor that will not
	 * survive is moved to whichever surviving day is closest to it.
	 */
	origin(around?: Moment): number {
		if (!around) return 0;
		const offset = around.clone().startOf("day").diff(this.today, "days");
		if (Math.abs(offset) > MAX_OFFSET) return 0;
		if (!this.hideEmpty()) return offset;
		if (offset === 0 || this.index.has(this.keyFor(offset))) return offset;

		const before = this.next(offset, -1);
		const after = this.next(offset, 1);
		if (before === null) return after ?? 0;
		if (after === null) return before;
		return offset - before <= after - offset ? before : after;
	}
}
