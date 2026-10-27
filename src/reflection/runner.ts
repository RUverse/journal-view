import { Component, Notice } from "obsidian";
import type { TFile } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";
import { noteBody } from "../noteBody";
import { buildContext, repairCitations } from "./context";
import type { ReflectionSource, ScopeRange } from "./context";
import { followUpMarkdown, parseConversation } from "./conversation";
import type { Conversation } from "./conversation";
import { QUESTION_FORMAT, presetsOf } from "./presets";
import type { ReflectionRequest, ReflectionScope } from "./presets";
import { NO_MODELS_MESSAGE, ProviderError, describeProviderError } from "./provider";
import type { ModelInfo } from "./provider";
import type { StoredReflection, StoredScope } from "./store";
import { reflectWithTools } from "./tools";

export type RunStatus = "reading" | "writing" | "failed";

/**
 * What a run writes: a new reflection note, a new answer in place of a
 * reflection's own, or the answer to a follow-up at the end of its note.
 */
export type RunKind = "new" | "regenerate" | "follow-up";

/** What a question the model cannot choose notes for reads instead. */
const FALLBACK_SCOPE: ReflectionScope = { kind: "days", days: 14 };

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
	range: ScopeRange | null;
	sources: ReflectionSource[];
}

interface RunSpec {
	key: string;
	request: ReflectionRequest;
	kind: RunKind;
	target: TFile | null;
	question: string | null;
	/** What it reads when the model was to choose and cannot. */
	fallback: ReflectionScope;
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
			fallback: FALLBACK_SCOPE,
		});
	}

	/**
	 * Asks a reflection's question again over the notes it read, as of its
	 * own day. The new answer replaces the old one, and its follow-ups, once
	 * it is complete.
	 */
	regenerate(reflection: StoredReflection): void {
		if (this.runFor(reflection.file)) return;
		this.launch({
			key: reflection.key,
			request: this.requestOf(reflection),
			kind: "regenerate",
			target: reflection.file,
			question: null,
			fallback: FALLBACK_SCOPE,
		});
	}

	/** Asks a reflection a follow-up, over the notes it read, and adds the answer to its note. */
	followUp(reflection: StoredReflection, question: string): void {
		const asked = question.trim();
		if (!asked || this.runFor(reflection.file)) return;
		this.launch({
			key: reflection.key,
			request: this.requestOf(reflection),
			kind: "follow-up",
			target: reflection.file,
			question: asked,
			// The days its answer drew on, rather than a fixed two weeks.
			fallback:
				reflection.from && reflection.to ? { kind: "range", from: reflection.from, to: reflection.to } : FALLBACK_SCOPE,
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

	/** What a saved reflection was asked, to ask it again: its question, over the notes it read. */
	private requestOf(reflection: StoredReflection): ReflectionRequest {
		const preset = reflection.preset
			? presetsOf(this.plugin.settings.reflectionPresets).find((candidate) => candidate.id === reflection.preset)
			: undefined;
		return {
			presetId: reflection.preset,
			title: reflection.title,
			prompt: reflection.prompt,
			format: preset?.format || QUESTION_FORMAT,
			scope: scopeOf(reflection, preset?.scope),
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
			let model = plugin.settings.reflectionModel;
			if (!model) {
				const installed = await provider.listModels();
				if (!installed.length) {
					throw new ProviderError("model-missing", NO_MODELS_MESSAGE);
				}
				model = installed[0].name;
			}
			run.model = model;
			const info = await provider.showModel(model);
			if (run.controller.signal.aborted) throw new ProviderError("aborted", "Stopped.");
			const sourcePath = run.target?.path ?? `${folder ? `${folder}/` : ""}${run.key}.md`;
			const followUp =
				run.target && run.question
					? { conversation: await this.conversationOf(run.target), question: run.question }
					: undefined;

			const choosing = run.request.scope.kind === "model";
			if (choosing && info.tools) {
				try {
					await this.answerWithTools(run, info, today, sourcePath, followUp);
					await this.save(run);
					return;
				} catch (error) {
					// The server knows better than the model's description: read a fixed range instead.
					if (!(error instanceof ProviderError && error.kind === "no-tools")) throw error;
					run.text = "";
					run.status = "reading";
				}
			}
			const scope = choosing ? run.spec.fallback : run.request.scope;
			const context = await buildContext(
				plugin,
				{ ...run.request, scope },
				today,
				{
					contextLength: info.contextLength,
					maxContext: plugin.settings.reflectionMaxContext,
					sourcePath,
				},
				followUp,
			);
			run.range = context.range;
			run.sources = context.sources;
			if (!context.sources.length) {
				throw new ProviderError("failed", "There are no notes in that range to reflect on.");
			}
			run.statusLine = readingLine(context.range, context.sources.length, context.total);
			// Said up front: the question asked for the model to choose, and it cannot.
			if (choosing) run.statusLine = `${model} cannot choose its own notes. ${run.statusLine}`;
			this.announce(run.key, true);

			await provider.chat({
				model,
				messages: context.messages,
				numCtx: context.numCtx,
				signal: run.controller.signal,
				onText: (delta) => this.receive(run, delta),
			});
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
		return parseConversation(noteBody(await this.plugin.app.vault.read(file)));
	}

	/**
	 * Lets the model read the journal through tools. Each call shows on the
	 * card as it happens; text from a round that ends up calling tools is
	 * taken back, so only the answer stays.
	 */
	private async answerWithTools(
		run: ActiveRun,
		model: ModelInfo,
		today: Moment,
		sourcePath: string,
		followUp: { conversation: Conversation; question: string } | undefined,
	): Promise<void> {
		run.statusLine = "Looking through your notes…";
		this.announce(run.key, true);
		const result = await reflectWithTools({
			plugin: this.plugin,
			provider: this.plugin.reflectionProvider(),
			model,
			question: run.request.prompt,
			followUp,
			today,
			maxContext: this.plugin.settings.reflectionMaxContext,
			sourcePath,
			signal: run.controller.signal,
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
						frontmatter.model = model;
						if (run.range) {
							frontmatter.from = run.range.from;
							frontmatter.to = run.range.to;
						}
						frontmatter.sources = links;
						frontmatter.scope = storedScopeOf(run.request.scope);
					},
				);
			} else if (run.target && run.question !== null) {
				const question = run.question;
				await plugin.reflections.revise(
					run.target,
					(body) => `${body.trimEnd()}\n\n${followUpMarkdown(question, text)}`,
					(frontmatter) => {
						// The follow-up's notes join the reflection's, and widen its days.
						const earlier: unknown[] = Array.isArray(frontmatter.sources) ? (frontmatter.sources as unknown[]) : [];
						const kept = earlier.filter((link): link is string => typeof link === "string");
						frontmatter.sources = [...new Set([...kept, ...links])];
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
						scope: storedScopeOf(run.request.scope),
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

/** How a note records what a request read. */
function storedScopeOf(scope: ReflectionScope): StoredScope {
	return scope.kind === "model" || scope.kind === "this-day" ? scope.kind : "range";
}

/**
 * What a saved reflection reads when it is asked again: what the model
 * chooses, this date over the years, or the days it read. Notes written
 * before the scope was recorded go by their preset's.
 */
function scopeOf(reflection: StoredReflection, presetScope: ReflectionScope | undefined): ReflectionScope {
	const kind = reflection.scope ?? (presetScope ? storedScopeOf(presetScope) : "range");
	if (kind !== "range") return { kind };
	if (reflection.from && reflection.to) return { kind: "range", from: reflection.from, to: reflection.to };
	return presetScope ?? FALLBACK_SCOPE;
}

/** "Reading 5–19 Oct · 9 notes", and how many were left out when not all fitted. */
function readingLine(range: ScopeRange, read: number, total: number): string {
	const from = createMoment(range.from, "YYYY-MM-DD", true);
	const to = createMoment(range.to, "YYYY-MM-DD", true);
	const span = range.from === range.to ? to.format("D MMM") : `${from.format("D MMM")} – ${to.format("D MMM")}`;
	const notes = `${read} ${read === 1 ? "note" : "notes"}`;
	return read < total ? `Reading ${span} · ${notes} of ${total}; the rest did not fit` : `Reading ${span} · ${notes}`;
}
