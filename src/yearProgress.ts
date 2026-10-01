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
 * Twelve month lines beside the journal column that follow the reader like a
 * scrollbar: the month being read is brightest and months that have not come
 * yet are dimmest. The experimental mode also names every month, and the
 * marked one's year, and turns like a wheel picker to hold the marked month
 * in the middle. Selecting a month moves the journal to it. It only appears
 * when the pane has room beside the column.
 */
export class YearProgress {
	private readonly el: HTMLElement;
	/** Carries the months, and slides to centre the marked one in the experimental mode. */
	private readonly trackEl: HTMLElement;
	private readonly months: HTMLElement[] = [];
	private readonly labels: HTMLElement[] = [];
	private readonly years: HTMLElement[] = [];
	private readonly observer = new ResizeObserver(() => this.layout());
	private columnEl: HTMLElement | null = null;
	/** The year of the day being read, which a selected month belongs to. */
	private year = 0;
	/** The month the lines were last drawn for. */
	private drawnMonth = "";

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly scrollEl: HTMLElement,
		private mode: YearProgressMode,
		onPick: (year: number, month: number) => void,
	) {
		// Hidden until the first layout has a column to place it beside.
		this.el = hostEl.createDiv({ cls: "journal-year-progress is-hidden" });
		this.trackEl = this.el.createDiv({ cls: "journal-year-progress-track" });
		for (let month = 0; month < 12; month++) {
			const el = this.trackEl.createDiv({ cls: "journal-year-progress-month" });
			const label = el.createDiv({ cls: "journal-year-progress-label" });
			this.years.push(label.createSpan({ cls: "journal-year-progress-year" }));
			label.createSpan({ text: createMoment(new Date(2000, month, 1)).format("MMM") });
			el.addEventListener("click", () => onPick(this.year, month));
			this.months.push(el);
			this.labels.push(label);
		}
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
		this.show(new Date());
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
		this.mode = mode;
		this.layout();
	}

	/** Every mode but right keeps the strip on the journal's left. */
	private get onLeft(): boolean {
		return this.mode !== "right";
	}

	private get labelled(): boolean {
		return this.mode === "experimental";
	}

	/** Marks the day being read. Runs every scroll frame, so it only redraws on a change. */
	show(date: Date): void {
		const year = (this.year = date.getFullYear());
		const current = date.getMonth();
		// The first month of the marked year that is still to come: none of a
		// past year's, those after today's month in this year, all of a later year's.
		const today = new Date();
		const thisYear = today.getFullYear();
		const firstFuture = year < thisYear ? 12 : year > thisYear ? 0 : today.getMonth() + 1;
		const monthKey = `${year}-${current}-${firstFuture}`;
		if (monthKey === this.drawnMonth) return;
		this.drawnMonth = monthKey;
		this.trackEl.setCssProps({ "--journal-year-progress-index": String(current) });
		this.months.forEach((el, month) => {
			el.setCssProps({ "--journal-year-progress-distance": String(Math.abs(month - current)) });
			el.toggleClass("is-current", month === current);
			if (month === current) el.setAttribute("aria-current", "date");
			else el.removeAttribute("aria-current");
			el.toggleClass("is-future", month !== current && month >= firstFuture);
		});
		for (const el of this.years) el.setText(String(year));
		// A label of another length may no longer fit beside the strip.
		this.fitLabels();
	}

	private layout(): void {
		const column = this.columnEl;
		const spare = column?.isConnected ? this.scrollEl.clientWidth - column.offsetWidth : 0;
		const visible = this.mode !== "hidden" && !!column && spare >= MIN_SPARE_WIDTH;
		this.el.toggleClass("is-hidden", !visible);
		this.el.toggleClass("is-left", this.onLeft);
		this.el.toggleClass("is-labelled", this.labelled);
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
		const current = this.months.findIndex((el) => el.hasClass("is-current"));
		if (!this.labelled || current < 0 || this.el.hasClass("is-hidden")) return;
		const scroll = this.scrollEl.getBoundingClientRect();
		const label = this.labels[current].getBoundingClientRect();
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
