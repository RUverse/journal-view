import { Component, Notice } from "obsidian";
import type { TFile } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";
import { noteBody } from "../noteBody";
import { repairCitations } from "./context";
import type { DayRange, ReflectionSource } from "./context";
import { followUpMarkdown, parseConversation } from "./conversation";
import type { Conversation } from "./conversation";
import { openJournal } from "./journal";
import { QUESTION_FORMAT, presetsOf } from "./presets";
import type { ReflectionRequest } from "./presets";
import { NO_MODELS_MESSAGE, NO_TOOLS_MESSAGE, ProviderError, defaultModel, describeProviderError } from "./provider";
import type { ModelInfo } from "./provider";
import { FOLLOW_UPS_PROPERTY, stringsOf } from "./store";
import type { StoredReflection } from "./store";
import { reflectWithTools } from "./tools";

export type RunStatus = "reading" | "writing" | "failed";

/**
 * What a run writes: a new reflection note, a new answer in place of a
 * reflection's own, or the answer to a follow-up at the end of its note.
 */
export type RunKind = "new" | "regenerate" | "follow-up";

/** A reflection being written, which its card follows until the note is saved. */
export interface ReflectionRun {
	readonly id: number;
	/** The day it belongs to, `YYYY-MM-DD`. */
	readonly key: string;
	readonly request: ReflectionRequest;
	readonly kind: RunKind;
	/** The reflection note a regenerate or a follow-up writes back to; its card shows the run. */
	readonly target: TFile | null;
	/** The question a follow-up asks. */
	readonly question: string | null;
	status: RunStatus;
	/** What the card says above the text: what is being read, or what went wrong. */
	statusLine: string;
	/** The answer so far. */
	text: string;
	model: string | null;
	range: DayRange | null;
	sources: ReflectionSource[];
}

interface RunSpec {
	key: string;
	request: ReflectionRequest;
	kind: RunKind;
	target: TFile | null;
	question: string | null;
	/** The model to ask, when it is not the one the settings choose: a regenerate can name its own. */
	model?: string;
}

interface ActiveRun extends ReflectionRun {
	readonly spec: RunSpec;
	controller: AbortController;
	/** Set by Stop: what arrived is kept and saved, except by a regenerate. */
	stopped: boolean;
}

type Listener = (key: string) => void;

/**
 * Runs reflections. A run lives here rather than in its card, so it keeps
 * going while its day scrolls out of the journal and is picked up again
 * when the day loads. Disabling the plugin cancels every run, and nothing
 * half-written is saved.
 */
export class ReflectionRunner extends Component {
	private runs: ActiveRun[] = [];
	private listeners = new Set<Listener>();
	private nextId = 1;
	private unloading = false;
	/** Days whose runs changed since the last frame, announced together. */
	private changed = new Set<string>();
	private frame = 0;

	constructor(private plugin: JournalViewPlugin) {
		super();
	}

	onload(): void {
		// A reflection deleted while it is being rewritten takes its run with it.
		this.registerEvent(
			this.plugin.app.vault.on("delete", (file) => {
				for (const run of this.runs.filter((candidate) => candidate.target === file)) {
					run.controller.abort();
					this.remove(run);
				}
			}),
		);
	}

	onunload(): void {
		this.unloading = true;
		for (const run of this.runs) run.controller.abort();
		this.runs = [];
		if (this.frame) window.cancelAnimationFrame(this.frame);
	}

	/** The new reflections being written on a day; a regenerate or a follow-up is its note's. */
	runsFor(key: string): readonly ReflectionRun[] {
		return this.runs.filter((run) => run.key === key && !run.target);
	}

	/** The regenerate or follow-up writing back to a reflection note, if one is. */
	runFor(file: TFile): ReflectionRun | null {
		return this.runs.find((run) => run.target === file) ?? null;
	}

	/** Listens for runs starting, changing and ending, by day. */
	onChanged(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts a reflection on `today`, the day it belongs to. */
	start(request: ReflectionRequest, today: Moment = createMoment().startOf("day")): ReflectionRun {
		return this.launch({
			key: today.format("YYYY-MM-DD"),
			request,
			kind: "new",
			target: null,
			question: null,
		});
	}

	/**
	 * Asks a reflection again, as of its own day: its question, or the one it
	 * was changed to, of the model given or the one the settings choose. The
	 * new answer replaces the old one, and its follow-ups, once it is complete.
	 */
	regenerate(reflection: StoredReflection, changes: { prompt?: string; model?: string } = {}): void {
		if (this.runFor(reflection.file)) return;
		const request = this.requestOf(reflection);
		const prompt = changes.prompt?.trim();
		if (prompt && prompt !== request.prompt) {
			request.prompt = prompt;
			// A question of the reader's own is its own title; a preset keeps its name and its shape.
			if (!request.presetId) request.title = prompt;
		}
		this.launch({
			key: reflection.key,
			request,
			kind: "regenerate",
			target: reflection.file,
			question: null,
			model: changes.model || undefined,
		});
	}

	/** Asks a reflection a follow-up, and adds the answer to its note. */
	followUp(reflection: StoredReflection, question: string): void {
		const asked = question.trim();
		if (!asked || this.runFor(reflection.file)) return;
		this.launch({
			key: reflection.key,
			request: this.requestOf(reflection),
			kind: "follow-up",
			target: reflection.file,
			question: asked,
		});
	}

	/** Stops a run, keeping what it has written so far; a regenerate keeps the old answer instead. */
	stop(id: number): void {
		const run = this.runs.find((candidate) => candidate.id === id);
		if (!run) return;
		run.stopped = true;
		run.controller.abort();
	}

	/** Runs a failed reflection again. */
	retry(id: number): void {
		const run = this.runs.find((candidate) => candidate.id === id);
		if (!run || run.status !== "failed") return;
		this.dismiss(id);
		this.launch(run.spec);
	}

	/** Removes a failed run's card, or its place in its reflection's card. */
	dismiss(id: number): void {
		const run = this.runs.find((candidate) => candidate.id === id);
		if (!run) return;
		run.controller.abort();
		this.remove(run);
	}

	private launch(spec: RunSpec): ReflectionRun {
		const run: ActiveRun = {
			id: this.nextId++,
			key: spec.key,
			request: spec.request,
			kind: spec.kind,
			target: spec.target,
			question: spec.question,
			spec,
			status: "reading",
			statusLine: "Connecting…",
			text: "",
			model: null,
			range: null,
			sources: [],
			controller: new AbortController(),
			stopped: false,
		};
		this.runs.push(run);
		this.announce(run.key, true);
		void this.execute(run, createMoment(run.key, "YYYY-MM-DD", true));
		return run;
	}

	/** What a saved reflection was asked, to ask it again: its question, in its preset's shape. */
	private requestOf(reflection: StoredReflection): ReflectionRequest {
		const preset = reflection.preset
			? presetsOf(this.plugin.settings.reflectionPresets).find((candidate) => candidate.id === reflection.preset)
			: undefined;
		return {
			presetId: reflection.preset,
			title: reflection.title,
			prompt: reflection.prompt,
			format: preset?.format || QUESTION_FORMAT,
		};
	}

	private async execute(run: ActiveRun, today: Moment): Promise<void> {
		const { plugin } = this;
		const provider = plugin.reflectionProvider();
		try {
			const folder = plugin.reflections.folder();
			if (folder === null) {
				throw new ProviderError(
					"failed",
					"The Reflections folder is the daily-note folder. Choose another in the Reflect window's settings.",
				);
			}
			let model = run.spec.model ?? plugin.settings.reflectionModel;
			if (!model) {
				const first = defaultModel(await provider.listModels());
				if (!first) throw new ProviderError("model-missing", NO_MODELS_MESSAGE);
				model = first.name;
			}
			run.model = model;
			const info = await provider.showModel(model);
			if (run.controller.signal.aborted) throw new ProviderError("aborted", "Stopped.");
			// A model reads the journal through tools, so one without them cannot write a reflection.
			if (!info.tools) throw new ProviderError("no-tools", NO_TOOLS_MESSAGE);
			const sourcePath = run.target?.path ?? `${folder ? `${folder}/` : ""}${run.key}.md`;
			const followUp =
				run.target && run.question
					? {
							conversation: await this.conversationOf(run.target),
							question: run.question,
							sources: stringsOf(plugin.app.metadataCache.getFileCache(run.target)?.frontmatter?.sources),
						}
					: undefined;
			await this.answer(run, info, today, sourcePath, followUp);
			await this.save(run);
		} catch (error) {
			if (this.unloading || !this.runs.includes(run)) return;
			// A regenerate cut short keeps the answer it was to replace.
			const keeps = run.kind !== "regenerate" && run.text.trim() !== "";
			if (run.stopped || (error instanceof ProviderError && error.kind === "aborted")) {
				if (run.stopped && keeps) await this.save(run);
				else this.remove(run);
				return;
			}
			console.error("Journal View: reflection failed", error);
			if (keeps) {
				// Keep what arrived: the reader can read it, or delete it.
				new Notice(`Journal View: the reflection stopped early. ${describeProviderError(error)}`);
				await this.save(run);
				return;
			}
			run.status = "failed";
			run.statusLine = describeProviderError(error);
			this.announce(run.key, true);
		}
	}

	/** A reflection note's answer and follow-ups, as they are now. */
	private async conversationOf(file: TFile): Promise<Conversation> {
		const { app } = this.plugin;
		const questions = stringsOf(app.metadataCache.getFileCache(file)?.frontmatter?.[FOLLOW_UPS_PROPERTY]);
		return parseConversation(noteBody(await app.vault.read(file)), questions);
	}

	/**
	 * Lets the model read the journal through its tools, and answer. Each call
	 * shows on the card as it happens; text from a round that ends up calling
	 * tools is taken back, so only the answer stays.
	 */
	private async answer(
		run: ActiveRun,
		model: ModelInfo,
		today: Moment,
		sourcePath: string,
		followUp: { conversation: Conversation; question: string; sources: string[] } | undefined,
	): Promise<void> {
		run.statusLine = "Looking through your notes…";
		this.announce(run.key, true);
		const { journal, close } = openJournal(this.plugin, today, sourcePath);
		try {
			const result = await reflectWithTools({
				journal,
				provider: this.plugin.reflectionProvider(),
				model,
				question: run.request.prompt,
				format: run.request.format,
				followUp,
				today: run.key,
				maxContext: this.plugin.settings.reflectionMaxContext,
				signal: run.controller.signal,
				// In the app's language, as the card's other lines are.
				shortDate: (key, withYear) => createMoment(key, "YYYY-MM-DD", true).format(withYear ? "D MMM YYYY" : "D MMM"),
				onStatus: (line) => {
					run.statusLine = line;
					this.announce(run.key, true);
				},
				onText: (delta) => this.receive(run, delta),
				onReset: () => {
					run.text = "";
					if (run.status === "writing") run.status = "reading";
					this.announce(run.key, true);
				},
				// So a run stopped before its answer still records what it read.
				onSources: (sources, range) => {
					run.sources = sources;
					run.range = range;
				},
			});
			run.sources = result.sources;
			run.range = result.range;
			// The stream may have been taken back after the answer's text arrived whole.
			if (!run.text.trim()) run.text = result.text;
		} finally {
			close();
		}
	}

	/** Adds streamed text to the run; the first words turn its skeleton into the answer. */
	private receive(run: ActiveRun, delta: string): void {
		run.text += delta;
		if (run.status !== "writing") {
			run.status = "writing";
			this.announce(run.key, true);
		} else {
			this.announce(run.key);
		}
	}

	/**
	 * Writes the answer: a new reflection note, the reflection's own answer
	 * in place, or a follow-up at its end. Then the note's card shows it
	 * rather than the run.
	 */
	private async save(run: ActiveRun): Promise<void> {
		if (this.unloading || !this.runs.includes(run)) return;
		const { plugin } = this;
		// Stopped mid-link, the last citation is half written: drop it.
		const text = repairCitations(run.text.replace(/\[\[[^\]\n]*$/, "").trimEnd(), run.sources);
		const links = run.sources.map((source) => source.link);
		const model = run.model ?? "";
		try {
			if (run.target && run.kind === "regenerate") {
				await plugin.reflections.revise(
					run.target,
					() => text,
					(frontmatter) => {
						// The question may have been changed for this answer.
						frontmatter.title = run.request.title;
						frontmatter.prompt = run.request.prompt;
						frontmatter.model = model;
						if (run.range) {
							frontmatter.from = run.range.from;
							frontmatter.to = run.range.to;
						}
						frontmatter.sources = links;
						// What reflections recorded while each fixed the notes it read.
						delete frontmatter.scope;
						delete frontmatter[FOLLOW_UPS_PROPERTY];
					},
				);
			} else if (run.target && run.question !== null) {
				const question = run.question;
				await plugin.reflections.revise(
					run.target,
					(body) => `${body.trimEnd()}\n\n${followUpMarkdown(question, text)}`,
					(frontmatter) => {
						frontmatter[FOLLOW_UPS_PROPERTY] = [...stringsOf(frontmatter[FOLLOW_UPS_PROPERTY]), question];
						// The follow-up's notes join the reflection's, and widen its days.
						frontmatter.sources = [...new Set([...stringsOf(frontmatter.sources), ...links])];
						if (!run.range) return;
						const { from, to } = frontmatter;
						if (typeof from !== "string" || run.range.from < from) frontmatter.from = run.range.from;
						if (typeof to !== "string" || run.range.to > to) frontmatter.to = run.range.to;
					},
				);
			} else {
				await plugin.reflections.create(
					{
						created: createMoment(),
						title: run.request.title,
						preset: run.request.presetId,
						prompt: run.request.prompt,
						model,
						from: run.range?.from ?? run.key,
						to: run.range?.to ?? run.key,
						sources: links,
					},
					text,
				);
			}
			this.remove(run);
		} catch (error) {
			console.error("Journal View: could not save a reflection", error);
			run.status = "failed";
			run.statusLine = `Could not save the reflection: ${describeProviderError(error)}`;
			this.announce(run.key, true);
		}
	}

	private remove(run: ActiveRun): void {
		if (!this.runs.includes(run)) return;
		this.runs = this.runs.filter((candidate) => candidate !== run);
		this.announce(run.key, true);
	}

	/**
	 * Tells listeners a day's runs changed. Streamed text arrives many times a
	 * second, so it is announced once a frame; a change of state is announced
	 * at once.
	 */
	private announce(key: string, now = false): void {
		this.changed.add(key);
		if (now) {
			this.flush();
			return;
		}
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => this.flush());
	}

	private flush(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.frame = 0;
		const keys = [...this.changed];
		this.changed.clear();
		for (const key of keys) for (const listener of this.listeners) listener(key);
	}
}
