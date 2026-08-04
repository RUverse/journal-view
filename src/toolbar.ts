import { setIcon, setTooltip } from "obsidian";

/**
 * Sets the first icon this Obsidian build actually ships. `setIcon` leaves the
 * element empty for a name its Lucide version does not have, which would show
 * as an invisible button; each name is tried until one draws.
 */
function applyIcon(el: HTMLElement, ...names: string[]): void {
	for (const name of names) {
		setIcon(el, name);
		if (el.querySelector("svg")) return;
		el.empty();
	}
}

/** What the toolbar's controls ask the view to do. */
export interface ToolbarActions {
	onToggleFilter(): void;
	onGoToDate(): void;
	onGoToToday(): void;
}

/**
 * The strip above the journal: where the reader currently is, and the controls
 * that act on the view as a whole. It owns no state of its own - the view tells
 * it what to display.
 */
export class JournalToolbar {
	private labelEl: HTMLElement;
	private filterButton: HTMLElement;

	constructor(parent: HTMLElement, actions: ToolbarActions) {
		const toolbar = parent.createDiv({ cls: "journal-toolbar" });
		this.labelEl = toolbar.createDiv({ cls: "journal-toolbar-label", text: "Journal" });
		const buttons = toolbar.createDiv({ cls: "journal-toolbar-actions" });

		this.filterButton = buttons.createEl("button", { cls: "clickable-icon journal-toolbar-button" });
		this.filterButton.addEventListener("click", () => actions.onToggleFilter());

		const dateButton = buttons.createEl("button", { cls: "clickable-icon journal-toolbar-button" });
		applyIcon(dateButton, "calendar-search", "calendar-days", "calendar");
		setTooltip(dateButton, "Go to date");
		dateButton.addEventListener("click", () => actions.onGoToDate());

		const todayButton = buttons.createEl("button", { cls: "clickable-icon journal-toolbar-button" });
		applyIcon(todayButton, "calendar-plus", "calendar-check");
		setTooltip(todayButton, "Go to today");
		todayButton.addEventListener("click", () => actions.onGoToToday());
	}

	setLabel(text: string): void {
		// This runs every frame while scrolling; only touch the DOM on a change.
		if (this.labelEl.getText() !== text) this.labelEl.setText(text);
	}

	setFilter(on: boolean): void {
		applyIcon(this.filterButton, on ? "filter" : "filter-x", "filter");
		setTooltip(this.filterButton, on ? "Showing only days with notes" : "Showing every day");
		this.filterButton.toggleClass("is-active", on);
		this.filterButton.setAttribute("aria-pressed", String(on));
	}
}
