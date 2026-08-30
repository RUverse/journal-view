import {
	AbstractInputSuggest,
	App,
	Component,
	MarkdownRenderer,
	Notice,
	TFile,
	getAllTags,
	getFrontMatterInfo,
	parseFrontMatterTags,
	parseYaml,
	setIcon,
	setTooltip,
} from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type JournalViewPlugin from "./main";
import { JournalEditor, createJournalEditor } from "./editor";
import type { Moment } from "./moment";
import { SaveQueue } from "./saveQueue";
import { findLiteralRanges } from "./findText";
import type { FindRange } from "./findText";
import { listenForReaderScrollIntent } from "./readerInput";

/**
 * Frames a cursor placed at the end of a day is kept on screen for, long
 * enough to outlast the centring and the rebuild that can follow a go-to.
 */
const REVEAL_FRAMES = 10;

type PropertyEditKind = "string" | "infer" | "number" | "boolean" | "json";

interface PropertyEditState {
	property: string;
	kind: PropertyEditKind;
	draft: string;
	invalid: string | null;
	inputEl: HTMLInputElement | null;
	wasFocused: boolean;
	selectionStart: number | null;
	selectionEnd: number | null;
}

interface TagEditState {
	draft: string;
	invalid: string | null;
	suggestions: string[];
	inputEl: HTMLInputElement | null;
	wasFocused: boolean;
	selectionStart: number | null;
	selectionEnd: number | null;
}

interface PropertyListEditState {
	property: string;
	draft: string;
	invalid: string | null;
	inputEl: HTMLInputElement | null;
	wasFocused: boolean;
	selectionStart: number | null;
	selectionEnd: number | null;
}

interface ParsedPropertyDraft {
	valid: boolean;
	remove: boolean;
	value?: unknown;
	error?: string;
}

type PropertyListMutation =
	| { action: "add"; value: string }
	| { action: "remove"; index: number; value: unknown };

/** Autocomplete for the tag input inside a day's metadata strip. */
class JournalTagSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private readonly items: () => string[],
		private readonly onValueSelected: (value: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const needle = query.trim().replace(/^#+/, "").toLocaleLowerCase();
		return this.items().filter((item) => !needle || item.toLocaleLowerCase().includes(needle));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		this.close();
		this.onValueSelected(value);
	}
}

/** The bits of the journal view a day needs to talk to. */
export interface DayHost {
	app: App;
	leaf: WorkspaceLeaf;
	plugin: JournalViewPlugin;
	/** Called when a day's underlying file appears, disappears or is renamed. */
	onDayFileChanged(day: DaySection, previousPath: string | null): void;
	/** True for a day that stays in the journal even with empty days hidden. */
	isPinnedDay(day: DaySection): boolean;
	/** True while a day is out of sight, where its body can be swapped unseen. */
	isOffScreen(day: DaySection): boolean;
	/** Re-indexes find results after this day's visible body changes. */
	onDayContentChanged(day: DaySection): void;
	/** Re-centres a navigation after focus-driven editor and template layout settles. */
	onDayFocusSettled(day: DaySection): void;
	/** Opens the journal-wide find UI from an embedded editor command. */
	showFind(): void;
}

/**
 * The journal edits only the note body. Obsidian's parser locates frontmatter
 * so it can be preserved exactly rather than parsed and serialized again.
 */
function noteBody(content: string): string {
	return content.slice(getFrontMatterInfo(content).contentStart);
}

/** CodeMirror stores every line break as `\n`, regardless of the file's EOL. */
function editorBody(content: string): string {
	return noteBody(content).replace(/\r\n?/g, "\n");
}

function replaceNoteBody(content: string, body: string): string {
	return content.slice(0, getFrontMatterInfo(content).contentStart) + body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedMetadataText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/** Compact, non-interactive rendering for a frontmatter value. */
function metadataText(value: unknown): string {
	if (Array.isArray(value)) {
		const items = value.map(nestedMetadataText).filter(Boolean);
		return items.length ? items.join(", ") : "—";
	}
	return nestedMetadataText(value) || "—";
}

function propertyEditKind(value: unknown): PropertyEditKind {
	if (value === null || value === undefined) return "infer";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number") return "number";
	if (Array.isArray(value) || isRecord(value)) return "json";
	return "string";
}

function propertyDraft(value: unknown, kind: PropertyEditKind): string {
	if (value === null || value === undefined) return "";
	if (kind === "json") {
		try {
			return JSON.stringify(value) ?? "";
		} catch {
			return "";
		}
	}
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	return nestedMetadataText(value);
}

const NUMBER_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function parsePropertyDraft(kind: PropertyEditKind, draft: string): ParsedPropertyDraft {
	const trimmed = draft.trim();
	if (!trimmed) return { valid: true, remove: true };

	if (kind === "number") {
		if (!NUMBER_VALUE.test(trimmed)) {
			return { valid: false, remove: false, error: "Enter a valid number." };
		}
		const value = Number(trimmed);
		return Number.isFinite(value)
			? { valid: true, remove: false, value }
			: { valid: false, remove: false, error: "Enter a finite number." };
	}

	if (kind === "boolean") {
		return { valid: true, remove: false, value: trimmed === "true" };
	}

	if (kind === "json") {
		try {
			const value: unknown = JSON.parse(trimmed);
			if (!Array.isArray(value) && !isRecord(value)) {
				return { valid: false, remove: false, error: "Enter a JSON array or object." };
			}
			return { valid: true, remove: false, value };
		} catch {
			return { valid: false, remove: false, error: "Enter valid JSON." };
		}
	}

	if (kind === "infer") {
		if (trimmed === "true" || trimmed === "false") {
			return { valid: true, remove: false, value: trimmed === "true" };
		}
		if (NUMBER_VALUE.test(trimmed)) {
			const value = Number(trimmed);
			if (Number.isFinite(value)) return { valid: true, remove: false, value };
		}
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			try {
				const value: unknown = JSON.parse(trimmed);
				if (Array.isArray(value) || isRecord(value)) {
					return { valid: true, remove: false, value };
				}
			} catch {
				return { valid: false, remove: false, error: "Enter valid JSON." };
			}
		}
	}

	return { valid: true, remove: false, value: trimmed };
}

function normalizedTag(raw: string): string | null {
	const tag = raw.trim().replace(/^#+/, "");
	return tag && !/[\s,]/.test(tag) ? tag : null;
}

function sameMetadataValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if ((!Array.isArray(left) && !isRecord(left)) || (!Array.isArray(right) && !isRecord(right))) {
		return false;
	}
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function storedTagMatches(value: unknown, target: string): boolean {
	return typeof value === "string" && normalizedTag(value)?.toLocaleLowerCase() === target;
}

function sameFindRange(left: FindRange | null, right: FindRange | null): boolean {
	return left === right || (!!left && !!right && left.from === right.from && left.to === right.to);
}

function sameFindRanges(left: FindRange[], right: FindRange[]): boolean {
	return (
		left.length === right.length &&
		left.every((range, index) => range.from === right[index].from && range.to === right[index].to)
	);
}

/**
 * One day in the journal. A day has two modes:
 *
 * - Edit: a real editor. Every day the reader can see is in this mode, so
 *   clicking into text only moves the cursor - nothing is swapped out from
 *   under the click and nothing reflows.
 * - Preview: the note rendered as static markdown, used for days that are far
 *   enough off screen that keeping an editor alive for them is waste. Static
 *   DOM costs nothing to keep and is laid out at its true height.
 *
 * The view decides which mode a day is in (see `EditorWindow.update`) and
 * only ever changes it while the day is well outside the viewport, so a mode
 * change is never something the reader can watch happen.
 */
export class DaySection {
	readonly el: HTMLElement;
	readonly key: string;

	private yearEl: HTMLElement;
	private monthEl: HTMLElement;
	private cardEl: HTMLElement;
	private headerEl: HTMLElement;
	private titleEl: HTMLElement;
	private actionsEl: HTMLElement;
	private metadataEl: HTMLElement;
	private bodyEl: HTMLElement;

	private editor: JournalEditor | null = null;
	private previewComponent: Component | null = null;
	private destroyed = false;
	/**
	 * Bumped whenever the day's mode is asked to change. A preview is built
	 * asynchronously, so the token tells a finished build whether the mode it
	 * was rendered for is still the one wanted.
	 */
	private modeToken = 0;
	/** True while a preview is being built to replace this day's editor. */
	private unmounting = false;
	/** Preview height (px) held until the editor completes its first layout. */
	private heldHeight = 0;
	/** Pending frame of the run that keeps a cursor placed at the end in view. */
	private revealFrame = 0;
	/** Drops the listeners watching for the reader to take that run over. */
	private endReveal: (() => void) | null = null;

	private lastKnownContent = "";
	/** Newest complete file content, including external frontmatter held off from a dirty editor. */
	private latestContent = "";
	private propertyEdit: PropertyEditState | null = null;
	private propertyListEdit: PropertyListEditState | null = null;
	private tagEdit: TagEditState | null = null;
	private tagSuggest: JournalTagSuggest | null = null;
	private refreshingMetadata = false;
	private tagPointerCleanup: (() => void) | null = null;
	private tagSuggestionPointerDown = false;
	private metadataWrites: Promise<void> = Promise.resolve();
	private pendingProperties = new Set<string>();
	private tagsPending = false;
	/** An external write held off until this day's own pending edit has settled. */
	private externalReloadPending = false;
	/** Template text shown in an empty day but not yet accepted by the reader. */
	private pendingTemplate: string | null = null;
	private saveTimer = 0;
	private focused = false;
	/** Invalidates focus-settle work when focus leaves or the day is destroyed. */
	private focusSettleToken = 0;
	private readonly queue = new SaveQueue((value) => this.writeValue(value));
	private findState: {
		query: string;
		caseSensitive: boolean;
		ranges: FindRange[];
		selected: FindRange | null;
	} | null = null;

	file: TFile | null;
	path: string;

	constructor(
		private host: DayHost,
		readonly date: Moment,
		readonly offset: number,
	) {
		this.key = date.format("YYYY-MM-DD");
		this.path = host.plugin.daily.pathFor(date);
		this.file = host.plugin.daily.fileFor(date);

		this.el = createDiv({ cls: "journal-day", attr: { "data-date": this.key } });
		this.yearEl = this.el.createDiv({
			cls: "journal-year-separator",
			text: date.format("YYYY"),
			attr: { role: "heading", "aria-level": "2" },
		});
		this.yearEl.hidden = true;
		this.monthEl = this.el.createDiv({
			cls: "journal-month-separator",
			attr: { role: "heading", "aria-level": "3" },
		});
		this.monthEl.createSpan({ cls: "journal-month-name", text: date.format("MMMM") });
		this.monthEl.createSpan({ cls: "journal-month-year", text: date.format("YYYY") });
		this.monthEl.hidden = true;
		this.cardEl = this.el.createDiv({ cls: "journal-day-card" });
		this.headerEl = this.cardEl.createDiv({ cls: "journal-day-header" });
		this.titleEl = this.headerEl.createDiv({ cls: "journal-day-title" });
		this.titleEl.createSpan({ cls: "journal-day-date", text: this.formatHeader() });
		const relative = this.relativeLabel();
		if (relative) this.titleEl.createSpan({ cls: "journal-day-badge", text: relative });
		this.actionsEl = this.headerEl.createDiv({ cls: "journal-day-actions" });

		this.metadataEl = this.cardEl.createDiv({ cls: "journal-day-metadata" });
		this.metadataEl.hidden = true;
		this.bodyEl = this.cardEl.createDiv({ cls: "journal-day-body" });

		this.el.addEventListener("click", (event) => this.onClick(event));

		this.refreshState();
	}

	private onClick(event: MouseEvent): void {
		const target = event.target as HTMLElement;
		if (target.closest(".journal-day-actions")) return;

		if (this.editor) {
			// The editor handles clicks that land in its own text, links
			// included. A click on the day's padding does not reach it, so
			// place the cursor at the nearest position by hand.
			if (this.editor.hasFocus() || !target.closest(".journal-day-body")) return;
			if (window.getSelection()?.toString()) return;
			this.focusAt(event);
			return;
		}

		// The rest only applies to days far enough off screen to still be a
		// preview - the reader has to arrive there faster than the view can
		// mount an editor, so it is rare but has to keep working.

		// Links in the preview navigate; they should not start an edit.
		const link = target.closest("a");
		if (link) {
			event.preventDefault();
			const href = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (!href) return;
			if (link.classList.contains("internal-link")) {
				void this.host.app.workspace.openLinkText(href, this.path, event.ctrlKey || event.metaKey);
			} else if (/^https?:/.test(href)) {
				window.open(href);
			}
			return;
		}

		if (!target.closest(".journal-day-body")) return;
		// A click that ends a text selection is a copy gesture, not an edit.
		if (window.getSelection()?.toString()) return;
		this.focusAt(event);
	}

	/** Puts the cursor where the day was clicked, mounting an editor if needed. */
	private focusAt(event: MouseEvent): void {
		this.mountEditor();
		const editor = this.editor;
		if (!editor) return;
		editor.focus();
		editor.placeCursor?.(event.clientX, event.clientY);
	}

	/**
	 * Lays the configured template into a day that has no note yet, so the
	 * reader writes into the same skeleton the "Create note" button would have
	 * produced. Driven by focus, so it happens when the reader enters the day
	 * themselves - the view mounts editors ahead of them, and those are left
	 * alone until one is entered.
	 *
	 * The text is an offer, not content: `pendingTemplate` keeps it out of the
	 * save queue until the reader edits it, so clicking through an empty day
	 * still leaves nothing behind in the vault.
	 */
	private async offerTemplate(): Promise<void> {
		if (this.file || !this.editor || this.editor.getValue().length > 0) return;
		const body = editorBody(await this.host.plugin.daily.templateContent(this.date));
		// Reading the template yields, so everything above is re-checked: the
		// reader may have typed, left, or the note may have appeared, in
		// between. An offer landing after they left would have nothing to
		// withdraw it.
		if (!body || this.destroyed || !this.hasFocus) return;
		if (this.file || !this.editor || this.editor.getValue().length > 0) return;

		// Set first: filling the editor reports a change, and the save that
		// follows has to already know the text is only an offer.
		this.pendingTemplate = body;
		this.editor.setValue(body);
		this.editor.placeCursorAtEnd?.();
		this.releaseHeight();
		this.updateBlankState();
	}

	/** Takes back an untouched template offer, leaving the day empty again. */
	private withdrawTemplate(): boolean {
		const pending = this.pendingTemplate;
		if (pending === null) return false;
		if (!this.editor || this.editor.getValue() !== pending) {
			// The reader made it their own; it saves like anything they wrote.
			this.pendingTemplate = null;
			return false;
		}

		this.pendingTemplate = null;
		this.editor.setValue(editorBody(this.lastKnownContent));
		this.updateBlankState();
		// A note can appear between offering the template and this blur. Re-read
		// it rather than leave the pre-offer content in the editor.
		if (this.file) void this.reload();
		return true;
	}

	/* ---------------------------------------------------------------- state */

	get isToday(): boolean {
		return this.offset === 0;
	}

	get exists(): boolean {
		return this.file !== null;
	}

	/** True while this day holds a live editor rather than a static preview. */
	get isEditing(): boolean {
		return this.editor !== null;
	}

	/** False for a day the layout is ignoring, e.g. a hidden empty day. */
	get isLaidOut(): boolean {
		return this.el.offsetParent !== null;
	}

	/** Viewport position of stable day content, below any movable date headings. */
	get contentTop(): number {
		return this.headerEl.getBoundingClientRect().top;
	}

	/** Top of the whole day, headings included - where the day starts on screen. */
	get dayTop(): number {
		return this.el.offsetTop;
	}

	/** Card geometry excludes the optional year and month headings above the day. */
	get cardTop(): number {
		return this.el.offsetTop + this.cardEl.offsetTop;
	}

	get cardHeight(): number {
		return this.cardEl.offsetHeight;
	}

	/** True when the day itself is filtered out, independent of pane visibility. */
	get isHidden(): boolean {
		return this.el.hasClass("journal-day-hidden");
	}

	/** Shows the month heading carried by the first rendered day in that month. */
	setMonthSeparator(visible: boolean): void {
		this.monthEl.hidden = !visible;
	}

	/** Shows the year heading when this day follows a rendered day in another year. */
	setYearSeparator(visible: boolean): void {
		this.yearEl.hidden = !visible;
		this.el.toggleClass("journal-day-year-start", visible);
	}

	private formatHeader(): string {
		return this.date.format(this.host.plugin.settings.headerFormat);
	}

	private relativeLabel(): string | null {
		return this.offset === 0 ? "Today" : null;
	}

	/** Re-applies the classes and header buttons that depend on the file. */
	refreshState(): void {
		this.el.toggleClass("journal-day-today", this.isToday);
		this.el.toggleClass("journal-day-empty", !this.exists);
		this.el.toggleClass("journal-day-future", this.offset > 0);
		this.el.toggleClass(
			"journal-day-hidden",
			!this.exists && !this.host.isPinnedDay(this) && this.host.plugin.settings.hideEmptyDays,
		);

		this.bodyEl.dataset.placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		this.actionsEl.empty();
		setTooltip(this.titleEl, this.path, { placement: "right" });

		if (this.exists) {
			const remove = this.actionsEl.createEl("button", {
				cls: "clickable-icon journal-day-action journal-day-delete",
			});
			setIcon(remove, "trash-2");
			setTooltip(remove, "Delete note");
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.deleteNote();
			});

			const open = this.actionsEl.createEl("button", { cls: "clickable-icon journal-day-action" });
			setIcon(open, "file-text");
			setTooltip(open, "Open note in a tab");
			open.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.openInTab(event.ctrlKey || event.metaKey);
			});
		} else {
			const create = this.actionsEl.createEl("button", {
				cls: "journal-day-action journal-day-create",
				text: "Create note",
			});
			setTooltip(create, `Create ${this.path}`);
			create.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.createNow();
			});
		}
		this.refreshMetadata();
	}

	/** Rebuilds the editable strip from the latest complete note content. */
	refreshMetadata(content = this.latestContent): void {
		if (this.destroyed) return;
		this.latestContent = content;
		this.captureMetadataEdit();
		this.tagPointerCleanup?.();
		this.tagPointerCleanup = null;
		this.tagSuggestionPointerDown = false;
		this.refreshingMetadata = true;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.metadataEl.empty();
		this.metadataEl.hidden = true;

		try {
			const { displayProperties, showTags } = this.host.plugin.settings;
			if (!this.file || (!displayProperties.length && !showTags)) {
				this.propertyEdit = null;
				this.propertyListEdit = null;
				this.tagEdit = null;
				return;
			}

			const displayed = new Set(displayProperties.map((property) => property.toLocaleLowerCase()));
			if (this.propertyEdit && !displayed.has(this.propertyEdit.property.toLocaleLowerCase())) {
				this.propertyEdit = null;
			}
			if (
				this.propertyListEdit &&
				!displayed.has(this.propertyListEdit.property.toLocaleLowerCase())
			) {
				this.propertyListEdit = null;
			}
			if (!showTags) this.tagEdit = null;

			const frontmatter = this.parseFrontmatter(content);
			const entries = Object.entries(frontmatter);
			for (const property of displayProperties) {
				const key = property.toLocaleLowerCase();
				const entry = entries.find(([name]) => name.toLocaleLowerCase() === key);
				const row = this.metadataEl.createDiv({ cls: "journal-day-metadata-row" });
				row.createSpan({ cls: "journal-day-metadata-label", text: property });
				const pending = this.pendingProperties.has(key);
				const propertyValue = entry?.[1];
				if (
					this.propertyListEdit?.property.toLocaleLowerCase() === key &&
					!Array.isArray(propertyValue)
				) {
					this.propertyListEdit = null;
				}
				row.toggleClass("journal-day-metadata-pending", pending);
				if (pending) row.setAttribute("aria-busy", "true");

				if (this.propertyEdit?.property.toLocaleLowerCase() === key) {
					this.renderPropertyEditor(row, this.propertyEdit);
				} else if (Array.isArray(propertyValue)) {
					this.renderPropertyList(row, property, propertyValue, pending);
				} else {
					const valueText = metadataText(propertyValue);
					const value = row.createEl("button", {
						cls: "journal-day-metadata-value journal-day-metadata-value-button",
						text: valueText,
						attr: { type: "button", "aria-label": `Edit ${property}` },
					});
					value.toggleClass("journal-day-metadata-value-empty", valueText === "—");
					value.disabled = pending;
					value.addEventListener("click", (event) => {
						event.stopPropagation();
						this.startPropertyEdit(property, propertyValue);
					});
				}
			}

			if (showTags) this.renderTags(frontmatter);
			this.metadataEl.hidden = this.metadataEl.childElementCount === 0;
		} finally {
			this.refreshingMetadata = false;
			this.restoreMetadataFocus();
		}
	}

	private renderPropertyList(
		row: HTMLElement,
		property: string,
		items: unknown[],
		pending: boolean,
	): void {
		row.addClass("journal-day-metadata-list");
		const list = row.createDiv({
			cls: "journal-day-property-list",
			attr: { "aria-label": `${property} values` },
		});
		for (const [index, item] of items.entries()) {
			const text = nestedMetadataText(item) || "—";
			const chip = list.createSpan({ cls: "journal-day-tag journal-day-property-list-item" });
			chip.createSpan({ cls: "journal-day-tag-text", text });
			const remove = chip.createEl("button", {
				cls: "journal-day-tag-remove",
				attr: { type: "button", "aria-label": `Remove ${text} from ${property}` },
			});
			remove.createSpan({ text: "×", attr: { "aria-hidden": "true" } });
			remove.disabled = pending;
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.removePropertyListItem(property, index, item);
			});
		}

		if (this.propertyListEdit?.property.toLocaleLowerCase() === property.toLocaleLowerCase()) {
			this.renderPropertyListEditor(list, this.propertyListEdit, pending);
		} else {
			const add = list.createEl("button", {
				cls: "clickable-icon journal-day-tag-add journal-day-property-list-add",
				attr: { type: "button", "aria-label": `Add item to ${property}` },
			});
			setIcon(add, "plus");
			setTooltip(add, `Add item to ${property}`);
			add.disabled = pending;
			add.addEventListener("click", (event) => {
				event.stopPropagation();
				this.startPropertyListEdit(property);
			});
		}
	}

	private startPropertyListEdit(property: string): void {
		if (!this.file || this.pendingProperties.has(property.toLocaleLowerCase())) return;
		if (this.propertyEdit) {
			this.commitPropertyEdit(this.propertyEdit);
			if (this.propertyEdit) return;
		}
		this.tagPointerCleanup?.();
		this.tagPointerCleanup = null;
		this.tagSuggestionPointerDown = false;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.tagEdit = null;
		this.propertyListEdit = {
			property,
			draft: "",
			invalid: null,
			inputEl: null,
			wasFocused: true,
			selectionStart: 0,
			selectionEnd: 0,
		};
		this.refreshMetadata();
	}

	private renderPropertyListEditor(
		list: HTMLElement,
		state: PropertyListEditState,
		pending: boolean,
	): void {
		const input = list.createEl("input", {
			cls: "journal-day-tag-input journal-day-property-list-input",
			attr: {
				type: "text",
				placeholder: "Add item",
				"aria-label": `Add item to ${state.property}`,
			},
		});
		input.value = state.draft;
		input.readOnly = pending;
		state.inputEl = input;
		this.syncInvalidMetadataInput(input, state.invalid);
		input.addEventListener("input", () => {
			state.draft = input.value;
			state.invalid = null;
			this.syncInvalidMetadataInput(input, null);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.cancelPropertyListEdit(state);
			} else if (event.key === "Enter") {
				event.preventDefault();
				this.commitPropertyListItem(state);
			}
		});
		input.addEventListener("blur", () => {
			if (this.refreshingMetadata) return;
			window.setTimeout(() => {
				if (
					this.propertyListEdit === state &&
					state.inputEl === input &&
					input.ownerDocument.activeElement !== input
				) {
					this.cancelPropertyListEdit(state);
				}
			}, 0);
		});
	}

	private cancelPropertyListEdit(state: PropertyListEditState): void {
		if (this.propertyListEdit !== state) return;
		this.propertyListEdit = null;
		this.refreshMetadata();
	}

	private commitPropertyListItem(state: PropertyListEditState): void {
		if (this.propertyListEdit !== state) return;
		const value = state.draft.trim();
		if (!value) {
			state.invalid = "Enter a list item.";
			if (state.inputEl) this.syncInvalidMetadataInput(state.inputEl, state.invalid);
			return;
		}
		this.propertyListEdit = null;
		this.updatePropertyList(state.property, { action: "add", value });
	}

	private removePropertyListItem(property: string, index: number, value: unknown): void {
		if (this.pendingProperties.has(property.toLocaleLowerCase())) return;
		this.updatePropertyList(property, { action: "remove", index, value });
	}

	private updatePropertyList(property: string, mutation: PropertyListMutation): void {
		const pendingKey = property.toLocaleLowerCase();
		if (this.pendingProperties.has(pendingKey)) return;
		this.pendingProperties.add(pendingKey);
		this.refreshMetadata();
		void this.writePropertyList(property, mutation).finally(() => {
			this.pendingProperties.delete(pendingKey);
			if (!this.destroyed) this.refreshMetadata();
		});
	}

	private captureMetadataEdit(): void {
		const active = this.metadataEl.ownerDocument.activeElement;
		for (const state of [this.propertyEdit, this.propertyListEdit, this.tagEdit]) {
			const input = state?.inputEl;
			if (!state || !input) continue;
			if (input.type === "checkbox") state.draft = String(input.checked);
			else state.draft = input.value;
			if (active === input) {
				state.wasFocused = true;
				state.selectionStart = input.selectionStart;
				state.selectionEnd = input.selectionEnd;
			}
		}
	}

	private restoreMetadataFocus(): void {
		for (const state of [this.propertyEdit, this.propertyListEdit, this.tagEdit]) {
			if (!state?.wasFocused || !state.inputEl) continue;
			const input = state.inputEl;
			window.requestAnimationFrame(() => {
				if (this.destroyed || !input.isConnected || state.inputEl !== input) return;
				input.focus();
				if (input.type !== "checkbox" && state.selectionStart !== null && state.selectionEnd !== null) {
					input.setSelectionRange(state.selectionStart, state.selectionEnd);
				}
				if (state === this.tagEdit) this.tagSuggest?.open();
				state.wasFocused = false;
			});
		}
	}

	private startPropertyEdit(property: string, value: unknown): void {
		if (!this.file || this.pendingProperties.has(property.toLocaleLowerCase())) return;
		if (this.propertyEdit) {
			this.commitPropertyEdit(this.propertyEdit);
			if (this.propertyEdit) return; // invalid input stays open until corrected or cancelled
		}
		this.tagPointerCleanup?.();
		this.tagPointerCleanup = null;
		this.tagSuggestionPointerDown = false;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.tagEdit = null;
		this.propertyListEdit = null;
		const kind = propertyEditKind(value);
		this.propertyEdit = {
			property,
			kind,
			draft: propertyDraft(value, kind),
			invalid: null,
			inputEl: null,
			wasFocused: true,
			selectionStart: null,
			selectionEnd: null,
		};
		this.refreshMetadata();
	}

	private renderPropertyEditor(row: HTMLElement, state: PropertyEditState): void {
		row.addClass("journal-day-metadata-editing");
		const editor = row.createSpan({ cls: "journal-day-property-editor" });
		const input = editor.createEl("input", {
			cls: "journal-day-property-input",
			attr: {
				type: state.kind === "boolean" ? "checkbox" : "text",
				"aria-label": `Edit ${state.property}`,
			},
		});
		state.inputEl = input;
		if (state.kind === "number") input.inputMode = "decimal";
		if (state.kind === "boolean") input.checked = state.draft === "true";
		else input.value = state.draft;
		this.syncInvalidMetadataInput(input, state.invalid);
		window.requestAnimationFrame(() => {
			if (this.destroyed || !input.isConnected || state.inputEl !== input) return;
			this.resizePropertyInput(input);
		});

		input.addEventListener("input", () => {
			state.draft = input.type === "checkbox" ? String(input.checked) : input.value;
			state.invalid = null;
			this.syncInvalidMetadataInput(input, null);
			this.resizePropertyInput(input);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.cancelPropertyEdit(state);
			} else if (event.key === "Enter" && state.kind !== "boolean") {
				event.preventDefault();
				this.commitPropertyEdit(state);
			}
		});
		if (state.kind === "boolean") {
			input.addEventListener("change", () => {
				state.draft = String(input.checked);
				this.commitPropertyEdit(state);
			});
		}
		input.addEventListener("blur", (event) => {
			const related = event.relatedTarget as Node | null;
			if (this.refreshingMetadata || editor.contains(related)) return;
			window.setTimeout(() => {
				if (this.propertyEdit === state && !this.refreshingMetadata) this.commitPropertyEdit(state);
			}, 0);
		});

		const clear = editor.createEl("button", {
			cls: "clickable-icon journal-day-metadata-clear",
			attr: { type: "button", "aria-label": `Clear ${state.property}` },
		});
		setIcon(clear, "x");
		setTooltip(clear, `Clear ${state.property}`);
		clear.addEventListener("pointerdown", (event) => event.preventDefault());
		clear.addEventListener("click", (event) => {
			event.stopPropagation();
			this.commitPropertyEdit(state, true);
		});
	}

	private resizePropertyInput(input: HTMLInputElement): void {
		if (input.type === "checkbox") return;
		input.setCssProps({ "--journal-property-input-width": "0px" });
		const borderWidth = input.offsetWidth - input.clientWidth;
		input.setCssProps({ "--journal-property-input-width": `${input.scrollWidth + borderWidth}px` });
	}

	private syncInvalidMetadataInput(input: HTMLInputElement, error: string | null): void {
		input.toggleClass("is-invalid", !!error);
		input.setAttribute("aria-invalid", error ? "true" : "false");
		if (error) input.setAttribute("title", error);
		else input.removeAttribute("title");
	}

	private cancelPropertyEdit(state: PropertyEditState): void {
		if (this.propertyEdit !== state) return;
		this.propertyEdit = null;
		this.refreshMetadata();
	}

	private commitPropertyEdit(state: PropertyEditState, forceRemove = false): void {
		if (this.propertyEdit !== state) return;
		const draft = state.inputEl?.type === "checkbox" ? String(state.inputEl.checked) : state.draft;
		if (!forceRemove && this.propertyDraftUnchanged(state.property, state.kind, draft)) {
			this.propertyEdit = null;
			this.refreshMetadata();
			return;
		}
		const parsed = forceRemove
			? { valid: true, remove: true }
			: parsePropertyDraft(state.kind, draft);
		if (!parsed.valid) {
			state.invalid = parsed.error ?? "Enter a valid value.";
			if (state.inputEl) this.syncInvalidMetadataInput(state.inputEl, state.invalid);
			return;
		}
		if (!this.propertyWriteNeeded(state.property, parsed.remove, parsed.value)) {
			this.propertyEdit = null;
			this.refreshMetadata();
			return;
		}

		this.propertyEdit = null;
		const pendingKey = state.property.toLocaleLowerCase();
		this.pendingProperties.add(pendingKey);
		this.refreshMetadata();
		void this.writeProperty(state.property, parsed.remove, parsed.value).finally(() => {
			this.pendingProperties.delete(pendingKey);
			if (!this.destroyed) this.refreshMetadata();
		});
	}

	private propertyWriteNeeded(property: string, remove: boolean, value: unknown): boolean {
		const frontmatter = this.parseFrontmatter(this.latestContent);
		const entry = Object.entries(frontmatter).find(
			([key]) => key.toLocaleLowerCase() === property.toLocaleLowerCase(),
		);
		return remove ? entry !== undefined : !entry || !sameMetadataValue(entry[1], value);
	}

	private propertyDraftUnchanged(property: string, kind: PropertyEditKind, draft: string): boolean {
		const frontmatter = this.parseFrontmatter(this.latestContent);
		const entry = Object.entries(frontmatter).find(
			([key]) => key.toLocaleLowerCase() === property.toLocaleLowerCase(),
		);
		return !!entry && propertyDraft(entry[1], kind) === draft;
	}

	private renderTags(frontmatter: Record<string, unknown>): void {
		const tags = this.frontmatterTags(frontmatter);
		const row = this.metadataEl.createDiv({
			cls: "journal-day-metadata-row journal-day-metadata-tags",
		});
		row.toggleClass("journal-day-metadata-pending", this.tagsPending);
		if (this.tagsPending) row.setAttribute("aria-busy", "true");
		const label = row.createSpan({
			cls: "journal-day-metadata-label journal-day-metadata-tags-label",
		});
		setIcon(label, "tag");
		label.querySelector("svg")?.setAttribute("aria-hidden", "true");
		setTooltip(label, "Tags");
		const list = row.createDiv({ cls: "journal-day-tags" });

		for (const tag of tags) {
			const chip = list.createSpan({ cls: "journal-day-tag" });
			chip.createSpan({ cls: "journal-day-tag-text", text: tag });
			const remove = chip.createEl("button", {
				cls: "journal-day-tag-remove",
				attr: { type: "button", "aria-label": `Remove tag ${tag}` },
			});
			remove.createSpan({ text: "×", attr: { "aria-hidden": "true" } });
			remove.disabled = this.tagsPending;
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.removeTag(tag);
			});
		}

		if (this.tagEdit) this.renderTagEditor(list, this.tagEdit, tags);
		else {
			const add = list.createEl("button", {
				cls: "clickable-icon journal-day-tag-add",
				attr: { type: "button", "aria-label": "Add tag", "aria-haspopup": "listbox" },
			});
			setIcon(add, "plus");
			setTooltip(add, "Add tag");
			add.disabled = this.tagsPending;
			add.addEventListener("click", (event) => {
				event.stopPropagation();
				this.startTagEdit(tags);
			});
		}
	}

	private startTagEdit(currentTags: string[]): void {
		if (!this.file || this.tagsPending) return;
		if (this.propertyEdit) {
			this.commitPropertyEdit(this.propertyEdit);
			if (this.propertyEdit) return;
		}
		this.propertyListEdit = null;
		this.tagEdit = {
			draft: "",
			invalid: null,
			suggestions: this.availableVaultTags(currentTags),
			inputEl: null,
			wasFocused: true,
			selectionStart: 0,
			selectionEnd: 0,
		};
		this.refreshMetadata();
	}

	private renderTagEditor(list: HTMLElement, state: TagEditState, currentTags: string[]): void {
		const input = list.createEl("input", {
			cls: "journal-day-tag-input",
			attr: { type: "text", placeholder: "Add tag", "aria-label": "Add tag" },
		});
		input.value = state.draft;
		state.inputEl = input;
		this.syncInvalidMetadataInput(input, state.invalid);
		this.tagSuggest = new JournalTagSuggest(
			this.host.app,
			input,
			() => state.suggestions,
			(value) => {
				this.commitTag(state, value, currentTags);
			},
		);
		const document = input.ownerDocument;
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest(".suggestion-container")) {
				this.tagSuggestionPointerDown = true;
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		this.tagPointerCleanup = () => document.removeEventListener("pointerdown", onPointerDown, true);
		input.addEventListener("input", () => {
			state.draft = input.value;
			state.invalid = null;
			this.syncInvalidMetadataInput(input, null);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.cancelTagEdit(state);
			} else if (event.key === "Enter" || event.key === ",") {
				event.preventDefault();
				this.commitTag(state, input.value, currentTags);
			}
		});
		input.addEventListener("blur", () => {
			if (this.refreshingMetadata) return;
			window.setTimeout(() => {
				if (this.tagSuggestionPointerDown) {
					this.tagSuggestionPointerDown = false;
					return;
				}
				if (this.tagEdit === state && state.inputEl === input && input.ownerDocument.activeElement !== input) {
					this.cancelTagEdit(state);
				}
			}, 0);
		});
	}

	private cancelTagEdit(state: TagEditState): void {
		if (this.tagEdit !== state) return;
		this.tagPointerCleanup?.();
		this.tagPointerCleanup = null;
		this.tagSuggestionPointerDown = false;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.tagEdit = null;
		this.refreshMetadata();
	}

	private commitTag(state: TagEditState, raw: string, currentTags: string[]): void {
		if (this.tagEdit !== state) return;
		const tag = normalizedTag(raw);
		if (!tag) {
			state.invalid = "Tags cannot be empty or contain spaces or commas.";
			if (state.inputEl) this.syncInvalidMetadataInput(state.inputEl, state.invalid);
			return;
		}
		if (currentTags.some((current) => current.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
			state.invalid = `${tag} is already present.`;
			if (state.inputEl) this.syncInvalidMetadataInput(state.inputEl, state.invalid);
			return;
		}

		this.tagPointerCleanup?.();
		this.tagPointerCleanup = null;
		this.tagSuggestionPointerDown = false;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.tagEdit = null;
		this.tagsPending = true;
		this.refreshMetadata();
		void this.writeTag("add", tag).finally(() => {
			this.tagsPending = false;
			if (!this.destroyed) this.refreshMetadata();
		});
	}

	private removeTag(tag: string): void {
		if (this.tagsPending) return;
		this.tagsPending = true;
		this.refreshMetadata();
		void this.writeTag("remove", tag).finally(() => {
			this.tagsPending = false;
			if (!this.destroyed) this.refreshMetadata();
		});
	}

	private availableVaultTags(currentTags: string[]): string[] {
		const selected = new Set(currentTags.map((tag) => tag.toLocaleLowerCase()));
		const available = new Map<string, string>();
		for (const file of this.host.app.vault.getMarkdownFiles()) {
			const cache = this.host.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const rawTag of getAllTags(cache) ?? []) {
				const tag = normalizedTag(rawTag);
				const key = tag?.toLocaleLowerCase();
				if (!tag || !key || selected.has(key) || available.has(key)) continue;
				available.set(key, tag);
			}
		}
		return Array.from(available.values()).sort((left, right) => left.localeCompare(right));
	}

	private writeProperty(property: string, remove: boolean, value: unknown): Promise<void> {
		if (!this.propertyWriteNeeded(property, remove, value)) return Promise.resolve();
		return this.enqueueMetadataWrite(`update ${property}`, (frontmatter) => {
			const actual = Object.keys(frontmatter).find(
				(key) => key.toLocaleLowerCase() === property.toLocaleLowerCase(),
			);
			if (remove) {
				if (actual) delete frontmatter[actual];
			} else {
				frontmatter[actual ?? property] = value;
			}
		});
	}

	private writePropertyList(property: string, mutation: PropertyListMutation): Promise<void> {
		if (!this.propertyListWriteNeeded(property, mutation)) return Promise.resolve();
		return this.enqueueMetadataWrite(`update ${property}`, (frontmatter) => {
			const actual = Object.keys(frontmatter).find(
				(key) => key.toLocaleLowerCase() === property.toLocaleLowerCase(),
			);
			if (!actual) {
				if (mutation.action === "add") frontmatter[property] = [mutation.value];
				return;
			}

			const stored = frontmatter[actual];
			if (!Array.isArray(stored)) throw new Error(`${actual} is no longer a list`);
			if (mutation.action === "add") {
				stored.push(mutation.value);
				return;
			}

			let index = mutation.index;
			if (!sameMetadataValue(stored[index], mutation.value)) {
				index = stored.findIndex((item) => sameMetadataValue(item, mutation.value));
			}
			if (index >= 0) stored.splice(index, 1);
		});
	}

	private propertyListWriteNeeded(property: string, mutation: PropertyListMutation): boolean {
		const frontmatter = this.parseFrontmatter(this.latestContent);
		const actual = Object.keys(frontmatter).find(
			(key) => key.toLocaleLowerCase() === property.toLocaleLowerCase(),
		);
		if (!actual) return mutation.action === "add";
		const stored = frontmatter[actual];
		if (!Array.isArray(stored)) return false;
		if (mutation.action === "add") return true;
		return (
			sameMetadataValue(stored[mutation.index], mutation.value) ||
			stored.some((item) => sameMetadataValue(item, mutation.value))
		);
	}

	private writeTag(action: "add" | "remove", tag: string): Promise<void> {
		if (!this.tagWriteNeeded(action, tag)) return Promise.resolve();
		return this.enqueueMetadataWrite(`${action} tag ${tag}`, (frontmatter) => {
			const actual = Object.keys(frontmatter).find((key) => key.toLocaleLowerCase() === "tags");
			const target = tag.toLocaleLowerCase();
			if (!actual) {
				if (action === "add") frontmatter.tags = [tag];
				return;
			}

			const stored = frontmatter[actual];
			if (Array.isArray(stored)) {
				if (action === "add") {
					if (!stored.some((value) => storedTagMatches(value, target))) stored.push(tag);
				} else {
					for (let index = stored.length - 1; index >= 0; index--) {
						if (storedTagMatches(stored[index], target)) stored.splice(index, 1);
					}
					if (!stored.length) delete frontmatter[actual];
				}
				return;
			}

			if (action === "add") {
				if (!storedTagMatches(stored, target)) frontmatter[actual] = [stored, tag];
			} else if (storedTagMatches(stored, target)) {
				delete frontmatter[actual];
			}
		});
	}

	private tagWriteNeeded(action: "add" | "remove", tag: string): boolean {
		const frontmatter = this.parseFrontmatter(this.latestContent);
		const actual = Object.keys(frontmatter).find((key) => key.toLocaleLowerCase() === "tags");
		if (!actual) return action === "add";
		const stored = frontmatter[actual];
		const target = tag.toLocaleLowerCase();
		const present = Array.isArray(stored)
			? stored.some((value) => storedTagMatches(value, target))
			: storedTagMatches(stored, target);
		return action === "add" ? !present : present;
	}

	private enqueueMetadataWrite(
		description: string,
		mutate: (frontmatter: Record<string, unknown>) => void,
	): Promise<void> {
		const file = this.file;
		if (!file) return Promise.resolve();
		const operation = this.metadataWrites.then(async () => {
			await this.host.app.fileManager.processFrontMatter(file, mutate);
			const content = await this.host.app.vault.read(file);
			if (!this.destroyed && this.file === file) this.applyExternalContent(content);
		});
		const handled = operation.catch(async (error: unknown) => {
			console.error(`Journal View: could not ${description} in ${file.path}`, error);
			new Notice(`Journal View: could not ${description}`);
			if (this.destroyed || this.file !== file) return;
			try {
				this.applyExternalContent(await this.host.app.vault.read(file));
			} catch {
				// The original error is the useful one; a failed recovery read adds nothing.
			}
		});
		this.metadataWrites = handled;
		return handled;
	}

	private parseFrontmatter(content: string): Record<string, unknown> {
		const info = getFrontMatterInfo(content);
		if (!info.exists) return {};
		try {
			const parsed: unknown = parseYaml(info.frontmatter);
			return isRecord(parsed) ? parsed : {};
		} catch (error) {
			console.warn(`Journal View: could not parse properties for ${this.path}`, error);
			return {};
		}
	}

	private frontmatterTags(frontmatter: Record<string, unknown>): string[] {
		let parsed: string[] | null;
		try {
			const key = Object.keys(frontmatter).find((name) => name.toLocaleLowerCase() === "tags");
			parsed = key ? parseFrontMatterTags({ tags: frontmatter[key] }) : [];
		} catch (error) {
			console.warn(`Journal View: could not parse tags for ${this.path}`, error);
			return [];
		}
		const tags: string[] = [];
		const seen = new Set<string>();
		for (const rawTag of parsed ?? []) {
			const tag = rawTag.trim().replace(/^#+/, "");
			const key = tag.toLocaleLowerCase();
			if (!tag || seen.has(key)) continue;
			seen.add(key);
			tags.push(tag);
		}
		return tags;
	}

	private async deleteNote(): Promise<void> {
		await this.flush(true);
		if (this.queue.hasPending) return; // the failed save already showed a notice

		const file = this.file;
		if (!file) return;

		try {
			const fileManager = this.host.app.fileManager;
			if (!(await fileManager.promptForDeletion(file))) return;
			// Honor the user's configured trash destination.
			await fileManager.trashFile(file);
		} catch (error) {
			console.error(`Journal View: could not delete ${file.path}`, error);
			new Notice(`Journal View: could not delete ${file.path}`);
		}
	}

	/** Recomputes the expected path, e.g. after the date format changed. */
	revalidate(): void {
		const path = this.host.plugin.daily.pathFor(this.date);
		const file = this.host.plugin.daily.fileFor(this.date);
		const changed = path !== this.path || file !== this.file;
		this.path = path;
		this.file = file;
		if (changed) {
			this.editor?.setFile(file);
			this.refreshState();
			void this.reload();
		}
	}

	setFile(file: TFile | null): void {
		if (this.file === file) return;
		const previousPath = this.file?.path ?? null;
		this.file = file;
		this.path = file?.path ?? this.host.plugin.daily.pathFor(this.date);
		this.editor?.setFile(file);
		this.refreshState();
		this.host.onDayFileChanged(this, previousPath);
	}

	/* -------------------------------------------------------------- preview */

	get hasFocus(): boolean {
		const active = this.metadataEl.ownerDocument.activeElement;
		return this.focused || (this.editor?.hasFocus() ?? false) || (!!active && this.metadataEl.contains(active));
	}

	get isDirty(): boolean {
		if (this.queue.hasPending) return true;
		if (!this.editor) return false;
		const value = this.editor.getValue();
		// An untouched template offer is not the reader's work, so it must not
		// pin the day to edit mode or fend off content arriving from the vault.
		if (value === this.pendingTemplate) return false;
		return value !== editorBody(this.lastKnownContent);
	}

	/** The body as the reader sees it, including edits not yet written to disk. */
	searchText(): string {
		return this.editor?.getValue() ?? editorBody(this.lastKnownContent);
	}

	setFindState(
		query: string,
		caseSensitive: boolean,
		ranges: FindRange[],
		selected: FindRange | null,
	): void {
		const current = this.findState;
		if (
			current &&
			current.query === query &&
			current.caseSensitive === caseSensitive &&
			sameFindRanges(current.ranges, ranges)
		) {
			// Loaded-window refreshes first publish ranges without an active
			// result. Preserve the current one until the controller resolves it.
			if (selected !== null && !sameFindRange(current.selected, selected)) {
				current.selected = selected;
				this.applyFindState();
			}
			return;
		}
		this.findState = { query, caseSensitive, ranges, selected };
		this.applyFindState();
	}

	selectFindRange(selected: FindRange | null): void {
		if (!this.findState) return;
		if (sameFindRange(this.findState.selected, selected)) return;
		this.findState.selected = selected;
		this.applyFindState();
	}

	clearFindState(): void {
		this.findState = null;
		this.editor?.clearFindMatches();
		this.clearPreviewFindMarks();
	}

	revealFindRange(range: FindRange): void {
		this.applyFindState();
		this.editor?.revealRange(range);
	}

	/** Reads the day's note; days without a note are simply empty. */
	async readContent(): Promise<string> {
		if (!this.file) return "";
		try {
			return await this.host.app.vault.cachedRead(this.file);
		} catch (error) {
			console.error(`Journal View: could not read ${this.path}`, error);
			return "";
		}
	}

	/**
	 * Reads the note and renders its preview. The view awaits this before the
	 * day enters the DOM, so a day is always inserted at its full height.
	 */
	async prepare(): Promise<void> {
		const content = await this.readContent();
		if (this.destroyed) return;
		this.lastKnownContent = content;
		this.refreshMetadata(content);
		await this.renderPreview(content);
	}

	/** Renders `content` into a fresh preview container, off-DOM. */
	private async buildPreview(content: string): Promise<{ component: Component; container: HTMLElement } | null> {
		const component = new Component();
		component.load();
		const container = createDiv({ cls: "journal-day-preview markdown-rendered" });
		const body = noteBody(content);
		try {
			await MarkdownRenderer.render(this.host.app, body, container, this.path, component);
		} catch (error) {
			console.error(`Journal View: could not render ${this.path}`, error);
			container.setText(body);
		}
		if (this.destroyed) {
			component.unload();
			return null;
		}
		return { component, container };
	}

	/** Swaps whatever the body holds for `built`, in one synchronous step. */
	private applyPreview(built: { component: Component; container: HTMLElement }, content: string): void {
		this.editor?.destroy();
		this.editor = null;
		this.previewComponent?.unload();
		this.previewComponent = built.component;
		this.bodyEl.empty();
		this.releaseHeight();
		this.el.removeClass("journal-day-editing");
		this.bodyEl.appendChild(built.container);
		this.el.toggleClass("journal-day-blank", noteBody(content).trim().length === 0);
		this.applyFindState();
	}

	private applyFindState(): void {
		const state = this.findState;
		if (!state || !state.query) {
			this.editor?.clearFindMatches();
			this.clearPreviewFindMarks();
			return;
		}
		if (this.editor) {
			this.clearPreviewFindMarks();
			this.editor.setFindMatches(state.ranges, state.selected);
			return;
		}
		this.highlightPreview(state.query, state.caseSensitive);
	}

	/** Highlights rendered preview text without changing Markdown structure. */
	private highlightPreview(query: string, caseSensitive: boolean): void {
		this.clearPreviewFindMarks();
		const preview = this.bodyEl.querySelector<HTMLElement>(".journal-day-preview");
		if (!preview || !query) return;
		const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let node = walker.nextNode();
		while (node) {
			if (node.nodeType === Node.TEXT_NODE && node.nodeValue) nodes.push(node as Text);
			node = walker.nextNode();
		}
		for (const textNode of nodes) {
			const ranges = findLiteralRanges(textNode.data, query, caseSensitive);
			if (!ranges.length || !textNode.parentNode) continue;
			const fragment = createFragment();
			let cursor = 0;
			for (const range of ranges) {
				if (range.from > cursor) fragment.appendText(textNode.data.slice(cursor, range.from));
				fragment.createEl("mark", {
					cls: "journal-find-match",
					text: textNode.data.slice(range.from, range.to),
				});
				cursor = range.to;
			}
			if (cursor < textNode.data.length) fragment.appendText(textNode.data.slice(cursor));
			textNode.replaceWith(fragment);
		}
	}

	private clearPreviewFindMarks(): void {
		const parents = new Set<Node>();
		for (const mark of Array.from(this.bodyEl.querySelectorAll("mark.journal-find-match"))) {
			if (!mark.closest(".journal-day-preview")) continue;
			const parent = mark.parentNode;
			if (parent) parents.add(parent);
			mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
		}
		for (const parent of parents) parent.normalize();
	}

	private async renderPreview(content: string): Promise<void> {
		if (this.destroyed || this.editor) return;
		const token = ++this.modeToken;
		const built = await this.buildPreview(content);
		if (!built) return;
		if (token !== this.modeToken || this.editor) {
			// An editor was mounted while the preview rendered; theirs wins.
			built.component.unload();
			return;
		}
		this.applyPreview(built, content);
	}

	/* -------------------------------------------------------------- editing */

	/**
	 * Swaps the preview for a live editor, without taking focus. The view
	 * mounts editors ahead of the reader, so by the time a day is close enough
	 * to click it is already one.
	 *
	 * The preview height stays in place through the editor's first measurement,
	 * preventing a half-laid-out frame without leaving a stale minimum height
	 * behind for the reader to release with their first click.
	 */
	mountEditor(): void {
		if (this.destroyed || this.editor) return;
		this.modeToken++;
		this.pendingTemplate = null;
		this.heldHeight = this.bodyEl.offsetHeight;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.bodyEl.empty();
		if (this.heldHeight > 0) this.bodyEl.setCssProps({ "--journal-held-height": `${this.heldHeight}px` });
		this.el.addClass("journal-day-editing");
		const body = editorBody(this.lastKnownContent);
		const placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		const token = this.modeToken;
		try {
			this.editor = createJournalEditor(
				{
					app: this.host.app,
					leaf: this.host.leaf,
					workspaceEditors: this.host.plugin.workspaceEditors,
					container: this.bodyEl,
					value: body,
					placeholder,
					file: this.file,
					onReady: () => {
						if (this.destroyed || token !== this.modeToken) return;
						this.releaseHeight();
					},
					onChange: () => {
						this.releaseHeight();
						this.updateBlankState();
						this.scheduleSave();
						this.host.onDayContentChanged(this);
					},
					onFocus: () => this.onEditorFocus(),
					onBlur: () => this.onEditorBlur(),
					onFind: () => this.host.showFind(),
				},
				this.host.plugin.settings.richEditor,
			);
		} catch (error) {
			// The day has already given up its preview; put one back rather
			// than leave it blank.
			console.error(`Journal View: could not open an editor for ${this.path}`, error);
			this.el.removeClass("journal-day-editing");
			this.bodyEl.empty();
			void this.renderPreview(this.lastKnownContent);
			return;
		}
		this.updateBlankState();
		this.applyFindState();
	}

	/**
	 * Returns a day to a static preview. Only ever called for days far off
	 * screen, and never for one that is being written in - the preview is
	 * built from the content on disk, so anything unsaved would be lost.
	 */
	async unmountEditor(): Promise<void> {
		if (this.destroyed || !this.editor || this.unmounting) return;
		if (this.hasFocus || this.isDirty) return;
		const content = this.lastKnownContent;
		const token = ++this.modeToken;
		this.unmounting = true;
		try {
			// Built while the editor still stands, then swapped in one step, so
			// the day never spends a frame at zero height.
			const built = await this.buildPreview(content);
			if (!built) return;
			// Rendering takes long enough for the day to have been scrolled back
			// into sight, or for the note to have changed under it. Either way
			// this preview is not the one to show; the day stays an editor and
			// the view asks again when it is out of sight.
			const stale =
				token !== this.modeToken ||
				this.hasFocus ||
				this.lastKnownContent !== content ||
				!this.host.isOffScreen(this);
			if (stale) {
				built.component.unload();
				return;
			}
			this.applyPreview(built, content);
		} finally {
			this.unmounting = false;
		}
	}

	/** Lets the day's height follow the editor again. */
	private releaseHeight(): void {
		if (this.heldHeight === 0) return;
		this.heldHeight = 0;
		this.bodyEl.setCssProps({ "--journal-held-height": "0px" });
	}

	private onEditorFocus(): void {
		this.focused = true;
		// Measurement should normally have released the guard before the
		// reader arrives; focus is the defensive fallback.
		this.releaseHeight();
		this.el.addClass("journal-day-focused");
		// Focus is the one signal every way in shares - a click the editor
		// swallowed, a keyboard tab, or a jump to a date.
		this.scheduleFocusSettled();
	}

	private scheduleFocusSettled(): void {
		const token = ++this.focusSettleToken;
		void this.reportFocusSettled(token);
	}

	/** Waits through template insertion, editor measurement and cursor reveal. */
	private async reportFocusSettled(token: number): Promise<void> {
		await this.offerTemplate();
		for (let frame = 0; frame < REVEAL_FRAMES + 2; frame++) {
			await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		}
		if (this.destroyed || token !== this.focusSettleToken || !this.hasFocus) return;
		this.host.onDayFocusSettled(this);
	}

	/** Blurring an editor is not leaving the day, but it is a good time to save. */
	private onEditorBlur(): void {
		this.focusSettleToken++;
		this.focused = false;
		this.el.removeClass("journal-day-focused");
		// Leaving a day the reader only looked at costs them nothing.
		if (this.withdrawTemplate()) return;
		void this.flush();
	}

	/**
	 * The rich editor has no placeholder of its own, so the empty-state hint is
	 * drawn by the stylesheet whenever this class is present.
	 */
	private updateBlankState(): void {
		const blank = !!this.editor && this.editor.rich && this.editor.getValue().length === 0;
		this.el.toggleClass("journal-day-blank", blank);
	}

	/**
	 * Puts the reader in the day's editor. `atEnd` puts the cursor past
	 * everything the day already holds, which is where writing carries on -
	 * asked for by the two ways of arriving at today, opening the journal on it
	 * and coming home to it. Every other way in leaves the cursor where focus
	 * put it: a day reached by date is one to read as much as to write in, and
	 * find needs the cursor on the match it just revealed.
	 * Returns false when the guarded editor mount failed.
	 */
	focusEditor(atEnd = false): boolean {
		this.mountEditor();
		if (!this.editor) return false;
		this.editor.focus();
		if (atEnd) {
			this.editor.placeCursorAtEnd?.(true);
			this.keepCursorInView();
		}
		// `focus()` emits nothing when this editor already owns focus. Navigation
		// still needs a fresh measurement after it has returned from far offscreen.
		this.scheduleFocusSettled();
		return true;
	}

	/**
	 * Holds a cursor placed at the end on screen over the frames that follow.
	 *
	 * Arriving at a day is the view's own scroll: it centres the day, releases
	 * the height its preview was held at, and on a go-to may have rebuilt the
	 * window first. Any of that lands after the editor works out where its
	 * cursor should be scrolled to, and overwrites it - on a long note that
	 * leaves the reader looking at the top of a day whose cursor is at the
	 * bottom. Asking again over the following frames outlives the positioning.
	 *
	 * None of that is worth a single frame of holding the journal against the
	 * reader, so their first move on it ends the run: a wheel, a touch drag or
	 * a pointer in the scroller - a scrollbar drag, or a click that puts the
	 * cursor somewhere they chose - and the view stays where they put it.
	 */
	private keepCursorInView(): void {
		this.stopRevealing();
		const scroller: EventTarget = this.el.closest(".journal-scroll") ?? this.el.ownerDocument;
		const surrender = (): void => this.stopRevealing(true);
		this.endReveal = listenForReaderScrollIntent(scroller, surrender);

		let frames = REVEAL_FRAMES;
		const step = (): void => {
			this.revealFrame = 0;
			if (this.destroyed || !this.editor?.hasFocus() || --frames < 0) {
				this.stopRevealing();
				return;
			}
			this.editor.revealCursor?.();
			this.revealFrame = window.requestAnimationFrame(step);
		};
		this.revealFrame = window.requestAnimationFrame(step);
	}

	/**
	 * Ends a reveal run, whether it ran out of frames or the reader took over.
	 * `withdraw` also takes back the reveal the last frame asked for, which is
	 * carried out a frame later and would otherwise undo their scroll once.
	 */
	private stopRevealing(withdraw = false): void {
		window.cancelAnimationFrame(this.revealFrame);
		this.revealFrame = 0;
		this.endReveal?.();
		this.endReveal = null;
		if (withdraw) this.editor?.cancelReveal?.();
	}

	/** Applies a change that happened outside the journal (sync, another tab). */
	applyExternalContent(content: string): void {
		// Frontmatter can safely update while a dirty body waits to save: the body
		// conflict guard below remains in force, while the metadata strip reflects
		// the newest complete file immediately.
		this.refreshMetadata(content);
		if (!this.editor) {
			this.lastKnownContent = content;
			this.externalReloadPending = false;
			this.host.onDayContentChanged(this);
			return;
		}
		const body = editorBody(content);
		if (this.editor.getValue() === body) {
			this.lastKnownContent = content;
			this.externalReloadPending = false;
			return;
		}
		if (this.isDirty) {
			// A metadata event held off by our pending save is not replayed. Retry
			// once the queue settles so the editor reflects whichever write won.
			this.externalReloadPending = true;
			return;
		}

		this.pendingTemplate = null;
		this.editor.setValue(body, true);
		this.lastKnownContent = content;
		this.externalReloadPending = false;
		// The held height belongs to content that is no longer what the day
		// holds; the editor's own height is the honest one now.
		this.releaseHeight();
		this.updateBlankState();
		this.host.onDayContentChanged(this);
	}

	/** Brings the day up to date with the note's current content on disk. */
	async reload(knownContent?: string): Promise<void> {
		const content = knownContent ?? (await this.readContent());
		if (this.destroyed) return;
		this.refreshMetadata(content);
		if (this.editor) {
			this.applyExternalContent(content);
			return;
		}
		if (content === this.lastKnownContent && this.previewComponent) return;
		this.lastKnownContent = content;
		await this.renderPreview(content);
		this.host.onDayContentChanged(this);
	}

	/* ---------------------------------------------------------------- saving */

	private scheduleSave(): void {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flush(), this.host.plugin.settings.saveDelay);
	}

	/**
	 * Hands the editor's current text to the save queue. Once submitted the
	 * text no longer depends on the editor, so the day is free to be destroyed.
	 */
	private capture(): void {
		if (!this.editor) return;
		const body = this.editor.getValue();
		if (body === this.pendingTemplate) return; // an offer nobody accepted
		this.pendingTemplate = null;
		if (body !== editorBody(this.lastKnownContent)) void this.queue.submit(body);
	}

	async flush(commitMetadataDraft = false): Promise<void> {
		window.clearTimeout(this.saveTimer);
		if (commitMetadataDraft && this.propertyEdit) this.commitPropertyEdit(this.propertyEdit);
		this.capture();
		await Promise.all([this.queue.settled(), this.metadataWrites]);
		if (!this.destroyed && this.externalReloadPending && !this.isDirty) await this.reload();
	}

	private async writeValue(body: string): Promise<boolean> {
		try {
			let file = this.file;
			if (!file) {
				// An untouched placeholder must not litter the vault with empty notes.
				if (!body.trim()) {
					this.lastKnownContent = body;
					return true;
				}
				// Created from the template, then written over below: the reader
				// is already typing into the template's body, and going through
				// it here is what carries its frontmatter onto the new note.
				file = await this.host.plugin.daily.create(this.date);
				this.setFile(file);
			}
			// The callback receives the latest vault content, so frontmatter changes
			// made by Properties, Sync, or another view are not overwritten.
			this.lastKnownContent = await this.host.app.vault.process(file, (content) =>
				replaceNoteBody(content, body),
			);
			this.refreshMetadata(this.lastKnownContent);
			return true;
		} catch (error) {
			console.error(`Journal View: could not save ${this.path}`, error);
			new Notice(`Journal View: could not save ${this.path}`);
			return false;
		}
	}

	private async createNow(): Promise<void> {
		if (this.file) return;
		try {
			const file = await this.host.plugin.daily.create(this.date);
			this.setFile(file);
			await this.reload();
			this.focusEditor();
		} catch (error) {
			console.error(`Journal View: could not create ${this.path}`, error);
			new Notice(`Journal View: could not create ${this.path}`);
		}
	}

	private async openInTab(newTab: boolean): Promise<void> {
		let file = this.file;
		if (!file) {
			try {
				file = await this.host.plugin.daily.create(this.date);
				this.setFile(file);
			} catch (error) {
				console.error(`Journal View: could not create ${this.path}`, error);
				return;
			}
		}
		await this.host.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	destroy(): void {
		this.destroyed = true;
		this.focusSettleToken++;
		window.clearTimeout(this.saveTimer);
		this.tagPointerCleanup?.();
		this.tagPointerCleanup = null;
		this.tagSuggestionPointerDown = false;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.propertyEdit = null;
		this.propertyListEdit = null;
		this.tagEdit = null;
		this.stopRevealing();
		// Anything unsaved goes to the queue, which outlives this object.
		this.capture();
		this.clearFindState();
		this.editor?.destroy();
		this.editor = null;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.el.remove();
	}
}
