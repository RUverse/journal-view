import { Component, MarkdownRenderer, Modal, Platform, TFile, setIcon, setTooltip } from "obsidian";
import type { App } from "obsidian";
import { openFileInTab } from "../entry";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import { noteBody } from "../noteBody";
import { parseConversation, questionQuote } from "./conversation";
import type { ReflectionRun } from "./runner";
import type { StoredReflection } from "./store";

/** What a reflection card needs from the day it sits in. */
export interface ReflectionCardHost {
	app: App;
	plugin: JournalViewPlugin;
	/** Moves the journal to the note a citation names, rather than opening it elsewhere. */
	revealNote(path: string): void;
}

/**
 * What a card shows: a saved reflection note, perhaps with a regenerate or a
 * follow-up writing back to it, or a new reflection being written.
 */
export type ReflectionCardSource = { stored: StoredReflection; run: ReflectionRun | null } | { run: ReflectionRun };

/** Matches a card to its note or run across refreshes. */
export function reflectionIdentity(source: ReflectionCardSource): string {
	return "stored" in source ? `file:${source.stored.file.path}` : `run:${source.run.id}`;
}

/** Streamed text is rendered at most this often; it arrives far faster. */
const RENDER_INTERVAL = 250;

/**
 * Renders Markdown into an element: skeleton lines until there is text, then
 * the text as it streams, a few times a second, and never the same text twice.
 */
class MarkdownPane {
	/** What the element last rendered, so unchanged text is not drawn again. */
	private rendered = "";
	private timer = 0;
	private destroyed = false;

	constructor(
		readonly el: HTMLElement,
		private app: App,
		private component: Component,
	) {}

	async show(markdown: string, sourcePath: string): Promise<void> {
		this.cancel();
		if (markdown === this.rendered) return;
		this.rendered = markdown;
		const target = createDiv();
		try {
			await MarkdownRenderer.render(this.app, markdown, target, sourcePath, this.component);
		} catch (error) {
			console.error("Journal View: could not render a reflection", error);
			target.setText(markdown);
		}
		if (this.destroyed || this.rendered !== markdown) return;
		this.el.empty();
		this.el.append(...Array.from(target.childNodes));
	}

	/** Renders streamed text a few times a second; `text` is read when the time comes. */
	stream(text: () => string, sourcePath: string): void {
		if (this.timer) return;
		const first = !this.rendered;
		this.timer = window.setTimeout(
			() => {
				this.timer = 0;
				if (!this.destroyed) void this.show(text(), sourcePath);
			},
			first ? 0 : RENDER_INTERVAL,
		);
		if (first) this.el.empty();
	}

	skeleton(): void {
		this.cancel();
		if (this.el.querySelector(".journal-reflection-skeleton")) return;
		this.rendered = "";
		this.el.empty();
		const skeleton = this.el.createDiv({ cls: "journal-reflection-skeleton", attr: { "aria-hidden": "true" } });
		for (let line = 0; line < 3; line++) skeleton.createDiv({ cls: "journal-reflection-skeleton-line" });
	}

	clear(): void {
		this.cancel();
		this.rendered = "";
		this.el.empty();
	}

	/** Drops a render still waiting, before something else is shown. */
	cancel(): void {
		window.clearTimeout(this.timer);
		this.timer = 0;
	}

	destroy(): void {
		this.destroyed = true;
		this.cancel();
	}
}

/**
 * One reflection under its day: a bordered box with no fill, so it never
 * reads as a note. It shows a saved reflection note read-only, with
 * Regenerate, Delete, the notes it read, and a box for follow-ups; or a
 * reflection being written - skeleton lines until the first words arrive,
 * then the text as it streams, with Stop.
 */
export class ReflectionCard {
	readonly el: HTMLElement;
	private readonly component = new Component();
	private titleEl: HTMLElement;
	private actionsEl: HTMLElement;
	private statusEl: HTMLElement;
	private body: MarkdownPane;
	/** A follow-up being asked: its question, its state, and its answer as it streams. */
	private followUpEl: HTMLElement;
	private question: MarkdownPane;
	private followUpStatusEl: HTMLElement;
	private followUpStatusText: HTMLElement;
	private followUpActionsEl: HTMLElement;
	private answer: MarkdownPane;
	private footerEl: HTMLElement;
	private sourcesEl: HTMLElement;
	private sourcesOpen = false;
	private askEl: HTMLElement;
	private askInput: HTMLTextAreaElement;
	/**
	 * What the title, the footer and each row of buttons were last drawn for.
	 * A card is updated every frame while text streams in; drawn again each
	 * time, a button would be replaced between the press and the release of a
	 * click, which is then lost.
	 */
	private drawn = new Map<HTMLElement, string>();
	/** Moves on whenever the body is given something else to show, so a slow read of the note cannot overwrite it. */
	private bodyVersion = 0;
	private destroyed = false;

	constructor(
		private host: ReflectionCardHost,
		private source: ReflectionCardSource,
	) {
		this.component.load();
		const { app } = host;
		this.el = createDiv({ cls: "journal-reflection" });
		const header = this.el.createDiv({ cls: "journal-reflection-header" });
		this.titleEl = header.createDiv({ cls: "journal-reflection-title" });
		this.actionsEl = header.createDiv({ cls: "journal-reflection-actions" });
		this.statusEl = this.el.createDiv({ cls: "journal-reflection-status" });
		this.body = new MarkdownPane(
			this.el.createDiv({ cls: "journal-reflection-body markdown-rendered" }),
			app,
			this.component,
		);

		this.followUpEl = this.el.createDiv({ cls: "journal-reflection-follow-up" });
		this.question = new MarkdownPane(
			this.followUpEl.createDiv({ cls: "journal-reflection-question markdown-rendered" }),
			app,
			this.component,
		);
		this.followUpStatusEl = this.followUpEl.createDiv({ cls: "journal-reflection-follow-up-status" });
		this.followUpStatusText = this.followUpStatusEl.createSpan({ cls: "journal-reflection-follow-up-line" });
		this.followUpActionsEl = this.followUpStatusEl.createDiv({ cls: "journal-reflection-follow-up-actions" });
		this.answer = new MarkdownPane(
			this.followUpEl.createDiv({ cls: "journal-reflection-body markdown-rendered" }),
			app,
			this.component,
		);

		this.footerEl = this.el.createDiv({ cls: "journal-reflection-footer" });
		this.sourcesEl = this.el.createDiv({ cls: "journal-reflection-sources" });
		this.askEl = this.el.createDiv({ cls: "journal-reflection-ask" });
		this.askInput = this.askEl.createEl("textarea", {
			cls: "journal-reflection-ask-input",
			attr: { rows: "1", placeholder: "Ask a follow-up…", "aria-label": "Ask a follow-up" },
		});
		this.askInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			this.askFollowUp();
		});
		this.askInput.addEventListener("input", () => this.fitAsk());
		const send = this.askEl.createEl("button", {
			cls: "clickable-icon journal-reflection-ask-send",
			attr: { "aria-label": "Ask" },
		});
		setIcon(send, "corner-down-left");
		setTooltip(send, "Ask");
		send.addEventListener("click", () => this.askFollowUp());

		this.el.addEventListener("click", (event) => this.onLinkClick(event));
		this.update(source);
	}

	/** The saved note or run this card shows, to match it on the next refresh. */
	get identity(): string {
		return reflectionIdentity(this.source);
	}

	/** True while a reflection, a new answer or a follow-up is being written into the card. */
	get writing(): boolean {
		const { run } = this.source;
		return run !== null && run.status !== "failed";
	}

	/** Brings the card up to date with its note or run. */
	update(source: ReflectionCardSource): void {
		this.source = source;
		if (!("stored" in source)) this.showRun(source.run, null);
		else if (!source.run) this.showStored(source.stored);
		else if (source.run.kind === "follow-up") this.showFollowUp(source.stored, source.run);
		else this.showRun(source.run, source.stored);
	}

	destroy(): void {
		this.destroyed = true;
		this.body.destroy();
		this.question.destroy();
		this.answer.destroy();
		this.component.unload();
		this.el.remove();
	}

	/* --------------------------------------------------------------- stored */

	private showStored(reflection: StoredReflection): void {
		this.setState(null);
		this.setTitle(reflection.title);
		this.draw(this.actionsEl, "stored", () => {
			// As on a note, what changes the reflection shows only while its header is hovered.
			if (Platform.isDesktop) {
				this.addAction(this.actionsEl, "refresh-cw", "Regenerate reflection", () => void this.regenerate(), true);
			}
			this.addAction(
				this.actionsEl,
				"trash-2",
				"Delete reflection",
				() => {
					if ("stored" in this.source) void this.host.plugin.reflections.delete(this.source.stored.file);
				},
				true,
			);
			this.addOpenAction();
		});
		this.statusEl.hidden = true;
		this.hideFollowUp();
		this.renderFooter(reflection);
		// Asking needs the model server, which reflections only reach on desktop.
		this.askEl.hidden = !Platform.isDesktop;
		void this.renderStoredBody(reflection.file);
	}

	private async renderStoredBody(file: TFile): Promise<void> {
		this.body.cancel();
		const version = ++this.bodyVersion;
		let text: string;
		try {
			text = await this.host.app.vault.cachedRead(file);
		} catch (error) {
			console.error(`Journal View: could not read ${file.path}`, error);
			return;
		}
		if (this.destroyed || version !== this.bodyVersion) return;
		await this.body.show(noteBody(text), file.path);
	}

	/** Asks first when the new answer would clear follow-ups. */
	private async regenerate(): Promise<void> {
		if (!("stored" in this.source) || this.source.run) return;
		const reflection = this.source.stored;
		const { app, plugin } = this.host;
		let followUps = 0;
		try {
			const body = noteBody(await app.vault.cachedRead(reflection.file));
			followUps = parseConversation(body, reflection.followUps).followUps.length;
		} catch (error) {
			console.error(`Journal View: could not read ${reflection.file.path}`, error);
		}
		if (followUps && !(await confirmRegenerate(app, followUps))) return;
		if (!this.destroyed) plugin.reflectionRuns.regenerate(reflection);
	}

	private askFollowUp(): void {
		if (!("stored" in this.source) || this.source.run) return;
		const question = this.askInput.value.trim();
		if (!question) return;
		this.askInput.value = "";
		this.fitAsk();
		this.host.plugin.reflectionRuns.followUp(this.source.stored, question);
	}

	/** Grows the follow-up box with what is typed, up to a few lines. */
	private fitAsk(): void {
		this.askInput.setCssProps({ "--journal-reflection-ask-height": "auto" });
		this.askInput.setCssProps({ "--journal-reflection-ask-height": `${this.askInput.scrollHeight}px` });
	}

	/* ------------------------------------------------------------- sources */

	/** "From 9 notes · 5–19 Oct · gemma4:26b", which opens into the dates it read. */
	private renderFooter(reflection: StoredReflection): void {
		const { file, sources, from, to, model } = reflection;
		this.draw(this.footerEl, JSON.stringify([file.path, sources, from, to, model]), () => this.drawFooter(reflection));
	}

	private drawFooter(reflection: StoredReflection): void {
		this.sourcesEl.empty();
		const notes = this.sourceNotes(reflection);
		const parts: string[] = [];
		if (notes.length) parts.push(`From ${notes.length} ${notes.length === 1 ? "note" : "notes"}`);
		const span = spanLabel(reflection.from, reflection.to);
		if (span) parts.push(span);
		if (reflection.model) parts.push(reflection.model);
		this.footerEl.hidden = parts.length === 0;
		if (!notes.length) {
			this.footerEl.setText(parts.join(" · "));
			this.sourcesOpen = false;
			this.sourcesEl.hidden = true;
			return;
		}
		const toggle = this.footerEl.createEl("button", {
			cls: "journal-reflection-sources-toggle",
			attr: { "aria-expanded": String(this.sourcesOpen) },
		});
		toggle.createSpan({ text: parts.join(" · ") });
		setIcon(toggle.createSpan({ cls: "journal-reflection-sources-chevron" }), "chevron-right");
		toggle.addEventListener("click", () => {
			this.sourcesOpen = !this.sourcesOpen;
			toggle.setAttr("aria-expanded", String(this.sourcesOpen));
			this.sourcesEl.hidden = !this.sourcesOpen;
		});

		this.sourcesEl.hidden = !this.sourcesOpen;
		const withYear = new Set(notes.map((note) => note.key?.slice(0, 4))).size > 1;
		for (const note of notes) {
			const date = note.key ? createMoment(note.key, "YYYY-MM-DD", true) : null;
			const label = date?.isValid() ? date.format(withYear ? "D MMM YYYY" : "D MMM") : note.text;
			const chip = this.sourcesEl.createEl("button", { cls: "journal-reflection-source", text: label });
			if (!note.file) {
				chip.disabled = true;
				setTooltip(chip, `${note.text} is not in the journal`);
				continue;
			}
			setTooltip(chip, note.file.basename);
			chip.addEventListener("click", (event) => {
				// Looked up again: the note may have moved since the chip was drawn.
				const sourcePath = "stored" in this.source ? this.source.stored.file.path : "";
				const file = this.host.app.metadataCache.getFirstLinkpathDest(note.text.split("|")[0], sourcePath);
				if (file) this.openNote(file, sourcePath, event);
			});
		}
	}

	/** The notes a reflection read, by date, each with its note when it is still in the journal. */
	private sourceNotes(reflection: StoredReflection): Array<{ text: string; file: TFile | null; key: string | null }> {
		const { app, plugin } = this.host;
		const notes = reflection.sources.map((link) => {
			const text = linkText(link);
			const file = app.metadataCache.getFirstLinkpathDest(text.split("|")[0], reflection.file.path);
			const key = file ? plugin.index.keyForPath(file.path) : null;
			return { text, file: key === null ? null : file, key };
		});
		return notes.sort((left, right) => (left.key ?? left.text).localeCompare(right.key ?? right.text));
	}

	/* ------------------------------------------------------------------ run */

	/** A new reflection being written, or a new answer for `reflection`, which shows until it is done. */
	private showRun(run: ReflectionRun, reflection: StoredReflection | null): void {
		this.setState(run.status);
		this.setTitle(reflection?.title ?? run.request.title);
		this.addRunActions(this.actionsEl, run);
		this.statusEl.hidden = run.status === "writing";
		this.statusEl.setText(run.statusLine);
		this.hideFollowUp();
		this.footerEl.hidden = true;
		this.sourcesEl.hidden = true;
		// Drawn again, and shown, once the reflection is back.
		this.drawn.delete(this.footerEl);
		this.askEl.hidden = true;

		if (reflection && run.status === "failed" && !run.text) {
			// A regenerate that failed leaves the answer it was to replace.
			void this.renderStoredBody(reflection.file);
			return;
		}
		this.bodyVersion++;
		if (run.status === "reading") this.body.skeleton();
		else if (run.text) this.body.stream(() => run.text, run.target?.path ?? "");
		else this.body.clear();
	}

	/** A follow-up to `reflection` being answered, below its answer and earlier follow-ups. */
	private showFollowUp(reflection: StoredReflection, run: ReflectionRun): void {
		this.setState(null);
		this.setTitle(reflection.title);
		// Stop and the rest are by the question, near the answer they act on.
		this.draw(this.actionsEl, "follow-up", () => this.addOpenAction());
		this.statusEl.hidden = true;
		this.renderFooter(reflection);
		this.askEl.hidden = true;
		void this.renderStoredBody(reflection.file);

		this.followUpEl.hidden = false;
		this.followUpEl.toggleClass("journal-reflection-follow-up-failed", run.status === "failed");
		void this.question.show(questionQuote(run.question ?? ""), reflection.file.path);
		this.followUpStatusText.setText(run.status === "writing" ? "" : run.statusLine);
		this.addRunActions(this.followUpActionsEl, run);
		if (run.status === "reading") this.answer.skeleton();
		else if (run.text) this.answer.stream(() => run.text, reflection.file.path);
		else this.answer.clear();
	}

	/** Hides the follow-up that was being answered, which its note now holds. */
	private hideFollowUp(): void {
		if (this.followUpEl.hidden) return;
		this.followUpEl.hidden = true;
		this.draw(this.followUpActionsEl, "", () => {});
		this.question.clear();
		this.answer.clear();
	}

	/** Stop while a run goes; Try again and Dismiss once it failed. */
	private addRunActions(container: HTMLElement, run: ReflectionRun): void {
		const runner = this.host.plugin.reflectionRuns;
		const failed = run.status === "failed";
		this.draw(container, `run:${run.id}:${failed}`, () => {
			if (!failed) {
				this.addAction(container, "square", "Stop", () => runner.stop(run.id));
				return;
			}
			this.addAction(container, "rotate-ccw", "Try again", () => runner.retry(run.id));
			this.addAction(container, "x", "Dismiss", () => {
				// A follow-up that never got its answer goes back into the box.
				if (run.question && !this.askInput.value) this.askInput.value = run.question;
				runner.dismiss(run.id);
			});
		});
	}

	/* --------------------------------------------------------------- shared */

	/** Marks the card as being written, or as failed; null once it is a saved reflection. */
	private setState(status: ReflectionRun["status"] | null): void {
		this.el.toggleClass("journal-reflection-pending", status !== null && status !== "failed");
		this.el.toggleClass("journal-reflection-failed", status === "failed");
	}

	private setTitle(kind: string): void {
		this.draw(this.titleEl, kind, () => {
			this.titleEl.createSpan({ cls: "journal-reflection-label", text: "Reflection" });
			// A long question is cut to one line; its tooltip holds the rest.
			setTooltip(this.titleEl.createSpan({ cls: "journal-reflection-kind", text: kind }), kind);
		});
	}

	/** Empties `container` and fills it through `fill`, unless it was last filled for `key`. */
	private draw(container: HTMLElement, key: string, fill: () => void): void {
		if (this.drawn.get(container) === key) return;
		this.drawn.set(container, key);
		container.empty();
		fill();
	}

	/** Opens the reflection's note in a tab, as a note's own button does. */
	private addOpenAction(): void {
		this.addAction(this.actionsEl, "file-text", "Open note in a tab", (event) => {
			if ("stored" in this.source) {
				void openFileInTab(this.host.app, this.source.stored.file, event.ctrlKey || event.metaKey);
			}
		});
	}

	/** A button in the header; `headerOnly` ones show only while the header is hovered. */
	private addAction(
		container: HTMLElement,
		icon: string,
		label: string,
		onClick: (event: MouseEvent) => void,
		headerOnly = false,
	): void {
		const button = container.createEl("button", {
			cls: "clickable-icon journal-reflection-action",
			attr: { "aria-label": label },
		});
		button.toggleClass("journal-reflection-header-action", headerOnly);
		setIcon(button, icon);
		setTooltip(button, label);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			onClick(event);
		});
	}

	/** A cited note moves the journal to its day, instead of opening the note elsewhere. */
	private onLinkClick(event: MouseEvent): void {
		const link = (event.target as HTMLElement | null)?.closest("a.internal-link");
		if (!(link instanceof HTMLElement)) return;
		const href = link.dataset.href ?? link.getAttribute("href");
		if (!href) return;
		event.preventDefault();
		event.stopPropagation();
		const sourcePath = "stored" in this.source ? this.source.stored.file.path : (this.source.run.target?.path ?? "");
		const target = this.host.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
		if (target) this.openNote(target, sourcePath, event);
		else void this.host.app.workspace.openLinkText(href, sourcePath, event.ctrlKey || event.metaKey);
	}

	/** Moves the journal to a daily note; Ctrl/Cmd, or a note outside the journal, opens it in a tab. */
	private openNote(file: TFile, sourcePath: string, event: MouseEvent): void {
		const { app, plugin } = this.host;
		const newTab = event.ctrlKey || event.metaKey;
		if (!newTab && plugin.index.keyForPath(file.path) !== null) {
			this.host.revealNote(file.path);
			return;
		}
		void app.workspace.openLinkText(file.path, sourcePath, newTab);
	}
}

/** Asks before Regenerate clears a reflection's follow-ups. */
function confirmRegenerate(app: App, followUps: number): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let confirmed = false;
		modal.titleEl.setText("Regenerate this reflection?");
		const cleared = followUps === 1 ? "its follow-up" : `its ${followUps} follow-ups`;
		modal.contentEl.createEl("p", { text: `The new answer replaces this one, and ${cleared} will be cleared.` });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		const regenerate = buttons.createEl("button", { cls: "mod-warning", text: "Regenerate" });
		regenerate.addEventListener("click", () => {
			confirmed = true;
			modal.close();
		});
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		modal.onClose = () => resolve(confirmed);
		modal.open();
		regenerate.focus();
	});
}

/** The link text inside `[[…]]`. */
function linkText(link: string): string {
	return link.startsWith("[[") && link.endsWith("]]") ? link.slice(2, -2) : link;
}

/** "5–19 Oct", "19 Oct", or "19 Oct 2023 – 19 Oct" across years. */
function spanLabel(from: string | null, to: string | null): string {
	if (!from || !to) return "";
	const start = createMoment(from, "YYYY-MM-DD", true);
	const end = createMoment(to, "YYYY-MM-DD", true);
	if (!start.isValid() || !end.isValid()) return "";
	if (from === to) return end.format("D MMM");
	if (start.format("YYYY") !== end.format("YYYY")) return `${start.format("D MMM YYYY")} – ${end.format("D MMM YYYY")}`;
	return `${start.format("D MMM")} – ${end.format("D MMM")}`;
}
