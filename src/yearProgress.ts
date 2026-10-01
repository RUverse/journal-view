import type { YearProgressSide } from "./settings";
import { createMoment } from "./moment";

/** Pane width beyond the journal column needed before the strip is drawn. */
const MIN_SPARE_WIDTH = 120;
/** Distance between the day cards and the strip. */
const GAP = 40;
/** Rounded away from daylight-saving shifts wherever it divides. */
const DAY_MS = 86_400_000;

/**
 * Twelve month lines beside the journal column that follow the reader like a
 * scrollbar: the month being read is brightest, the earlier months of its
 * season stand out from the rest of the year before it, and the months after
 * it are dimmest. It only appears when the pane has room beside the column.
 */
export class YearProgress {
	private readonly el: HTMLElement;
	private readonly months: HTMLElement[] = [];
	private readonly observer = new ResizeObserver(() => this.layout());
	private columnEl: HTMLElement | null = null;
	/** The day the strip last marked, and the month its lines were drawn for. */
	private shownDay = "";
	private drawnMonth = "";

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
		this.show(new Date());
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

	/** Marks the day being read. Runs every scroll frame, so it only redraws on a change. */
	show(date: Date): void {
		const current = date.getMonth();
		const monthKey = `${date.getFullYear()}-${current}`;
		const day = `${monthKey}-${date.getDate()}`;
		if (day === this.shownDay) return;
		this.shownDay = day;
		this.el.setAttribute("aria-label", this.describe(date));
		if (monthKey === this.drawnMonth) return;
		this.drawnMonth = monthKey;
		// Meteorological seasons begin in March, June, September and December;
		// January and February belong to the season that began the year before.
		const seasonStart = current - ((current + 1) % 3);
		this.months.forEach((el, month) => {
			el.toggleClass("is-current", month === current);
			el.toggleClass("is-season", month >= seasonStart && month < current);
			el.toggleClass("is-after", month > current);
		});
	}

	private describe(date: Date): string {
		const year = date.getFullYear();
		const start = new Date(year, 0, 1).getTime();
		const day = Math.round((new Date(year, date.getMonth(), date.getDate()).getTime() - start) / DAY_MS) + 1;
		const days = Math.round((new Date(year + 1, 0, 1).getTime() - start) / DAY_MS);
		return `${createMoment(date).format("MMMM YYYY")}, day ${day} of ${days}`;
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
