import { Keymap, Menu, Notice, TFile } from "obsidian";
import type { App, HoverParent, PaneType, WorkspaceLeaf } from "obsidian";
import type { DayFile } from "./dayFiles";
import { createMoment } from "./moment";
import { applyIcon } from "./toolbar";

/** Where a hovered file's page preview comes from, as listed in the Page preview settings. */
export const FILES_HOVER_SOURCE = "journal-view";

/** Files listed before the rest wait behind "Show all". */
const LIST_LIMIT = 50;

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tif", "tiff"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "flac", "3gp", "aac", "opus"]);
const VIDEO = new Set(["mp4", "webm", "ogv", "mov", "mkv"]);

/** Icons for a file, the first this Obsidian build has being the one drawn. */
function iconsFor(extension: string): string[] {
	if (extension === "md") return ["file-text"];
	if (extension === "canvas") return ["layout-dashboard", "file"];
	if (extension === "base") return ["table", "layout-list", "file"];
	if (extension === "pdf") return ["file-text"];
	if (IMAGE.has(extension)) return ["image", "file-image", "file"];
	if (AUDIO.has(extension)) return ["file-audio", "music", "file"];
	if (VIDEO.has(extension)) return ["file-video", "film", "file"];
	return ["file"];
}

/** One drawn file, with what its time column was last drawn from. */
interface Row {
	el: HTMLElement;
	file: TFile;
	whenEl: HTMLElement;
	/** The minute shown: null for a file dated to a day without a time, undefined until drawn. */
	minute?: number | null;
	edited: boolean;
}

/** Replacing text relays out everything around it, even with the same text, so only a change is written. */
function changeText(el: HTMLElement, text: string): void {
	if (el.textContent !== text) el.setText(text);
}

function count(amount: number, what: string): string {
	return `${amount} ${amount === 1 ? what : `${what}s`}`;
}

/**
 * "3 files created · 2 last edited", or just one half when the day only has
 * that. A file only keeps its latest edit, so an edit is always its last.
 */
function summarize(files: readonly DayFile[]): string {
	const created = files.filter((item) => item.kind === "created").length;
	const edited = files.length - created;
	if (!edited) return `${count(created, "file")} created`;
	if (!created) return `${count(edited, "file")} last edited`;
	return `${count(created, "file")} created · ${edited} last edited`;
}

/** What the list at the bottom of a day needs from it. */
export interface DayFilesHost {
	app: App;
	leaf: WorkspaceLeaf;
	/** Owns the page preview a hovered file opens. */
	hoverParent: HoverParent;
	/** Whether the reader left the day's list open. */
	isFilesOpen(): boolean;
	setFilesOpen(open: boolean): void;
}

/**
 * The files from one day, at the bottom of its card: a quiet line counting
 * them, which opens into a list of links. Nothing in it is rendered as
 * Markdown, and while it is folded, files coming and going only change the
 * count, never the day's height. Clicking a file opens it, Ctrl/Cmd-clicking
 * opens it in a new tab, and right-clicking gives Obsidian's file menu.
 */
export class DayFilesList {
	readonly el: HTMLElement;
	private toggleEl: HTMLButtonElement;
	private summaryEl: HTMLElement;
	private listEl: HTMLElement;
	private rowsEl: HTMLElement;
	private moreEl: HTMLButtonElement;
	private files: readonly DayFile[] = [];
	/**
	 * The open list's rows, by how and which file they list. A day can list
	 * thousands of files once shown whole, and one of them changing only moves,
	 * adds or removes the rows it has to.
	 */
	private rows = new Map<string, Row>();
	private rowFor = new WeakMap<Element, Row>();
	private showAll = false;

	constructor(
		private host: DayFilesHost,
		parent: HTMLElement,
	) {
		this.el = parent.createDiv({ cls: "journal-day-files" });
		this.el.hidden = true;
		const heading = this.el.createDiv({ cls: "journal-day-files-heading" });
		this.toggleEl = heading.createEl("button", {
			cls: "journal-day-files-toggle",
			attr: { type: "button", "aria-expanded": "false" },
		});
		applyIcon(this.toggleEl.createSpan({ cls: "journal-day-files-chevron" }), "chevron-right");
		this.summaryEl = this.toggleEl.createSpan({ cls: "journal-day-files-summary" });
		heading.createSpan({ cls: "journal-day-files-rule" });
		this.listEl = this.el.createDiv({ cls: "journal-day-files-list" });
		this.listEl.hidden = true;
		this.rowsEl = this.listEl.createDiv({ cls: "journal-day-files-rows" });
		this.moreEl = this.listEl.createEl("button", { cls: "journal-day-files-more", attr: { type: "button" } });
		this.toggleEl.addEventListener("click", () => {
			this.host.setFilesOpen(!this.host.isFilesOpen());
			this.draw();
		});
		this.moreEl.addEventListener("click", () => {
			this.showAll = true;
			this.draw();
		});
		this.listenToRows();
	}

	/** Lists `files`, or hides the list when the day has none. */
	update(files: readonly DayFile[]): void {
		this.files = files;
		this.el.hidden = !files.length;
		changeText(this.summaryEl, files.length ? summarize(files) : "");
		this.draw();
	}

	private draw(): void {
		const open = this.host.isFilesOpen() && this.files.length > 0;
		this.toggleEl.setAttribute("aria-expanded", String(open));
		this.el.toggleClass("is-open", open);
		this.listEl.hidden = !open;
		if (!open) {
			// A folded list keeps nothing but its count.
			this.rowsEl.empty();
			this.rows.clear();
			return;
		}

		const shown = this.showAll ? this.files : this.files.slice(0, LIST_LIMIT);
		this.moreEl.hidden = shown.length === this.files.length;
		changeText(this.moreEl, `Show all ${this.files.length}`);
		// Only a day holding both kinds needs to say which is which.
		const mixed = this.files.some((item) => item.kind === "created") && this.files.some((item) => item.kind === "edited");

		// Rows no longer shown go first, so the rest are still in order and
		// only a row that is new, or moved, has to be put in place.
		const keys = shown.map((item) => `${item.kind} ${item.file.path}`);
		const wanted = new Set(keys);
		for (const [key, row] of this.rows) {
			if (wanted.has(key)) continue;
			row.el.remove();
			this.rows.delete(key);
		}
		let next = this.rowsEl.firstChild;
		shown.forEach((item, index) => {
			let row = this.rows.get(keys[index]);
			if (!row) {
				row = this.createRow(item.file);
				this.rows.set(keys[index], row);
			}
			this.drawWhen(row, item, mixed);
			if (row.el === next) next = next.nextSibling;
			else this.rowsEl.insertBefore(row.el, next);
		});
	}

	private createRow(file: TFile): Row {
		const el = createDiv({
			cls: "journal-day-file",
			attr: { role: "link", tabindex: "0", "data-path": file.path },
		});
		applyIcon(el.createSpan({ cls: "journal-day-file-icon" }), ...iconsFor(file.extension));
		el.createSpan({ cls: "journal-day-file-name", text: file.basename });
		if (file.extension !== "md") el.createSpan({ cls: "journal-day-file-extension", text: file.extension });
		const folder = file.parent && !file.parent.isRoot() ? file.parent.path : "";
		el.createSpan({ cls: "journal-day-file-folder", text: folder });
		const row: Row = { el, file, whenEl: el.createSpan({ cls: "journal-day-file-time" }), edited: false };
		this.rowFor.set(el, row);
		return row;
	}

	/** The time a file was created or last edited, marked "last edited" on a day that lists both. */
	private drawWhen(row: Row, item: DayFile, mixed: boolean): void {
		const minute = item.timed ? Math.floor(item.time / 60_000) : null;
		const edited = mixed && item.kind === "edited";
		if (row.minute === minute && row.edited === edited) return;
		row.minute = minute;
		row.edited = edited;
		row.whenEl.empty();
		if (edited) row.whenEl.createSpan({ cls: "journal-day-file-kind", text: "last edited" });
		if (item.timed) row.whenEl.appendText(createMoment(item.time).format("LT"));
	}

	/** One set of listeners for every row, however many the day lists. */
	private listenToRows(): void {
		const rowAt = (event: Event): Row | undefined => {
			const el = (event.target as HTMLElement | null)?.closest(".journal-day-file");
			return el ? this.rowFor.get(el) : undefined;
		};
		this.rowsEl.addEventListener("click", (event) => {
			const row = rowAt(event);
			if (!row) return;
			event.preventDefault();
			void this.openFile(row.file, Keymap.isModEvent(event));
		});
		this.rowsEl.addEventListener("auxclick", (event) => {
			const row = rowAt(event);
			if (!row || event.button !== 1) return;
			event.preventDefault();
			void this.openFile(row.file, "tab");
		});
		this.rowsEl.addEventListener("keydown", (event) => {
			const row = rowAt(event);
			if (!row || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			void this.openFile(row.file, Keymap.isModEvent(event));
		});
		this.rowsEl.addEventListener("mouseover", (event) => {
			const row = rowAt(event);
			if (!row) return;
			this.host.app.workspace.trigger("hover-link", {
				event,
				source: FILES_HOVER_SOURCE,
				hoverParent: this.host.hoverParent,
				targetEl: row.el,
				linktext: row.file.path,
				sourcePath: "",
			});
		});
		this.rowsEl.addEventListener("contextmenu", (event) => {
			const row = rowAt(event);
			if (row) this.showMenu(row.file, event);
		});
	}

	private async openFile(file: TFile, pane: PaneType | boolean): Promise<void> {
		try {
			await this.host.app.workspace.getLeaf(pane).openFile(file);
		} catch (error) {
			console.error(`Journal View: could not open ${file.path}`, error);
			new Notice(`Journal View: could not open ${file.path}`);
		}
	}

	/** Obsidian's own file menu, led by the ways to open the file and ending with delete. */
	private showMenu(file: TFile, event: MouseEvent): void {
		event.preventDefault();
		const menu = new Menu();
		menu.addItem((item) =>
			item.setSection("open").setTitle("Open in new tab").setIcon("file-plus")
				.onClick(() => void this.openFile(file, "tab")),
		);
		menu.addItem((item) =>
			item.setSection("open").setTitle("Open to the right").setIcon("separator-vertical")
				.onClick(() => void this.openFile(file, "split")),
		);
		this.host.app.workspace.trigger("file-menu", menu, file, FILES_HOVER_SOURCE, this.host.leaf);
		menu.addItem((item) =>
			item.setSection("danger").setTitle("Delete").setIcon("trash-2").setWarning(true)
				.onClick(() => void this.deleteFile(file)),
		);
		menu.showAtMouseEvent(event);
	}

	private async deleteFile(file: TFile): Promise<void> {
		try {
			// Asks first if the reader wants to be asked, then moves the file to
			// the trash they chose - the same as deleting it anywhere in Obsidian.
			await this.host.app.fileManager.promptForDeletion(file);
		} catch (error) {
			console.error(`Journal View: could not delete ${file.path}`, error);
			new Notice(`Journal View: could not delete ${file.path}`);
		}
	}
}
