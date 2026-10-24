import { Component, Notice } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";
import { buildContext, repairCitations } from "./context";
import type { ReflectionSource, ScopeRange } from "./context";
import type { ReflectionRequest, ReflectionScope } from "./presets";
import { NO_MODELS_MESSAGE, ProviderError, describeProviderError } from "./provider";
import type { ModelInfo } from "./provider";
import { reflectWithTools } from "./tools";

export type RunStatus = "reading" | "writing" | "failed";

/** What a question the model cannot choose notes for reads instead. */
const FALLBACK_SCOPE: ReflectionScope = { kind: "days", days: 14 };

/** A reflection being written, which its card follows until the note is saved. */
export interface ReflectionRun {
	readonly id: number;
	/** The day it belongs to, `YYYY-MM-DD`. */
	readonly key: string;
	readonly request: ReflectionRequest;
	status: RunStatus;
	/** What the card says above the text: what is being read, or what went wrong. */
	statusLine: string;
	/** The answer so far. */
	text: string;
	model: string | null;
	range: ScopeRange | null;
	sources: ReflectionSource[];
}

interface ActiveRun extends ReflectionRun {
	controller: AbortController;
	/** Set by Stop: what arrived is kept and saved. */
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

	onunload(): void {
		this.unloading = true;
		for (const run of this.runs) run.controller.abort();
		this.runs = [];
		if (this.frame) window.cancelAnimationFrame(this.frame);
	}

	runsFor(key: string): readonly ReflectionRun[] {
		return this.runs.filter((run) => run.key === key);
	}

	/** Listens for runs starting, changing and ending, by day. */
	onChanged(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts a reflection on `today`, the day it belongs to. */
	start(request: ReflectionRequest, today: Moment = createMoment().startOf("day")): ReflectionRun {
		const run: ActiveRun = {
			id: this.nextId++,
			key: today.format("YYYY-MM-DD"),
			request,
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
		void this.execute(run, today);
		return run;
	}

	/** Stops a run, keeping what it has written so far. */
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
		this.start(run.request, createMoment(run.key, "YYYY-MM-DD", true));
	}

	/** Removes a failed run's card. */
	dismiss(id: number): void {
		const run = this.runs.find((candidate) => candidate.id === id);
		if (!run) return;
		run.controller.abort();
		this.runs = this.runs.filter((candidate) => candidate !== run);
		this.announce(run.key, true);
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
			const sourcePath = `${folder ? `${folder}/` : ""}${run.key}.md`;

			const choosing = run.request.scope.kind === "model";
			if (choosing && info.tools) {
				try {
					await this.answerWithTools(run, info, today, sourcePath);
					await this.save(run);
					return;
				} catch (error) {
					// The server knows better than the model's description: read a fixed range instead.
					if (!(error instanceof ProviderError && error.kind === "no-tools")) throw error;
					run.text = "";
					run.status = "reading";
				}
			}
			const scope = choosing ? FALLBACK_SCOPE : run.request.scope;
			const context = await buildContext(plugin, { ...run.request, scope }, today, {
				contextLength: info.contextLength,
				maxContext: plugin.settings.reflectionMaxContext,
				sourcePath,
			});
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
			if (this.unloading) return;
			if (run.stopped || (error instanceof ProviderError && error.kind === "aborted")) {
				if (run.stopped && run.text.trim()) await this.save(run);
				else this.remove(run);
				return;
			}
			console.error("Journal View: reflection failed", error);
			if (run.text.trim()) {
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

	/**
	 * Lets the model read the journal through tools. Each call shows on the
	 * card as it happens; text from a round that ends up calling tools is
	 * taken back, so only the answer stays.
	 */
	private async answerWithTools(run: ActiveRun, model: ModelInfo, today: Moment, sourcePath: string): Promise<void> {
		run.statusLine = "Looking through your notes…";
		this.announce(run.key, true);
		const result = await reflectWithTools({
			plugin: this.plugin,
			provider: this.plugin.reflectionProvider(),
			model,
			question: run.request.prompt,
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

	/** Writes the reflection's note, after which the note's own card takes over from the run's. */
	private async save(run: ActiveRun): Promise<void> {
		if (this.unloading) return;
		const { plugin } = this;
		// Stopped mid-link, the last citation is half written: drop it.
		const text = repairCitations(run.text.replace(/\[\[[^\]\n]*$/, "").trimEnd(), run.sources);
		try {
			await plugin.reflections.create(
				{
					created: createMoment(),
					title: run.request.title,
					preset: run.request.presetId,
					prompt: run.request.prompt,
					model: run.model ?? "",
					from: run.range?.from ?? run.key,
					to: run.range?.to ?? run.key,
					sources: run.sources.map((source) => source.link),
				},
				text,
			);
			this.remove(run);
		} catch (error) {
			console.error("Journal View: could not save a reflection", error);
			run.status = "failed";
			run.statusLine = `Could not save the reflection: ${describeProviderError(error)}`;
			this.announce(run.key, true);
		}
	}

	private remove(run: ActiveRun): void {
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

/** "Reading 5–19 Oct · 9 notes", and how many were left out when not all fitted. */
function readingLine(range: ScopeRange, read: number, total: number): string {
	const from = createMoment(range.from, "YYYY-MM-DD", true);
	const to = createMoment(range.to, "YYYY-MM-DD", true);
	const span = range.from === range.to ? to.format("D MMM") : `${from.format("D MMM")} – ${to.format("D MMM")}`;
	const notes = `${read} ${read === 1 ? "note" : "notes"}`;
	return read < total ? `Reading ${span} · ${notes} of ${total}; the rest did not fit` : `Reading ${span} · ${notes}`;
}
