import { App, Modal, moment } from "obsidian";
import { MAX_OFFSET } from "./dayWalk";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT } from "./noteIndex";
import type { OrderedDayIndex } from "./noteIndex";

/** Months built either side of the current one when the picker opens. */
const INITIAL_MONTHS = 6;
/** How close to an end (px) the reader must get before more months are built. */
const LOAD_THRESHOLD = 400;
/** A generous cap per scroll event, in case the loop cannot converge. */
const MAX_PER_PASS = 24;
/** Months kept alive while crossing a large gap between distant notes. */
const MAX_MONTHS = 36;

export interface DatePickerOptions {
	/** Which days have a note, for the dots under the numbers. */
	index: OrderedDayIndex;
	/** Today, as the view measures it. */
	today: Moment;
	/** The day the journal is currently showing, if it has one. */
	current?: Moment;
	/** Indexed notes beyond the empty-day safety range can be opened. */
	allowDistantNotes: boolean;
	/** The timeline's complete visibility rule, including empty days and Today. */
	isVisible(date: Moment): boolean;
	onPick(date: Moment): void;
	/** Called whenever the picker goes away, however it was dismissed. */
	onDismiss?(): void;
}

/**
 * A calendar column where each row is a week and a day with a note carries a dot
 * under its number. Months are consecutive inside the ordinary empty-day range;
 * beyond it, the column jumps between months with indexed notes just as the
 * filtered journal jumps between noted days.
 *
 * Months are built as the reader approaches either end. Building above them
 * moves the scroll position down by exactly the height that appeared, in the
 * same task, so nothing on screen moves.
 */
export class DatePickerModal extends Modal {
	private scrollEl!: HTMLElement;
	private listEl!: HTMLElement;

	/** First and last month currently built, as their first day. */
	private first!: Moment;
	private last!: Moment;
	/** The range the journal itself can reach, as month starts. */
	private earliest: Moment;
	private latest: Moment;
	/** Ordinary empty days are only offered inside these bounds. */
	private standardMinKey: string;
	private standardMaxKey: string;

	private todayKey: string;
	private currentKey: string | null;
	private currentEl: HTMLElement | null = null;
	/** The month the picker opened on, which is the one it centres. */
	private centreEl: HTMLElement | null = null;
	/** The day inside that month the reader arrived on. */
	private anchorEl: HTMLElement | null = null;
	private frame = 0;
	private focusFrame = 0;

	constructor(
		app: App,
		private options: DatePickerOptions,
	) {
		super(app);
		const { today, current } = options;
		this.todayKey = today.format(DAY_KEY_FORMAT);
		this.currentKey = current ? current.clone().startOf("day").format(DAY_KEY_FORMAT) : null;

		const min = today.clone().subtract(MAX_OFFSET, "days");
		const max = today.clone().add(MAX_OFFSET, "days");
		this.standardMinKey = min.format(DAY_KEY_FORMAT);
		this.standardMaxKey = max.format(DAY_KEY_FORMAT);
		this.earliest = min.clone().startOf("month");
		this.latest = max.clone().startOf("month");

		const range = options.allowDistantNotes ? options.index.range() : null;
		if (range) {
			if (range.first < this.standardMinKey) {
				this.earliest = createMoment(range.first, DAY_KEY_FORMAT, true).startOf("month");
			}
			if (range.last > this.standardMaxKey) {
				this.latest = createMoment(range.last, DAY_KEY_FORMAT, true).startOf("month");
			}
		}
	}

	onOpen(): void {
		this.modalEl.addClass("journal-picker-modal");
		this.titleEl.setText("Go to date");

		const weekdays = this.contentEl.createDiv({ cls: "journal-picker-weekdays" });
		// `true` sorts the labels by the locale's own first day of the week, which
		// is the same order the grids below are built in.
		for (const label of moment.weekdaysMin(true)) weekdays.createSpan({ text: label });

		this.scrollEl = this.contentEl.createDiv({ cls: "journal-picker-scroll" });
		this.listEl = this.scrollEl.createDiv({ cls: "journal-picker-months" });

		const centre = (this.options.current ?? this.options.today).clone().startOf("month");
		this.first = this.last = this.clampMonth(centre);
		this.centreEl = this.buildMonth(this.first);
		this.listEl.appendChild(this.centreEl);
		for (let i = 0; i < INITIAL_MONTHS; i++) {
			this.growEarlier();
			this.growLater();
		}

		this.scrollEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
		// The day the journal is on, or today when it is not on one - either way
		// the day the picker opened around, which is where the keyboard starts.
		this.anchorEl = this.currentEl ?? this.centreEl.querySelector(".is-today");
		this.centreOnCurrent();
		// Obsidian gives a modal's first focusable child the focus once it is
		// open, which here is a day months above the one the picker opened on.
		// Claim it back afterwards, without scrolling that day into view - the
		// picker has already decided where it wants to be.
		this.focusFrame = window.requestAnimationFrame(() => {
			this.focusFrame = 0;
			this.anchorEl?.focus({ preventScroll: true });
		});
	}

	onClose(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		if (this.focusFrame) window.cancelAnimationFrame(this.focusFrame);
		this.frame = this.focusFrame = 0;
		this.contentEl.empty();
		this.options.onDismiss?.();
	}

	/* --------------------------------------------------------------- months */

	private clampMonth(month: Moment): Moment {
		if (month.isBefore(this.earliest)) return this.earliest.clone();
		if (month.isAfter(this.latest)) return this.latest.clone();
		return month;
	}

	/**
	 * Puts the month the picker opened on in the middle of the viewport, so the
	 * months before it are visible above and it is obvious there is more to
	 * scroll to. A modal can normally be measured as soon as it is open; one
	 * that is still laying out gets another frame rather than a wrong answer.
	 */
	private centreOnCurrent(): void {
		const month = this.centreEl;
		if (!month) return;
		const view = this.scrollEl.clientHeight;
		if (view === 0) {
			this.frame = window.requestAnimationFrame(() => {
				this.frame = 0;
				if (this.scrollEl.isConnected) this.centreOnCurrent();
			});
			return;
		}
		// A month taller than the scroller - a short window, or a phone - cannot
		// be centred as a whole without leaving the day the picker opened on
		// below the fold, keyboard focus and all. Centre that day instead.
		const target = month.offsetHeight > view && this.anchorEl ? this.anchorEl : month;
		this.scrollEl.scrollTop = Math.max(0, target.offsetTop - Math.max(0, (view - target.offsetHeight) / 2));
	}

	private onScroll(): void {
		for (let i = 0; i < MAX_PER_PASS && this.scrollEl.scrollTop < LOAD_THRESHOLD; i++) {
			if (!this.growEarlier()) break;
		}
		for (let i = 0; i < MAX_PER_PASS && this.nearEnd(); i++) {
			if (!this.growLater()) break;
		}
	}

	private nearEnd(): boolean {
		const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
		return scrollHeight - scrollTop - clientHeight < LOAD_THRESHOLD;
	}

	/**
	 * Builds one more month above the ones already there. The month appears
	 * above the reader, so the scroll position moves down by exactly the height
	 * that appeared - within this task, before the browser can paint it.
	 */
	private growEarlier(): boolean {
		if (!this.first.isAfter(this.earliest)) return false;
		const month = this.monthBefore();
		if (!month || !month.isBefore(this.first)) return false;
		const ref = this.listEl.firstElementChild as HTMLElement | null;
		const before = ref?.offsetTop ?? 0;
		this.listEl.insertBefore(this.buildMonth(month), ref);
		this.first = month;
		if (ref) {
			const delta = ref.offsetTop - before;
			if (delta !== 0) this.scrollEl.scrollTop += delta;
		}
		this.trimMonths("later");
		return true;
	}

	private growLater(): boolean {
		if (!this.last.isBefore(this.latest)) return false;
		const month = this.monthAfter();
		if (!month || !month.isAfter(this.last)) return false;
		this.listEl.appendChild(this.buildMonth(month));
		this.last = month;
		this.trimMonths("earlier");
		return true;
	}

	/** Previous month, skipping an out-of-range gap to the next indexed month. */
	private monthBefore(): Moment | null {
		const adjacent = this.first.clone().subtract(1, "month");
		if (!this.options.allowDistantNotes || this.isStandardMonth(adjacent)) return adjacent;
		const key = this.options.index.prev(this.first.format(DAY_KEY_FORMAT));
		return key ? createMoment(key, DAY_KEY_FORMAT, true).startOf("month") : null;
	}

	/** Next month, skipping an out-of-range gap to the next indexed month. */
	private monthAfter(): Moment | null {
		const adjacent = this.last.clone().add(1, "month");
		if (!this.options.allowDistantNotes || this.isStandardMonth(adjacent)) return adjacent;
		const endKey = this.last.clone().date(this.last.daysInMonth()).format(DAY_KEY_FORMAT);
		const key = this.options.index.next(endKey);
		return key ? createMoment(key, DAY_KEY_FORMAT, true).startOf("month") : null;
	}

	private isStandardMonth(month: Moment): boolean {
		const first = month.format(DAY_KEY_FORMAT);
		const last = month.clone().date(month.daysInMonth()).format(DAY_KEY_FORMAT);
		return last >= this.standardMinKey && first <= this.standardMaxKey;
	}

	/** Keeps long-distance calendar navigation bounded, just like the journal. */
	private trimMonths(end: "earlier" | "later"): void {
		if (this.listEl.childElementCount <= MAX_MONTHS) return;
		if (end === "later") {
			const victim = this.listEl.lastElementChild;
			if (!victim) return;
			this.removeMonth(victim);
			const last = this.listEl.lastElementChild;
			if (last) this.last = this.monthFor(last);
			return;
		}

		const victim = this.listEl.firstElementChild;
		const ref = victim?.nextElementSibling as HTMLElement | null;
		if (!victim || !ref) return;
		const before = ref.offsetTop;
		this.removeMonth(victim);
		this.first = this.monthFor(ref);
		const delta = ref.offsetTop - before;
		if (delta !== 0) this.scrollEl.scrollTop += delta;
	}

	private monthFor(el: Element): Moment {
		return createMoment((el as HTMLElement).dataset.month, DAY_KEY_FORMAT, true).startOf("month");
	}

	/** Removes stale element references along with a trimmed month. */
	private removeMonth(el: Element): void {
		if (this.currentEl && el.contains(this.currentEl)) this.currentEl = null;
		if (this.anchorEl && el.contains(this.anchorEl)) this.anchorEl = null;
		if (this.centreEl && el.contains(this.centreEl)) this.centreEl = null;
		el.remove();
	}

	/**
	 * One month as a seven-column grid. The days before the first of the month
	 * are left blank rather than filled with the previous month's tail: every
	 * date in the column belongs to exactly one month, so a dot is never
	 * ambiguous about which day it marks.
	 */
	private buildMonth(month: Moment): HTMLElement {
		const el = createDiv({
			cls: "journal-picker-month",
			attr: { "data-month": month.format(DAY_KEY_FORMAT) },
		});
		const heading = el.createDiv({ cls: "journal-picker-month-label" });
		heading.createSpan({ cls: "journal-picker-month-name", text: month.format("MMMM") });
		heading.createSpan({ cls: "journal-picker-month-year", text: month.format("YYYY") });

		const grid = el.createDiv({ cls: "journal-picker-grid" });
		const days = month.daysInMonth();
		// Where the first of the month sits in the week, in the locale's order.
		const lead = month.clone().diff(month.clone().startOf("week"), "days");
		for (let i = 0; i < lead; i++) grid.createDiv({ cls: "journal-picker-blank" });

		const date = month.clone();
		for (let day = 1; day <= days; day++) {
			date.date(day);
			grid.appendChild(this.buildDay(date));
		}
		return el;
	}

	private buildDay(date: Moment): HTMLElement {
		const key = date.format(DAY_KEY_FORMAT);
		const cell = createEl("button", {
			cls: "journal-picker-day",
			text: String(date.date()),
			attr: { type: "button", "data-date": key, "aria-label": date.format("dddd, D MMMM YYYY") },
		});

		const visible = this.options.isVisible(date);
		if (this.options.index.has(key)) cell.addClass("has-note");
		if (key === this.todayKey) {
			cell.addClass("is-today");
			cell.setAttribute("aria-current", "date");
		}
		if (key === this.currentKey) {
			cell.addClass("is-current");
			this.currentEl = cell;
		}
		const inStandardRange = key >= this.standardMinKey && key <= this.standardMaxKey;
		const isDistantNote = this.options.allowDistantNotes && this.options.index.has(key);
		if ((!inStandardRange && !isDistantNote) || !visible) {
			cell.addClass("is-out-of-range");
			cell.disabled = true;
			return cell;
		}

		const picked = date.clone();
		cell.addEventListener("click", () => {
			this.close();
			this.options.onPick(picked);
		});
		return cell;
	}
}
