import { App, TFile, getFrontMatterInfo, setIcon, setTooltip } from "obsidian";
import type JournalViewPlugin from "./main";
import type { DaySection } from "./day";
import type { NoteEntry } from "./entry";
import { isOffsetReachable } from "./dayWalk";
import { findLiteralRanges } from "./findText";
import type { FindRange } from "./findText";
import { createMoment } from "./moment";
import type { Moment } from "./moment";

const REMOTE_YIELD_EVERY = 12;

/** Uses the first icon available in the reader's Obsidian/Lucide build. */
function applyIcon(el: HTMLElement, ...names: string[]): void {
	for (const name of names) {
		setIcon(el, name);
		if (el.querySelector("svg")) return;
		el.empty();
	}
}

interface FindMatch extends FindRange {
	section: DaySection;
	sectionIndex: number;
	entry: NoteEntry;
	/** The day the match is in, which is what a scan beyond the window targets. */
	key: string;
	/** The note the match is in; stays the same across a rebuild of the window. */
	path: string;
}

function sameMatch(left: FindMatch, right: FindMatch): boolean {
	return left.path === right.path && left.from === right.from && left.to === right.to;
}

export interface JournalFindHost {
	readonly app: App;
	readonly plugin: JournalViewPlugin;
	readonly sections: DaySection[];
	sortStep(): -1 | 1;
	setFindMode(open: boolean): void;
	findAnchorSection(): DaySection | null;
	revealFindMatch(section: DaySection, entry: NoteEntry, range: FindRange): void;
	loadFindDate(date: Moment): Promise<void>;
	isFindReady(): boolean;
}

/** Owns the journal-wide find bar, loaded matches, and outward vault scan. */
export class JournalFind {
	private readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly countEl: HTMLElement;
	private readonly previousButton: HTMLButtonElement;
	private readonly nextButton: HTMLButtonElement;
	private readonly caseButton: HTMLButtonElement;
	private readonly closeButton: HTMLButtonElement;

	private open = false;
	private caseSensitive = false;
	private matches: FindMatch[] = [];
	private selected: FindMatch | null = null;
	private refreshFrame = 0;
	private resetOnRefresh = false;
	private scanToken = 0;
	private scanning = false;
	private destroyed = false;

	constructor(parent: HTMLElement, private host: JournalFindHost) {
		this.el = parent.createDiv({ cls: "journal-find-bar is-hidden" });
		const inputWrap = this.el.createDiv({ cls: "journal-find-input-wrap" });
		const searchIcon = inputWrap.createSpan({ cls: "journal-find-search-icon" });
		setIcon(searchIcon, "search");
		this.input = inputWrap.createEl("input", {
			cls: "journal-find-input",
			attr: { type: "text", placeholder: "Find…", "aria-label": "Find in journal", autocomplete: "off" },
		});
		this.countEl = inputWrap.createSpan({ cls: "journal-find-count", attr: { "aria-live": "polite" } });

		this.previousButton = this.iconButton(["arrow-up"], "Previous result", () => void this.navigate(-1));
		this.nextButton = this.iconButton(["arrow-down"], "Next result", () => void this.navigate(1));
		this.caseButton = this.iconButton(["case-sensitive", "type"], "Match case", () => this.toggleCase());
		this.closeButton = this.iconButton(["x"], "Close find", () => this.close());

		this.input.addEventListener("input", () => this.scheduleRefresh(true));
		this.input.addEventListener("keydown", (event) => this.onInputKeydown(event));
		this.updateButtons();
	}

	private iconButton(icons: string[], label: string, action: () => void): HTMLButtonElement {
		const button = this.el.createEl("button", { cls: "clickable-icon journal-find-button" });
		applyIcon(button, ...icons);
		setTooltip(button, label);
		button.setAttribute("aria-label", label);
		button.addEventListener("click", action);
		return button;
	}

	show(): void {
		if (this.destroyed) return;
		if (!this.open) {
			this.open = true;
			this.el.removeClass("is-hidden");
			this.host.setFindMode(true);
			this.refresh(true);
		}
		this.focusInput(true);
	}

	close(): void {
		if (!this.open) return;
		this.cancelScan();
		this.open = false;
		this.el.addClass("is-hidden");
		this.host.setFindMode(false);
		this.clearSections();
		const selected = this.selected;
		this.matches = [];
		this.selected = null;
		this.updateCount();
		if (selected?.entry.el.isConnected) selected.entry.focusEditor();
	}

	isOpen(): boolean {
		return this.open;
	}

	/** Handles Escape early enough to outrank Obsidian's workspace keymap. */
	handleEscape(event: KeyboardEvent): boolean {
		const target = event.target as Node | null;
		if (!this.open || !target || !this.el.contains(target)) return false;
		this.close();
		return true;
	}

	focusInput(select = false): void {
		this.input.focus({ preventScroll: true });
		if (select) this.input.select();
	}

	/** Re-indexes after sections or their live contents changed. */
	sectionsChanged(): void {
		if (!this.open) return;
		this.scheduleRefresh(false, false);
	}

	private scheduleRefresh(resetSelection: boolean, cancelScan = true): void {
		if (cancelScan) this.cancelScan();
		this.resetOnRefresh ||= resetSelection;
		if (this.refreshFrame) return;
		this.refreshFrame = window.requestAnimationFrame(() => {
			this.refreshFrame = 0;
			const reset = this.resetOnRefresh;
			this.resetOnRefresh = false;
			this.refresh(reset);
		});
	}

	private refresh(resetSelection: boolean, targetKey?: string, direction: -1 | 1 = 1): void {
		if (!this.open || !this.host.isFindReady()) return;
		const query = this.input.value;
		const previous = resetSelection ? null : this.selected;
		this.matches = [];

		for (const [sectionIndex, section] of this.host.sections.entries()) {
			for (const entry of section.entries) {
				if (section.isHidden || entry.isHidden) {
					entry.setFindState(query, this.caseSensitive, [], null);
					continue;
				}
				const ranges = findLiteralRanges(entry.searchText(), query, this.caseSensitive);
				entry.setFindState(query, this.caseSensitive, ranges, null);
				for (const range of ranges) {
					this.matches.push({ section, sectionIndex, entry, key: section.key, path: entry.path, ...range });
				}
			}
		}

		let selected: FindMatch | null = null;
		if (query && targetKey) {
			const candidates = this.matches.filter((match) => match.key === targetKey);
			selected = direction > 0 ? (candidates[0] ?? null) : (candidates[candidates.length - 1] ?? null);
		}
		if (!selected && previous) {
			selected = this.matches.find((match) => sameMatch(match, previous)) ?? null;
		}
		if (!selected && query) selected = this.initialMatch();
		// A content-driven refresh may invalidate source offsets while the reader
		// is typing. Re-index and transfer the active decoration, but only move the
		// viewport/cursor for an explicit query reset or navigation target.
		this.select(selected, resetSelection || !!targetKey);
	}

	private initialMatch(): FindMatch | null {
		if (!this.matches.length) return null;
		const anchor = this.host.findAnchorSection();
		if (!anchor) return this.matches[0];
		const anchorIndex = this.host.sections.indexOf(anchor);
		return (
			this.matches.find((match) => match.section === anchor) ??
			this.matches.find((match) => match.sectionIndex > anchorIndex) ??
			this.matches[0]
		);
	}

	private select(match: FindMatch | null, reveal: boolean): void {
		const previousEntry = this.selected?.entry;
		this.selected = match;
		if (previousEntry && previousEntry !== match?.entry && previousEntry.el.isConnected) {
			previousEntry.selectFindRange(null);
		}
		if (match) {
			match.entry.selectFindRange(match);
			if (reveal) {
				this.host.revealFindMatch(match.section, match.entry, match);
				window.requestAnimationFrame(() => this.focusInput());
			}
		}
		this.updateCount();
		this.updateButtons();
	}

	private async navigate(direction: -1 | 1): Promise<void> {
		if (!this.open || !this.input.value || this.scanning) return;
		this.refresh(false);
		const selected = this.selected;
		const at = selected ? this.matches.findIndex((match) => sameMatch(match, selected)) : -1;
		const next = at < 0 ? (direction > 0 ? this.matches[0] : this.matches[this.matches.length - 1]) : this.matches[at + direction];
		if (next) {
			this.select(next, true);
			return;
		}
		await this.scanBeyond(direction);
	}

	private async scanBeyond(direction: -1 | 1): Promise<void> {
		const query = this.input.value;
		if (!query || !this.host.sections.length) return;
		const token = ++this.scanToken;
		this.scanning = true;
		this.countEl.setText("Searching…");
		this.updateButtons();

		const loadedKeys = new Set(this.host.sections.map((section) => section.key));
		const edge = direction > 0 ? this.host.sections[this.host.sections.length - 1].key : this.host.sections[0].key;
		const dateDirection = (direction * this.host.sortStep()) as -1 | 1;
		this.host.plugin.filteredIndex.ensureCurrent();
		const keys = this.host.plugin.filteredIndex.keysFrom(edge, dateDirection);
		const today = createMoment().startOf("day");

		try {
			for (let index = 0; index < keys.length; index++) {
				if (token !== this.scanToken || !this.open || query !== this.input.value) return;
				const key = keys[index];
				if (loadedKeys.has(key)) continue;
				const date = createMoment(key, "YYYY-MM-DD", true).startOf("day");
				if (!date.isValid()) continue;
				const offset = date.diff(today, "days");
				if (!isOffsetReachable(offset, this.host.plugin.settings.hideEmptyDays, true)) continue;
				if (await this.dayContains(key, query)) {
					await this.host.loadFindDate(date);
					if (token !== this.scanToken || !this.open || query !== this.input.value) return;
					this.refresh(false, key, direction);
					return;
				}
				if ((index + 1) % REMOTE_YIELD_EVERY === 0) await this.nextFrame();
			}

			// The circular scan checked every unloaded note. Wrap to the opposite
			// edge of the loaded matches, if there is one.
			const wrapped = direction > 0 ? this.matches[0] : this.matches[this.matches.length - 1];
			if (wrapped) this.select(wrapped, true);
			else this.countEl.setText("No matches");
		} finally {
			if (token === this.scanToken) {
				this.scanning = false;
				this.updateCount();
				this.updateButtons();
				this.focusInput();
			}
		}
	}

	/** True when one of the day's notes that pass the filters contains `query`. */
	private async dayContains(key: string, query: string): Promise<boolean> {
		const { app, plugin } = this.host;
		for (const path of plugin.index.pathsFor(key)) {
			if (!plugin.filteredIndex.matchesPath(path)) continue;
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			let content: string;
			try {
				content = await app.vault.cachedRead(file);
			} catch (error) {
				console.warn(`Journal View: could not search ${file.path}`, error);
				continue;
			}
			const body = content.slice(getFrontMatterInfo(content).contentStart);
			if (findLiteralRanges(body, query, this.caseSensitive).length) return true;
		}
		return false;
	}

	private nextFrame(): Promise<void> {
		return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
	}

	private toggleCase(): void {
		this.caseSensitive = !this.caseSensitive;
		this.caseButton.toggleClass("is-active", this.caseSensitive);
		this.caseButton.setAttribute("aria-pressed", String(this.caseSensitive));
		this.scheduleRefresh(true);
		window.requestAnimationFrame(() => this.focusInput());
	}

	private onInputKeydown(event: KeyboardEvent): void {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void this.navigate(event.shiftKey ? -1 : 1);
	}

	private updateCount(): void {
		if (this.scanning) return;
		if (!this.input.value) {
			this.countEl.setText("");
			return;
		}
		if (!this.matches.length) {
			this.countEl.setText("No matches loaded");
			return;
		}
		const selected = this.selected;
		const at = selected ? this.matches.findIndex((match) => sameMatch(match, selected)) : -1;
		this.countEl.setText(at >= 0 ? `${at + 1} / ${this.matches.length} loaded` : `${this.matches.length} loaded`);
	}

	private updateButtons(): void {
		const disabled = !this.input.value || this.scanning;
		this.previousButton.disabled = disabled;
		this.nextButton.disabled = disabled;
	}

	private clearSections(): void {
		for (const section of this.host.sections) {
			for (const entry of section.entries) entry.clearFindState();
		}
	}

	private cancelScan(): void {
		this.scanToken++;
		this.scanning = false;
		this.updateButtons();
	}

	destroy(): void {
		this.destroyed = true;
		this.cancelScan();
		if (this.refreshFrame) window.cancelAnimationFrame(this.refreshFrame);
		this.refreshFrame = 0;
		this.clearSections();
		this.el.remove();
	}
}
