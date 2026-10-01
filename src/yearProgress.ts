import type { YearProgressSide } from "./settings";
import { createMoment } from "./moment";

/** Pane width beyond the journal column needed before the strip is drawn. */
const MIN_SPARE_WIDTH = 120;
/** Distance between the day cards and the strip. */
const GAP = 40;
/** Rounded away from daylight-saving shifts wherever it divides. */
const DAY_MS = 86_400_000;

/**
 * Twelve month lines beside the journal column showing how far through the
 * year today is. Past months of the current season stand out from the rest
 * of the year so far, and the months still to come are dimmest. It only
 * appears when the pane has room for it beside the column.
 */
export class YearProgress {
	private readonly el: HTMLElement;
	private readonly months: HTMLElement[] = [];
	private readonly observer = new ResizeObserver(() => this.layout());
	private columnEl: HTMLElement | null = null;
	/** The month and year the lines were last drawn for. */
	private drawn = "";

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly scrollEl: HTMLElement,
		private side: YearProgressSide,
	) {
		// Hidden until the first layout has a column to place it beside.
		this.el = hostEl.createDiv({ cls: "journal-year-progress is-hidden", attr: { role: "img" } });
		for (let month = 0; month < 12; month++) {
			this.months.push(this.el.createDiv({ cls: "journal-year-progress-month" }));
		}
		this.observer.observe(scrollEl);
		this.refresh();
	}

	/** Follows the timeline's column, which the view replaces on every rebuild. */
	track(columnEl: HTMLElement): void {
		if (this.columnEl) this.observer.unobserve(this.columnEl);
		this.columnEl = columnEl;
		this.observer.observe(columnEl);
		this.layout();
	}

	setSide(side: YearProgressSide): void {
		if (side === this.side) return;
		this.side = side;
		this.layout();
	}

	/** Redraws the lines when the month has turned since they were drawn. */
	refresh(): void {
		const now = new Date();
		this.updateLabel(now);
		const current = now.getMonth();
		const key = `${now.getFullYear()}-${current}`;
		if (key === this.drawn) return;
		this.drawn = key;
		// Meteorological seasons begin in March, June, September and December;
		// January and February belong to the season that began the year before.
		const seasonStart = current - ((current + 1) % 3);
		this.months.forEach((el, month) => {
			el.toggleClass("is-current", month === current);
			el.toggleClass("is-season", month >= seasonStart && month < current);
			el.toggleClass("is-future", month > current);
		});
	}

	private updateLabel(now: Date): void {
		const year = now.getFullYear();
		const start = new Date(year, 0, 1).getTime();
		const day = Math.round((new Date(year, now.getMonth(), now.getDate()).getTime() - start) / DAY_MS) + 1;
		const days = Math.round((new Date(year + 1, 0, 1).getTime() - start) / DAY_MS);
		const label = `${createMoment(now).format("MMMM YYYY")}, day ${day} of ${days}`;
		if (this.el.getAttribute("aria-label") !== label) this.el.setAttribute("aria-label", label);
	}

	private layout(): void {
		const column = this.columnEl;
		const spare = column?.isConnected ? this.scrollEl.clientWidth - column.offsetWidth : 0;
		const visible = this.side !== "hidden" && !!column && spare >= MIN_SPARE_WIDTH;
		this.el.toggleClass("is-hidden", !visible);
		this.el.toggleClass("is-left", this.side === "left");
		if (!visible || !column) return;

		const host = this.hostEl.getBoundingClientRect();
		const scroll = this.scrollEl.getBoundingClientRect();
		const columnRect = column.getBoundingClientRect();
		const style = getComputedStyle(column);
		const left =
			this.side === "left"
				? columnRect.left + parseFloat(style.paddingLeft) - host.left - GAP
				: columnRect.right - parseFloat(style.paddingRight) - host.left + GAP;
		this.el.setCssProps({
			"--journal-year-progress-top": `${scroll.top - host.top + this.scrollEl.clientHeight / 2}px`,
			"--journal-year-progress-left": `${left}px`,
		});
	}

	destroy(): void {
		this.observer.disconnect();
		this.el.remove();
	}
}
