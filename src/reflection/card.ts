import { Component, MarkdownRenderer, TFile, setIcon, setTooltip } from "obsidian";
import type { App } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { ReflectionRun } from "./runner";
import type { StoredReflection } from "./store";

/** What a reflection card needs from the day it sits in. */
export interface ReflectionCardHost {
	app: App;
	plugin: JournalViewPlugin;
	/** Moves the journal to the note a citation names, rather than opening it elsewhere. */
	revealNote(path: string): void;
}

/** What a card shows: a saved reflection note, or a reflection being written. */
export type ReflectionCardSource = { stored: StoredReflection } | { run: ReflectionRun };

/** Matches a card to its note or run across refreshes. */
export function reflectionIdentity(source: ReflectionCardSource): string {
	return "stored" in source ? `file:${source.stored.file.path}` : `run:${source.run.id}`;
}

/** Streamed text is rendered at most this often; it arrives far faster. */
const RENDER_INTERVAL = 250;

/**
 * One reflection under its day: a bordered box with no fill, so it never
 * reads as a note. It shows a saved reflection note read-only, or a
 * reflection being written - skeleton lines until the first words arrive,
 * then the text as it streams, with Stop.
 */
export class ReflectionCard {
	readonly el: HTMLElement;
	private readonly component = new Component();
	private titleEl: HTMLElement;
	private actionsEl: HTMLElement;
	private statusEl: HTMLElement;
	private bodyEl: HTMLElement;
	private footerEl: HTMLElement;
	/** What the body last rendered, so an unchanged reflection is not drawn again. */
	private rendered = "";
	private renderTimer = 0;
	private destroyed = false;

	constructor(
		private host: ReflectionCardHost,
		private source: ReflectionCardSource,
	) {
		this.component.load();
		this.el = createDiv({ cls: "journal-reflection" });
		const header = this.el.createDiv({ cls: "journal-reflection-header" });
		this.titleEl = header.createDiv({ cls: "journal-reflection-title" });
		this.actionsEl = header.createDiv({ cls: "journal-reflection-actions" });
		this.statusEl = this.el.createDiv({ cls: "journal-reflection-status" });
		this.bodyEl = this.el.createDiv({ cls: "journal-reflection-body markdown-rendered" });
		this.footerEl = this.el.createDiv({ cls: "journal-reflection-footer" });
		this.bodyEl.addEventListener("click", (event) => this.onBodyClick(event));
		this.update(source);
	}

	/** The saved note or run this card shows, to match it on the next refresh. */
	get identity(): string {
		return reflectionIdentity(this.source);
	}

	/** Brings the card up to date with its note or run. */
	update(source: ReflectionCardSource): void {
		this.source = source;
		if ("stored" in source) this.showStored(source.stored);
		else this.showRun(source.run);
	}

	destroy(): void {
		this.destroyed = true;
		window.clearTimeout(this.renderTimer);
		this.component.unload();
		this.el.remove();
	}

	/* --------------------------------------------------------------- stored */

	private showStored(reflection: StoredReflection): void {
		this.el.removeClass("journal-reflection-pending", "journal-reflection-failed");
		this.setTitle(reflection.title);
		this.actionsEl.empty();
		this.addAction("trash-2", "Delete reflection", () => void this.host.plugin.reflections.delete(reflection.file));
		this.statusEl.hidden = true;
		this.renderFooter(reflection);
		void this.renderStoredBody(reflection.file);
	}

	private async renderStoredBody(file: TFile): Promise<void> {
		let text: string;
		try {
			text = await this.host.app.vault.cachedRead(file);
		} catch (error) {
			console.error(`Journal View: could not read ${file.path}`, error);
			return;
		}
		if (this.destroyed) return;
		await this.renderMarkdown(stripFrontmatter(text), file.path);
	}

	private renderFooter(reflection: StoredReflection): void {
		this.footerEl.empty();
		const count = reflection.sources.length;
		const parts: string[] = [];
		if (count) parts.push(`From ${count} ${count === 1 ? "note" : "notes"}`);
		const span = spanLabel(reflection.from, reflection.to);
		if (span) parts.push(span);
		if (reflection.model) parts.push(reflection.model);
		this.footerEl.setText(parts.join(" · "));
		this.footerEl.hidden = parts.length === 0;
	}

	/* ------------------------------------------------------------------ run */

	private showRun(run: ReflectionRun): void {
		this.el.toggleClass("journal-reflection-pending", run.status !== "failed");
		this.el.toggleClass("journal-reflection-failed", run.status === "failed");
		this.setTitle(run.request.title);
		this.actionsEl.empty();
		const runner = this.host.plugin.reflectionRuns;
		if (run.status === "failed") {
			this.addAction("rotate-ccw", "Try again", () => runner.retry(run.id));
			this.addAction("x", "Dismiss", () => runner.dismiss(run.id));
		} else {
			this.addAction("square", "Stop", () => runner.stop(run.id));
		}
		this.statusEl.hidden = run.status === "writing";
		this.statusEl.setText(run.statusLine);
		this.footerEl.hidden = true;

		if (run.status === "reading" || (run.status === "failed" && !run.text)) {
			if (run.status === "failed") this.bodyEl.empty();
			else this.showSkeleton();
			return;
		}
		this.scheduleRender(run.text);
	}

	private showSkeleton(): void {
		if (this.bodyEl.querySelector(".journal-reflection-skeleton")) return;
		this.rendered = "";
		this.bodyEl.empty();
		const skeleton = this.bodyEl.createDiv({ cls: "journal-reflection-skeleton", attr: { "aria-hidden": "true" } });
		for (let line = 0; line < 3; line++) skeleton.createDiv({ cls: "journal-reflection-skeleton-line" });
	}

	/** Renders streamed text a few times a second, and once more when it stops. */
	private scheduleRender(text: string): void {
		if (this.renderTimer) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = 0;
			if (this.destroyed || !("run" in this.source)) return;
			void this.renderMarkdown(this.source.run.text, "");
		}, this.rendered ? RENDER_INTERVAL : 0);
		if (!this.rendered && text) this.bodyEl.empty();
	}

	/* --------------------------------------------------------------- shared */

	private setTitle(kind: string): void {
		this.titleEl.empty();
		this.titleEl.createSpan({ cls: "journal-reflection-label", text: "Reflection" });
		// A long question is cut to one line; its tooltip holds the rest.
		setTooltip(this.titleEl.createSpan({ cls: "journal-reflection-kind", text: kind }), kind);
	}

	private addAction(icon: string, label: string, onClick: () => void): void {
		const button = this.actionsEl.createEl("button", {
			cls: "clickable-icon journal-reflection-action",
			attr: { "aria-label": label },
		});
		setIcon(button, icon);
		setTooltip(button, label);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			onClick();
		});
	}

	private async renderMarkdown(markdown: string, sourcePath: string): Promise<void> {
		if (markdown === this.rendered) return;
		this.rendered = markdown;
		const target = createDiv();
		try {
			await MarkdownRenderer.render(this.host.app, markdown, target, sourcePath, this.component);
		} catch (error) {
			console.error("Journal View: could not render a reflection", error);
			target.setText(markdown);
		}
		if (this.destroyed || this.rendered !== markdown) return;
		this.bodyEl.empty();
		this.bodyEl.append(...Array.from(target.childNodes));
	}

	/** A cited note moves the journal to its day, instead of opening the note elsewhere. */
	private onBodyClick(event: MouseEvent): void {
		const link = (event.target as HTMLElement | null)?.closest("a.internal-link");
		if (!(link instanceof HTMLElement)) return;
		const href = link.dataset.href ?? link.getAttribute("href");
		if (!href) return;
		event.preventDefault();
		event.stopPropagation();
		const sourcePath = "stored" in this.source ? this.source.stored.file.path : "";
		const target = this.host.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
		if (target && this.host.plugin.index.keyForPath(target.path) !== null) {
			this.host.revealNote(target.path);
			return;
		}
		void this.host.app.workspace.openLinkText(href, sourcePath, event.ctrlKey || event.metaKey);
	}
}

/** The note's text without its properties. */
function stripFrontmatter(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
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
