import { setTooltip } from "obsidian";
import type { YearProgressSide } from "./settings";
import { createMoment } from "./moment";

/** Pane width beyond the journal column needed before the strip is drawn. */
const MIN_SPARE_WIDTH = 120;
/** Distance between the day cards and the strip's lines. */
const GAP = 40;
/** Each month's click target reaches this far either side of its line. */
const TARGET_PAD = 8;
/** Pixels per line for wheels that scroll by lines rather than pixels. */
const WHEEL_LINE = 16;

/**
 * Twelve month lines beside the journal column that follow the reader like a
 * scrollbar: the month being read is brightest, the other months of its
 * season stand out from the rest of its year, and months that have not come
 * yet are dimmest. Selecting a month moves the journal to it. It only appears
 * when the pane has room beside the column.
 */
export class YearProgress {
	private readonly el: HTMLElement;
	private readonly months: HTMLElement[] = [];
	private readonly observer = new ResizeObserver(() => this.layout());
	private columnEl: HTMLElement | null = null;
	/** The year of the day being read, which a selected month belongs to. */
	private year = 0;
	/** The month the lines were last drawn for. */
	private drawnMonth = "";

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly scrollEl: HTMLElement,
		private side: YearProgressSide,
		onPick: (year: number, month: number) => void,
	) {
		// Hidden until the first layout has a column to place it beside.
		this.el = hostEl.createDiv({ cls: "journal-year-progress is-hidden" });
		for (let month = 0; month < 12; month++) {
			const el = this.el.createDiv({ cls: "journal-year-progress-month" });
			el.addEventListener("click", () => onPick(this.year, month));
			this.months.push(el);
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

	setSide(side: YearProgressSide): void {
		if (side === this.side) return;
		this.side = side;
		this.labelMonths();
		this.layout();
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
		const yearChanged = !this.drawnMonth.startsWith(`${year}-`);
		this.drawnMonth = monthKey;
		// Meteorological seasons begin in March, June, September and December.
		// Winter spans the turn of the year, so December's season goes on into
		// the next year's lines and January's began on the last year's.
		const seasonStart = current - ((current + 1) % 3);
		this.months.forEach((el, month) => {
			el.toggleClass("is-current", month === current);
			if (month === current) el.setAttribute("aria-current", "date");
			else el.removeAttribute("aria-current");
			const inSeason = month >= seasonStart && month < seasonStart + 3;
			el.toggleClass("is-season", inSeason && month !== current && month < firstFuture);
			el.toggleClass("is-future", month !== current && month >= firstFuture);
		});
		if (yearChanged) this.labelMonths();
	}

	/** Names each month, with its tooltip on the side away from the journal. */
	private labelMonths(): void {
		const placement = this.side === "left" ? "left" : "right";
		this.months.forEach((el, month) => {
			setTooltip(el, createMoment(new Date(this.year, month, 1)).format("MMMM YYYY"), { placement });
		});
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
				? columnRect.left + parseFloat(style.paddingLeft) - host.left - GAP + TARGET_PAD
				: columnRect.right - parseFloat(style.paddingRight) - host.left + GAP - TARGET_PAD;
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
