import { ItemView, Platform, setIcon, setTooltip } from "obsidian";

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
	onShowFilter(): void;
	onShowAppearance(): void;
	onShowFind(): void;
	onGoToDate(): void;
	onGoToToday(): void;
}

/**
 * The journal's header: native and compact on desktop, or the original second
 * row on mobile. It owns no state of its own - the view tells it what to
 * display.
 */
export class JournalToolbar {
	private toolbarEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private buttons: HTMLElement[] = [];
	private filterButton: HTMLElement;
	private readonly mobile = Platform.isMobile;

	constructor(private view: ItemView, actions: ToolbarActions) {
		if (this.mobile) {
			view.containerEl.addClass("journal-view-mobile");
			const toolbar = (this.toolbarEl = view.contentEl.createDiv({ cls: "journal-toolbar" }));
			this.labelEl = toolbar.createDiv({ cls: "journal-toolbar-label", text: "Journal" });
			const buttons = toolbar.createDiv({ cls: "journal-toolbar-actions" });

			const appearanceButton = buttons.createEl("button", {
				cls: "clickable-icon journal-toolbar-button",
				attr: { "aria-haspopup": "dialog" },
			});
			applyIcon(appearanceButton, "settings-2", "settings");
			setTooltip(appearanceButton, "Customization");
			appearanceButton.addEventListener("click", () => actions.onShowAppearance());
			this.buttons.push(appearanceButton);

			this.filterButton = buttons.createEl("button", {
				cls: "clickable-icon journal-toolbar-button journal-filter-button",
				attr: { "aria-haspopup": "dialog" },
			});
			applyIcon(this.filterButton, "filter");
			this.filterButton.addEventListener("click", () => actions.onShowFilter());
			this.buttons.push(this.filterButton);

			const findButton = buttons.createEl("button", {
				cls: "clickable-icon journal-toolbar-button",
			});
			applyIcon(findButton, "search");
			setTooltip(findButton, "Find in journal");
			findButton.addEventListener("click", () => actions.onShowFind());
			this.buttons.push(findButton);

			const dateButton = buttons.createEl("button", {
				cls: "clickable-icon journal-toolbar-button",
			});
			applyIcon(dateButton, "calendar-search", "calendar-days", "calendar");
			setTooltip(dateButton, "Go to date");
			dateButton.addEventListener("click", () => actions.onGoToDate());
			this.buttons.push(dateButton);

			const todayButton = buttons.createEl("button", {
				cls: "clickable-icon journal-toolbar-button journal-toolbar-labeled-button",
			});
			applyIcon(todayButton, "calendar-plus", "calendar-check");
			todayButton.createSpan({ text: "Today" });
			setTooltip(todayButton, "Go to today");
			todayButton.addEventListener("click", () => actions.onGoToToday());
			this.buttons.push(todayButton);
			return;
		}

		// ItemView inserts each native action before the existing ones, so build
		// these right-to-left to retain the toolbar's visual order beside More.
		const todayButton = view.addAction("calendar-check", "Go to today", () => actions.onGoToToday());
		todayButton.addClass("journal-toolbar-button");
		applyIcon(todayButton, "calendar-plus", "calendar-check");
		setTooltip(todayButton, "Go to today");
		this.buttons.push(todayButton);

		const dateButton = view.addAction("calendar", "Go to date", () => actions.onGoToDate());
		dateButton.addClass("journal-toolbar-button");
		applyIcon(dateButton, "calendar-search", "calendar-days", "calendar");
		setTooltip(dateButton, "Go to date");
		this.buttons.push(dateButton);

		const findButton = view.addAction("search", "Find in journal", () => actions.onShowFind());
		findButton.addClass("journal-toolbar-button");
		applyIcon(findButton, "search");
		setTooltip(findButton, "Find in journal");
		this.buttons.push(findButton);

		this.filterButton = view.addAction("filter", "Filter notes", () => actions.onShowFilter());
		this.filterButton.addClasses(["journal-toolbar-button", "journal-filter-button"]);
		applyIcon(this.filterButton, "filter");
		this.filterButton.setAttribute("aria-haspopup", "dialog");
		const appearanceButton = view.addAction("settings-2", "Customization", () => actions.onShowAppearance());
		appearanceButton.addClass("journal-toolbar-button");
		applyIcon(appearanceButton, "settings-2", "settings");
		setTooltip(appearanceButton, "Customization");
		appearanceButton.setAttribute("aria-haspopup", "dialog");
		// Filter describes what the journal shows, so keep it with the navigation
		// controls rather than the date destinations on the right. Appearance is
		// the adjacent description of what each shown day contains.
		const left = view.containerEl.querySelector(".view-header-left");
		left?.append(appearanceButton, this.filterButton);
		this.buttons.push(appearanceButton, this.filterButton);
	}

	setLabel(text: string): void {
		this.labelEl ??= this.view.containerEl.querySelector<HTMLElement>(".view-header-title");
		if (!this.labelEl) return;
		// This runs every frame while scrolling; only touch the DOM on a change.
		if (this.labelEl.getText() !== text) this.labelEl.setText(text);
	}

	setFilter(active: boolean): void {
		applyIcon(this.filterButton, "filter");
		setTooltip(this.filterButton, active ? "Filter notes (filters active)" : "Filter notes");
		this.filterButton.toggleClass("is-active", active);
		this.filterButton.removeAttribute("aria-pressed");
	}

	setVisible(visible: boolean): void {
		// On mobile the find bar replaces the plugin-owned second row. Desktop
		// actions live in Obsidian's persistent header and should not jump around.
		this.toolbarEl?.toggleClass("is-hidden", !visible);
	}

	destroy(): void {
		for (const button of this.buttons) button.remove();
		this.buttons = [];
		this.toolbarEl?.remove();
		this.toolbarEl = null;
		this.view.containerEl.removeClass("journal-view-mobile");
		if (!this.mobile && this.labelEl?.isConnected) this.labelEl.setText(this.view.getDisplayText());
		this.labelEl = null;
	}
}
