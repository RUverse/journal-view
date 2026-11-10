import { Component, Notice, TFile, normalizePath } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import { indexableNotes, openJournal } from "./journal";
import { ProviderError, defaultEmbeddingModel, describeProviderError } from "./provider";
import { SemanticIndex, embeddingPrompts, staleNotes, updateIndex } from "./semantic";
import type { IndexableNote, SemanticHit } from "./semantic";

/** The index's file, in the plugin's own folder beside its settings. */
const INDEX_FILE = "reflection-index.bin";

/** What the settings say of the index. */
export type IndexStatus =
	/** No index file yet: it is made the first time a search needs it, or when asked. */
	| { state: "none"; notes: number }
	| {
			state: "ready";
			/** Notes it holds vectors for. */
			indexed: number;
			/** Notes of the journal that are new or changed since. */
			stale: number;
			/** The file's size. */
			bytes: number;
			model: string;
	  }
	| { state: "building"; done: number; total: number }
	| { state: "failed"; message: string };

type Listener = () => void;

/**
 * Keeps the index that lets a reflection search by meaning: a vector for
 * each note, from an embedding model, in one file in the plugin's folder.
 *
 * Nothing is read or written until search by meaning is turned on and a
 * search, or the settings, asks. The index is brought up to date before each
 * use, embedding only the notes that are new or changed, and holds only
 * notes the journal's filters let through, as a reflection reads only those.
 * Changing the model, or turning the feature off, deletes the file.
 */
export class ReflectionIndexStore extends Component {
	private index: SemanticIndex | null = null;
	/** One build at a time: a search waits for the settings' build, and the other way round. */
	private queue: Promise<unknown> = Promise.resolve();
	private building: { done: number; total: number; controller: AbortController } | null = null;
	private failure: string | null = null;
	/** Failures already told to the reader, so each is said once. */
	private noticed = new Set<string>();
	private listeners = new Set<Listener>();
	/** The embedding model found while none is chosen, kept until the settings change. */
	private found: { server: string; model: string } | null = null;

	constructor(private plugin: JournalViewPlugin) {
		super();
	}

	onunload(): void {
		this.building?.controller.abort();
		this.listeners.clear();
		this.index = null;
	}

	/** Hears the index being built, finished, or failing. */
	onChanged(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Where the index is kept, from the vault's root. */
	path(): string {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/journal-view`}/${INDEX_FILE}`);
	}

	/** The embedding model to use: the one chosen, or the default among those installed. Null when there is none. */
	async model(): Promise<string | null> {
		const { reflectionEmbeddingModel, reflectionServer } = this.plugin.settings;
		if (reflectionEmbeddingModel) return reflectionEmbeddingModel;
		if (this.found?.server === reflectionServer) return this.found.model;
		const installed = await this.plugin.reflectionProvider().listInstalled();
		const model = defaultEmbeddingModel(installed.embedding);
		if (model) this.found = { server: reflectionServer, model };
		return model;
	}

	/** Forgets what was found for the old settings, once the server or the model changed. */
	settingsChanged(): void {
		this.found = null;
		this.failure = null;
		this.notify();
	}

	/**
	 * For each of `texts`, the notes of `notes` by how near they lie, nearest
	 * first, once the index holds them all. `onStatus` hears of notes being
	 * indexed, which the first search after turning this on waits for.
	 */
	async nearest(
		notes: readonly IndexableNote[],
		texts: readonly string[],
		signal: AbortSignal,
		onStatus: (line: string) => void,
	): Promise<SemanticHit[][] | null> {
		try {
			const index = await this.update(notes, signal, (done, total) => onStatus(`Indexing your notes… ${done} of ${total}`));
			if (!index || signal.aborted) return null;
			const prompts = embeddingPrompts(index.model);
			const vectors = await this.plugin.reflectionProvider().embed(index.model, texts.map((text) => prompts.query(text)), signal);
			const allowed = new Set(notes.map((note) => note.path));
			return vectors.map((vector) => index.search(vector, (path) => allowed.has(path)));
		} catch (error) {
			if (signal.aborted) return null;
			this.fail(error);
			return null;
		}
	}

	/**
	 * Builds the index for the journal as it is today, for the settings'
	 * button: the same notes a reflection made now would search.
	 */
	async build(): Promise<void> {
		const { journal, close } = openJournal(this.plugin, createMoment().startOf("day"), "");
		try {
			const controller = new AbortController();
			await this.update(indexableNotes(this.plugin, journal.notes, journal.body), controller.signal, undefined, controller);
		} catch (error) {
			this.fail(error);
		} finally {
			close();
		}
	}

	/** Stops a build under way; what it has embedded so far is kept. */
	stop(): void {
		this.building?.controller.abort();
	}

	/** Deletes the index file, as turning search by meaning off or changing its model does. */
	async remove(): Promise<void> {
		this.stop();
		await this.enqueue(async () => {
			this.index = null;
			this.failure = null;
			const { adapter } = this.plugin.app.vault;
			try {
				if (await adapter.exists(this.path())) await adapter.remove(this.path());
			} catch (error) {
				console.warn("Journal View: could not delete the reflection index", error);
			}
		});
		this.notify();
	}

	/** What the settings show: how much is indexed, with which model, and what is left to do. */
	async status(): Promise<IndexStatus> {
		if (this.building) return { state: "building", done: this.building.done, total: this.building.total };
		if (this.failure) return { state: "failed", message: this.failure };
		const { journal, close } = openJournal(this.plugin, createMoment().startOf("day"), "");
		close();
		const notes = indexableNotes(this.plugin, journal.notes, journal.body);
		try {
			const model = await this.model();
			const index = model ? await this.open(model) : null;
			if (!index || !index.size) return { state: "none", notes: notes.length };
			const { adapter } = this.plugin.app.vault;
			const stat = (await adapter.exists(this.path())) ? await adapter.stat(this.path()) : null;
			return { state: "ready", indexed: index.size, stale: staleNotes(index, notes), bytes: stat?.size ?? 0, model: index.model };
		} catch (error) {
			return { state: "failed", message: describeProviderError(error) };
		}
	}

	/** Brings the index up to date with `notes`, one build at a time, and returns it; null when no model can make one. */
	private update(
		notes: readonly IndexableNote[],
		signal: AbortSignal,
		progress?: (done: number, total: number) => void,
		controller = new AbortController(),
	): Promise<SemanticIndex | null> {
		return this.enqueue(async () => {
			const model = await this.model();
			if (!model) {
				throw new ProviderError("model-missing", "No embedding model is installed for search by meaning. Pull one, or turn it off, in the Reflect window's settings.");
			}
			const index = await this.open(model);
			// Notes deleted from the vault leave the index; ones a filter hides now may be shown again later.
			for (const path of index.paths()) {
				if (!(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile)) index.delete(path);
			}
			const total = staleNotes(index, notes);
			if (total || index.dirty) {
				const stop = () => controller.abort();
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) controller.abort();
				// Shown only when there is something to wait for.
				if (total) this.building = { done: 0, total, controller };
				this.notify();
				try {
					const provider = this.plugin.reflectionProvider();
					const embed = async (texts: string[]): Promise<number[][]> => {
						try {
							return await provider.embed(model, texts, controller.signal);
						} catch (error) {
							// Said with what to do about it, since the server only says the name was not found.
							if (!(error instanceof ProviderError) || error.kind !== "model-missing") throw error;
							throw new ProviderError(
								"model-missing",
								`${model} is not installed. Pull it, or choose another embedding model in the Reflect window's settings.`,
							);
						}
					};
					await updateIndex(index, notes, embed, {
						signal: controller.signal,
						progress: (done, all) => {
							if (this.building) this.building = { ...this.building, done, total: all };
							progress?.(done, all);
							this.notify();
						},
						save: () => this.save(index),
					});
				} finally {
					signal.removeEventListener("abort", stop);
					this.building = null;
					this.notify();
				}
			}
			this.failure = null;
			return index;
		});
	}

	/** The index for `model`: the one in memory, the one in the file, or an empty one when neither is that model's. */
	private async open(model: string): Promise<SemanticIndex> {
		if (this.index?.model === model) return this.index;
		const { adapter } = this.plugin.app.vault;
		let saved: SemanticIndex | null = null;
		try {
			if (await adapter.exists(this.path())) saved = SemanticIndex.parse(await adapter.readBinary(this.path()));
		} catch (error) {
			console.warn("Journal View: could not read the reflection index, starting it again", error);
		}
		// Another model's vectors, or a file from another version, cannot be compared with new ones.
		this.index = saved?.model === model ? saved : new SemanticIndex(model);
		return this.index;
	}

	private async save(index: SemanticIndex): Promise<void> {
		await this.plugin.app.vault.adapter.writeBinary(this.path(), index.serialize());
		index.dirty = false;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Records why search by meaning is not working, and tells the reader once: searches go on by words. */
	private fail(error: unknown): void {
		if (error instanceof ProviderError && error.kind === "aborted") return;
		const message = describeProviderError(error);
		this.failure = message;
		console.warn("Journal View: search by meaning is not available", error);
		if (!this.noticed.has(message)) {
			this.noticed.add(message);
			new Notice(`Journal View: search by meaning is not available, so reflections search by words. ${message}`);
		}
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
