/*
 * Search by meaning: each note is turned into numbers by an embedding model,
 * a vector that lies near those of texts about the same thing whatever
 * their words, and a question is answered by the notes whose vectors lie
 * nearest its own. This file holds the vectors and compares them; asking the
 * model for them is the caller's. Nothing here touches Obsidian, so the
 * spike (scripts/reflection-spike.mjs) runs it as it is.
 */

/** What an index file starts with, and the layout that follows it. */
const MAGIC = 0x4a56_5258; // "JVRX"
/**
 * Raised whenever the layout, the chunking or the text a note is embedded as
 * changes, since vectors made the old way no longer compare with new ones.
 */
export const INDEX_VERSION = 1;
/** A note longer than this is embedded in pieces, so one long day does not blur into an average of itself. */
const CHUNK_LENGTH = 1400;
/** A piece shorter than this joins the one before it. */
const MIN_CHUNK_LENGTH = 200;
/** What a unit vector's parts are multiplied by to be kept as one byte each. */
const SCALE = 127;

/** A stretch of a note's text that has a vector of its own. */
export interface Chunk {
	start: number;
	end: number;
}

/** A note as the index knows it. */
interface Entry {
	/** When the note was last changed, and its size: together they say whether its vectors are current. */
	mtime: number;
	size: number;
	chunks: Chunk[];
	/** Where its first vector starts, counted in vectors. */
	at: number;
}

/** A note a search by meaning found, with the stretch of it that came nearest. */
export interface SemanticHit {
	path: string;
	/** How near, from -1 to 1; what counts as near depends on the model. */
	score: number;
	chunk: Chunk;
}

/**
 * How a model wants its texts marked, so a question and the notes that
 * answer it land near each other. Each family was trained with its own
 * words for this, and without them finds less.
 */
export function embeddingPrompts(model: string): { query: (text: string) => string; document: (text: string) => string } {
	const name = model.toLowerCase();
	// `nomic-embed-text` is documented with `search_query: ` and `search_document: `, but
	// through Ollama it found more without them on the sample journal, so it is given none.
	if (name.includes("embeddinggemma")) {
		return {
			query: (text) => `task: search result | query: ${text}`,
			document: (text) => `title: none | text: ${text}`,
		};
	}
	if (name.includes("qwen3-embedding")) {
		return {
			query: (text) =>
				`Instruct: Given a question about a personal journal, retrieve the journal entries that answer it\nQuery: ${text}`,
			document: (text) => text,
		};
	}
	if (name.includes("mxbai-embed")) {
		return { query: (text) => `Represent this sentence for searching relevant passages: ${text}`, document: (text) => text };
	}
	return { query: (text) => text, document: (text) => text };
}

/**
 * The stretches a note is embedded as: the whole of a short one, and a long
 * one cut at its paragraphs, or failing that its sentences, into pieces of
 * about `CHUNK_LENGTH` characters.
 */
export function chunksOf(body: string): Chunk[] {
	const end = body.trimEnd().length;
	let start = 0;
	while (start < end && /\s/.test(body[start])) start++;
	if (start >= end) return [];
	if (end - start <= CHUNK_LENGTH) return [{ start, end }];
	// Where a piece may end: after a paragraph, and inside a long one after a sentence.
	const breaks: number[] = [];
	for (const match of body.slice(0, end).matchAll(/\n\s*\n|[.!?…。！？؟]["”’)\]]*\s+/g)) {
		breaks.push(match.index + match[0].length);
	}
	const chunks: Chunk[] = [];
	let from = start;
	while (end - from > CHUNK_LENGTH) {
		let cut = -1;
		for (const at of breaks) {
			if (at <= from + MIN_CHUNK_LENGTH) continue;
			if (at > from + CHUNK_LENGTH) break;
			// A paragraph's end is taken over a sentence's, once the piece is long enough.
			const paragraph = /\n\s*\n$/.test(body.slice(Math.max(0, at - 4), at)) || body[at - 1] === "\n";
			if (cut === -1 || paragraph || at - from <= CHUNK_LENGTH * 0.6) cut = at;
		}
		if (cut === -1) cut = from + CHUNK_LENGTH;
		chunks.push({ start: from, end: cut });
		from = cut;
	}
	if (end - from < MIN_CHUNK_LENGTH && chunks.length) chunks[chunks.length - 1].end = end;
	else chunks.push({ start: from, end });
	return chunks;
}

/** A vector made unit length, so the nearness of two is the sum of their parts multiplied. */
function normalized(vector: readonly number[]): number[] {
	let sum = 0;
	for (const value of vector) sum += value * value;
	const length = Math.sqrt(sum) || 1;
	return vector.map((value) => value / length);
}

/**
 * The vectors of a journal's notes, and the notes nearest a question.
 *
 * Each part of a vector is kept as one byte rather than four: a note costs
 * about a kilobyte, a tenth of a megabyte a hundred notes, and the order of
 * the nearest notes comes out the same.
 */
export class SemanticIndex {
	private readonly entries = new Map<string, Entry>();
	private vectors = new Int8Array(0);
	/** Vectors held, some of which belong to no note any more until the index is next saved. */
	private count = 0;
	/** True once something changed that the saved file does not hold. */
	dirty = false;

	/** How many numbers a vector holds, which the first one kept settles. */
	private width: number;

	constructor(
		/** The model the vectors came from; another model's cannot be compared with them. */
		readonly model: string,
		dimensions = 0,
	) {
		this.width = dimensions;
	}

	get dimensions(): number {
		return this.width;
	}

	/** How many notes have vectors. */
	get size(): number {
		return this.entries.size;
	}

	/** True when a note has vectors made from its text as it is now. */
	has(path: string, mtime: number, size: number): boolean {
		const entry = this.entries.get(path);
		return !!entry && entry.mtime === mtime && entry.size === size;
	}

	paths(): string[] {
		return [...this.entries.keys()];
	}

	/** Keeps a note's vectors, one for each of its chunks, in place of any it had. */
	set(path: string, mtime: number, size: number, chunks: readonly Chunk[], vectors: ReadonlyArray<readonly number[]>): void {
		if (vectors.length !== chunks.length) throw new Error(`${path}: ${chunks.length} chunks, ${vectors.length} vectors`);
		if (!this.width && vectors.length) this.width = vectors[0].length;
		for (const vector of vectors) {
			if (vector.length !== this.dimensions) {
				throw new Error(`${path}: a vector of ${vector.length} numbers, not ${this.dimensions}`);
			}
		}
		const needed = (this.count + vectors.length) * this.dimensions;
		if (needed > this.vectors.length) {
			const grown = new Int8Array(Math.max(needed, this.vectors.length * 2, this.dimensions * 64));
			grown.set(this.vectors.subarray(0, this.count * this.dimensions));
			this.vectors = grown;
		}
		const at = this.count;
		for (const vector of vectors) {
			const unit = normalized(vector);
			const offset = this.count * this.dimensions;
			for (let index = 0; index < this.dimensions; index++) {
				this.vectors[offset + index] = Math.max(-SCALE, Math.min(SCALE, Math.round(unit[index] * SCALE)));
			}
			this.count++;
		}
		this.entries.set(path, { mtime, size, chunks: chunks.map((chunk) => ({ ...chunk })), at });
		this.dirty = true;
	}

	delete(path: string): void {
		if (this.entries.delete(path)) this.dirty = true;
	}

	/**
	 * The notes among `allowed` by how near their nearest chunk lies to
	 * `query`, nearest first.
	 */
	search(query: readonly number[], allowed: (path: string) => boolean): SemanticHit[] {
		if (query.length !== this.dimensions) return [];
		const unit = normalized(query);
		const hits: SemanticHit[] = [];
		for (const [path, entry] of this.entries) {
			if (!entry.chunks.length || !allowed(path)) continue;
			let best = -Infinity;
			let nearest = 0;
			for (let chunk = 0; chunk < entry.chunks.length; chunk++) {
				const offset = (entry.at + chunk) * this.dimensions;
				let sum = 0;
				for (let index = 0; index < this.dimensions; index++) sum += this.vectors[offset + index] * unit[index];
				if (sum > best) {
					best = sum;
					nearest = chunk;
				}
			}
			hits.push({ path, score: best / SCALE, chunk: entry.chunks[nearest] });
		}
		return hits.sort((first, second) => second.score - first.score);
	}

	/**
	 * The index as a file: a header saying what it is, the notes and their
	 * chunks as JSON, then every vector, one byte a part, in the notes' order.
	 */
	serialize(): ArrayBuffer {
		const notes: Array<[string, number, number, number[]]> = [];
		let total = 0;
		for (const [path, entry] of this.entries) {
			notes.push([path, entry.mtime, entry.size, entry.chunks.flatMap((chunk) => [chunk.start, chunk.end])]);
			total += entry.chunks.length;
		}
		const header = new TextEncoder().encode(
			JSON.stringify({ version: INDEX_VERSION, model: this.model, dimensions: this.dimensions, notes }),
		);
		const buffer = new ArrayBuffer(12 + header.length + total * this.dimensions);
		const view = new DataView(buffer);
		view.setUint32(0, MAGIC);
		view.setUint32(4, INDEX_VERSION);
		view.setUint32(8, header.length);
		new Uint8Array(buffer, 12, header.length).set(header);
		const body = new Int8Array(buffer, 12 + header.length);
		let written = 0;
		for (const entry of this.entries.values()) {
			const length = entry.chunks.length * this.dimensions;
			body.set(this.vectors.subarray(entry.at * this.dimensions, entry.at * this.dimensions + length), written);
			written += length;
		}
		return buffer;
	}

	/**
	 * Reads an index file back, or null when it is not one, is from another
	 * version, or was cut short: the caller then starts again from nothing.
	 */
	static parse(buffer: ArrayBuffer): SemanticIndex | null {
		try {
			if (buffer.byteLength < 12) return null;
			const view = new DataView(buffer);
			if (view.getUint32(0) !== MAGIC || view.getUint32(4) !== INDEX_VERSION) return null;
			const length = view.getUint32(8);
			if (12 + length > buffer.byteLength) return null;
			const header: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length)));
			if (typeof header !== "object" || header === null) return null;
			const { model, dimensions, notes } = header as Record<string, unknown>;
			if (typeof model !== "string" || typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1) {
				return null;
			}
			if (!Array.isArray(notes)) return null;
			const index = new SemanticIndex(model, dimensions);
			const body = new Int8Array(buffer, 12 + length);
			let at = 0;
			for (const note of notes as unknown[]) {
				if (!Array.isArray(note) || note.length !== 4) return null;
				const [path, mtime, size, bounds] = note as unknown[];
				if (typeof path !== "string" || typeof mtime !== "number" || typeof size !== "number" || !Array.isArray(bounds)) {
					return null;
				}
				const chunks: Chunk[] = [];
				for (let pair = 0; pair + 1 < bounds.length; pair += 2) {
					const start: unknown = bounds[pair];
					const end: unknown = bounds[pair + 1];
					if (typeof start !== "number" || typeof end !== "number") return null;
					chunks.push({ start, end });
				}
				index.entries.set(path, { mtime, size, chunks, at });
				at += chunks.length;
			}
			if (at * dimensions !== body.length) return null;
			index.vectors = body.slice();
			index.count = at;
			index.dirty = false;
			return index;
		} catch {
			return null;
		}
	}
}

/** A note to keep vectors for. */
export interface IndexableNote {
	path: string;
	mtime: number;
	size: number;
	/** What is said of the note above its text, such as its mood and tags, which is embedded with each chunk. */
	heading: string;
	/** Its text as an editor holds it, which chunks are cut from; null when it cannot be read. */
	body(): Promise<string | null>;
}

/** Chunks embedded in one go, and notes between one saving of the index and the next. */
const EMBED_CHUNKS = 16;
const SAVE_EVERY = 200;

/** How many of `notes` have no vectors made from their text as it is now. */
export function staleNotes(index: SemanticIndex | null, notes: readonly IndexableNote[]): number {
	return index ? notes.filter((note) => !index.has(note.path, note.mtime, note.size)).length : notes.length;
}

/**
 * Brings an index up to date with `notes`: embeds the ones that are new or
 * changed, a few chunks at a time, and leaves the rest alone. `embed` asks
 * the model; `progress` hears how far it is; `save` is called now and then,
 * so a long first run that is stopped keeps what it did.
 */
export async function updateIndex(
	index: SemanticIndex,
	notes: readonly IndexableNote[],
	embed: (texts: string[]) => Promise<number[][]>,
	options: {
		signal: AbortSignal;
		progress?: (done: number, total: number) => void;
		save?: () => Promise<void>;
	},
): Promise<void> {
	const prompts = embeddingPrompts(index.model);
	const pending = notes.filter((note) => !index.has(note.path, note.mtime, note.size));
	let done = 0;
	let unsaved = 0;
	let batch: Array<{ note: IndexableNote; chunks: Chunk[]; texts: string[] }> = [];
	const flush = async (): Promise<void> => {
		if (!batch.length) return;
		const texts = batch.flatMap((item) => item.texts);
		const vectors = texts.length ? await embed(texts) : [];
		if (vectors.length !== texts.length) throw new Error(`${index.model} returned ${vectors.length} vectors for ${texts.length} texts`);
		let at = 0;
		for (const { note, chunks } of batch) {
			index.set(note.path, note.mtime, note.size, chunks, vectors.slice(at, at + chunks.length));
			at += chunks.length;
		}
		done += batch.length;
		unsaved += batch.length;
		batch = [];
		options.progress?.(done, pending.length);
		if (unsaved >= SAVE_EVERY && options.save) {
			unsaved = 0;
			await options.save();
		}
	};
	for (const note of pending) {
		if (options.signal.aborted) break;
		const body = await note.body();
		// A note that cannot be read is tried again next time; an empty one is kept as holding nothing.
		if (body === null) {
			done++;
			continue;
		}
		const chunks = chunksOf(body);
		const texts = chunks.map((chunk) =>
			prompts.document(`${note.heading ? `${note.heading}\n\n` : ""}${body.slice(chunk.start, chunk.end)}`),
		);
		batch.push({ note, chunks, texts });
		if (batch.reduce((sum, item) => sum + item.texts.length, 0) >= EMBED_CHUNKS) await flush();
	}
	if (!options.signal.aborted) await flush();
	if (index.dirty && options.save) await options.save();
}

/**
 * Two rankings of the same notes made into one, by reciprocal rank: a note
 * counts for what its place in each list is worth, so one near the top of
 * either is kept, and one near the top of both comes first. The scores of
 * the two cannot be compared, which is why their places are.
 */
export function fuseRankings(rankings: ReadonlyArray<readonly string[]>, weight = 60): Map<string, number> {
	const scores = new Map<string, number>();
	for (const ranking of rankings) {
		for (const [place, key] of ranking.entries()) scores.set(key, (scores.get(key) ?? 0) + 1 / (weight + place + 1));
	}
	return scores;
}
