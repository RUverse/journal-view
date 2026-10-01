import type { YearProgressMode } from "./settings";
import { createMoment } from "./moment";

/** Pane width beyond the journal column needed before the strip is drawn. */
const MIN_SPARE_WIDTH = 120;
/** Distance between the day cards and the strip's lines. */
const GAP = 40;
/** Each month's click target reaches this far either side of its line. */
const TARGET_PAD = 8;
/** Pixels per line for wheels that scroll by lines rather than pixels. */
const WHEEL_LINE = 16;
/** Room kept between the month labels and the edge of the pane. */
const LABEL_MARGIN = 8;
/**
 * Months kept either side of the marked one on the wheel. They have faded out
 * by six away; the rest are there so months turning out of sight, a few at a
 * time while scrolling quickly, leave without popping.
 */
const WHEEL_RADIUS = 9;

/** One month's line and label. */
interface MonthCell {
	el: HTMLElement;
	label: HTMLElement;
}

/**
 * Month lines beside the journal column that follow the reader like a
 * scrollbar: the month being read is brightest and months that have not come
 * yet are dimmest. Selecting a month moves the journal to it. It only appears
 * when the pane has room beside the column.
 *
 * The left and right modes show the twelve months of the year being read,
 * naming a month while it is hovered. The experimental mode instead turns
 * like a wheel picker, holding the marked month in the middle with the months
 * around it, across the turn of a year, named.
 */
export class YearProgress {
	private readonly el: HTMLElement;
	private readonly trackEl: HTMLElement;
	/** Keyed by months since the start of year 0, so they run on across years. */
	private readonly cells = new Map<number, MonthCell>();
	private readonly observer = new ResizeObserver(() => this.layout());
	private columnEl: HTMLElement | null = null;
	/** The day being read, and what its months were last drawn for. */
	private date = new Date();
	private drawn = "";

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly scrollEl: HTMLElement,
		private mode: YearProgressMode,
		private readonly onPick: (year: number, month: number) => void,
	) {
		// Hidden until the first layout has a column to place it beside.
		this.el = hostEl.createDiv({ cls: "journal-year-progress is-hidden" });
		this.trackEl = this.el.createDiv({ cls: "journal-year-progress-track" });
		// The strip sits over the scroller rather than in it, so a wheel turned
		// over it would otherwise go nowhere. Passing the event on first lets
		// the view see the reader taking over scrolling, as it would anywhere.
		this.el.addEventListener(
			"wheel",
			(event) => {
				scrollEl.dispatchEvent(new WheelEvent("wheel", event));
				const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE : 1;
				scrollEl.scrollBy({ top: event.deltaY * scale, left: event.deltaX * scale });
			},
			{ passive: true },
		);
		this.observer.observe(scrollEl);
		this.show(this.date);
	}

	/** Follows the timeline's column, which the view replaces on every rebuild. */
	track(columnEl: HTMLElement): void {
		if (this.columnEl) this.observer.unobserve(this.columnEl);
		this.columnEl = columnEl;
		this.observer.observe(columnEl);
		this.layout();
	}

	setMode(mode: YearProgressMode): void {
		if (mode === this.mode) return;
		const wasWheel = this.wheel;
		this.mode = mode;
		// The two layouts hold different months; start the new one afresh.
		if (this.wheel !== wasWheel) this.clear();
		this.show(this.date);
		this.layout();
	}

	/** Every mode but right keeps the strip on the journal's left. */
	private get onLeft(): boolean {
		return this.mode !== "right";
	}

	private get wheel(): boolean {
		return this.mode === "experimental";
	}

	/** Marks the day being read. Runs every scroll frame, so it only redraws on a change. */
	show(date: Date): void {
		this.date = date;
		const current = date.getFullYear() * 12 + date.getMonth();
		const today = new Date();
		const firstFuture = today.getFullYear() * 12 + today.getMonth() + 1;
		const drawn = `${current}-${firstFuture}-${this.wheel}`;
		if (drawn === this.drawn) return;
		this.drawn = drawn;

		const year = Math.floor(current / 12);
		const first = this.wheel ? current - WHEEL_RADIUS : year * 12;
		const last = this.wheel ? current + WHEEL_RADIUS : year * 12 + 11;
		for (const [key, cell] of this.cells) {
			if (key < first || key > last) {
				cell.el.remove();
				this.cells.delete(key);
			}
		}
		// The wheel places each month itself, so only the year's lines, which
		// stack in order, need to be laid down from the top.
		for (let key = first; key <= last; key++) {
			const cell = this.cells.get(key) ?? this.createCell(key);
			const offset = key - current;
			cell.el.setCssProps({
				"--journal-year-progress-offset": String(offset),
				"--journal-year-progress-distance": String(Math.abs(offset)),
			});
			cell.el.toggleClass("is-current", offset === 0);
			if (offset === 0) cell.el.setAttribute("aria-current", "date");
			else cell.el.removeAttribute("aria-current");
			cell.el.toggleClass("is-future", offset !== 0 && key >= firstFuture);
			// The marked month carries its year, and on the wheel so do the
			// nearest months of the years either side, until one reaches the middle.
			const cellYear = Math.floor(key / 12);
			const nearestOfItsYear =
				(cellYear === year - 1 && key % 12 === 11) || (cellYear === year + 1 && key % 12 === 0);
			cell.el.toggleClass("shows-year", offset === 0 || (this.wheel && nearestOfItsYear));
		}
		// A label of another length may no longer fit beside the strip.
		this.fitLabels();
	}

	private createCell(key: number): MonthCell {
		const year = Math.floor(key / 12);
		const month = key % 12;
		const el = this.trackEl.createDiv({ cls: "journal-year-progress-month" });
		const label = el.createDiv({ cls: "journal-year-progress-label" });
		label.createSpan({ cls: "journal-year-progress-year", text: String(year) });
		label.createSpan({ text: createMoment(new Date(year, month, 1)).format("MMM") });
		el.addEventListener("click", () => this.onPick(year, month));
		const cell = { el, label };
		this.cells.set(key, cell);
		return cell;
	}

	private clear(): void {
		for (const cell of this.cells.values()) cell.el.remove();
		this.cells.clear();
		this.drawn = "";
	}

	private layout(): void {
		const column = this.columnEl;
		const spare = column?.isConnected ? this.scrollEl.clientWidth - column.offsetWidth : 0;
		const visible = this.mode !== "hidden" && !!column && spare >= MIN_SPARE_WIDTH;
		this.el.toggleClass("is-hidden", !visible);
		this.el.toggleClass("is-left", this.onLeft);
		this.el.toggleClass("is-labelled", this.wheel);
		if (!visible || !column) return;

		const host = this.hostEl.getBoundingClientRect();
		const scroll = this.scrollEl.getBoundingClientRect();
		const columnRect = column.getBoundingClientRect();
		const style = getComputedStyle(column);
		const left =
			this.onLeft
				? columnRect.left + parseFloat(style.paddingLeft) - host.left - GAP + TARGET_PAD
				: columnRect.right - parseFloat(style.paddingRight) - host.left + GAP - TARGET_PAD;
		this.el.setCssProps({
			"--journal-year-progress-top": `${scroll.top - host.top + this.scrollEl.clientHeight / 2}px`,
			"--journal-year-progress-left": `${left}px`,
		});
		this.fitLabels();
	}

	/** Leaves only the lines when the marked month's label would not fit in the pane. */
	private fitLabels(): void {
		const date = this.date;
		const current = this.cells.get(date.getFullYear() * 12 + date.getMonth());
		if (!current || this.el.hasClass("is-hidden")) return;
		const scroll = this.scrollEl.getBoundingClientRect();
		const label = current.label.getBoundingClientRect();
		const fits =
			this.onLeft
				? label.left >= scroll.left + LABEL_MARGIN
				: label.right <= scroll.left + this.scrollEl.clientWidth - LABEL_MARGIN;
		this.el.toggleClass("is-unlabelled", !fits);
	}

	destroy(): void {
		this.observer.disconnect();
		this.el.remove();
	}
}
