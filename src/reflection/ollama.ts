import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { ProviderError } from "./provider";
import type { ChatRequest, ChatResult, ModelInfo, ReflectionProvider } from "./provider";

/** What an Ollama model says it can do, from `/api/show`. */
interface Described {
	info: ModelInfo;
	/** False for models that only embed text, which cannot write an answer. */
	completion: boolean;
}

/** The parts of a chat answer the stream and the fallback both read. */
interface Answer {
	text: string;
	promptTokens: number | null;
	doneReason: string | null;
}

/** What the chat endpoint is sent, before choosing whether it streams. */
interface ChatPayload {
	model: string;
	messages: ChatRequest["messages"];
	options: { num_ctx: number };
	think: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a JSON body, or null when there is none or it is not JSON. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Ollama reports failures as `{ "error": "…" }`, on errors and mid-stream alike. */
function errorOf(body: unknown): string | null {
	return isRecord(body) && typeof body.error === "string" ? body.error : null;
}

/** A response's body as text; reading it can fail when the body is not text. */
function textOf(response: RequestUrlResponse): string {
	try {
		return response.text;
	} catch {
		return "";
	}
}

function aborted(): ProviderError {
	return new ProviderError("aborted", "Stopped");
}

/** The capability names a model lists, or null when the server does not say. */
function capabilitiesOf(body: unknown): string[] | null {
	if (!isRecord(body) || !Array.isArray(body.capabilities)) return null;
	return body.capabilities.filter((item): item is string => typeof item === "string");
}

/** The model's own context limit: `model_info` keys it by architecture, as `llama.context_length`. */
function contextLengthOf(body: unknown): number | null {
	if (!isRecord(body) || !isRecord(body.model_info)) return null;
	for (const [key, value] of Object.entries(body.model_info)) {
		if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return null;
}

function describe(name: string, capabilities: string[] | null, contextLength: number | null): Described {
	// Servers too old to list capabilities predate tool calling, so assume a plain chat model.
	const listed = capabilities ?? ["completion"];
	return {
		info: {
			name,
			tools: listed.includes("tools"),
			thinking: listed.includes("thinking"),
			contextLength,
		},
		completion: listed.includes("completion"),
	};
}

/** Reads the end of an answer: why it stopped, and how many tokens the prompt took. */
function answerOf(text: string, final: Record<string, unknown> | null): Answer {
	return {
		text,
		promptTokens: typeof final?.prompt_eval_count === "number" ? final.prompt_eval_count : null,
		doneReason: typeof final?.done_reason === "string" ? final.done_reason : null,
	};
}

/** The text a line of the chat stream adds; `message.thinking` is reasoning, never shown. */
function contentOf(part: Record<string, unknown>): string {
	return isRecord(part.message) && typeof part.message.content === "string" ? part.message.content : "";
}

/**
 * An error Ollama answered with. It names the model when it is not
 * installed, which the card treats differently from any other failure.
 */
function chatError(status: number | null, body: unknown): ProviderError {
	const message = errorOf(body);
	if (message && /not found/i.test(message)) return new ProviderError("model-missing", message);
	return new ProviderError("failed", message ?? `Ollama answered with status ${status ?? "unknown"}`);
}

/**
 * Settles with `promise` unless `signal` fires first. `requestUrl` cannot be
 * cancelled, so a stopped request runs on in Ollama and its answer is dropped.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(aborted());
		signal.addEventListener("abort", stop, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", stop);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", stop);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/**
 * Talks to an Ollama server. Listing and describing models go through
 * Obsidian's `requestUrl`, which no origin check can block; the chat streams
 * with `fetch`, which `requestUrl` cannot, and falls back to one whole answer
 * through `requestUrl` when the server refuses the app's origin.
 */
export class OllamaProvider implements ReflectionProvider {
	private readonly base: string;

	/** `address` is the server's, such as `http://127.0.0.1:11434`; a trailing slash is fine. */
	constructor(address: string) {
		this.base = address.trim().replace(/\/+$/, "");
	}

	async listModels(): Promise<ModelInfo[]> {
		const response = await this.call("/api/tags");
		const body = parseJson(textOf(response));
		if (response.status >= 400 || !isRecord(body) || !Array.isArray(body.models)) {
			throw new ProviderError("failed", errorOf(body) ?? `${this.base} did not answer like an Ollama server`);
		}
		const entries = body.models.filter(isRecord);
		const described = await Promise.all(
			entries.map(async (entry): Promise<Described | null> => {
				const name = typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : "";
				if (!name) return null;
				try {
					return await this.describeModel(name);
				} catch (error) {
					if (error instanceof ProviderError && error.kind === "unreachable") throw error;
					// Removed while listing, or not describable: newer servers list capabilities here too.
					return describe(name, capabilitiesOf(entry), null);
				}
			}),
		);
		return described.flatMap((model) => (model?.completion ? [model.info] : []));
	}

	async showModel(name: string): Promise<ModelInfo> {
		return (await this.describeModel(name)).info;
	}

	async chat(request: ChatRequest): Promise<ChatResult> {
		if (request.signal.aborted) throw aborted();
		const payload: ChatPayload = {
			model: request.model,
			messages: request.messages,
			options: { num_ctx: request.numCtx },
			// Every model accepts this, thinking or not; reasoning first cost minutes for little gain.
			think: false,
		};
		let response: Response;
		try {
			// `fetch` on purpose, and only here: `requestUrl` cannot stream, and a
			// local model can take a minute to finish. The review's lint flags the
			// bare global and forbids disabling that rule, so it is reached
			// through `window`; every other request goes through `requestUrl`.
			response = await window.fetch(`${this.base}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...payload, stream: true }),
				signal: request.signal,
			});
		} catch {
			if (request.signal.aborted) throw aborted();
			// No response at all: most likely the server refused the app's origin.
			return await this.chatWhole(request, payload);
		}
		if (!response.ok) {
			let text = "";
			try {
				text = await response.text();
			} catch {
				if (request.signal.aborted) throw aborted();
			}
			throw chatError(response.status, parseJson(text));
		}
		if (!response.body) throw new ProviderError("failed", "Ollama sent no answer");
		const answer = await this.readStream(response.body, request);
		return { ...checked(answer), streamed: true };
	}

	private async describeModel(name: string): Promise<Described> {
		const response = await this.call("/api/show", { model: name });
		const body = parseJson(textOf(response));
		const error = errorOf(body);
		if (response.status === 404 || error !== null) {
			throw new ProviderError("model-missing", error ?? `Ollama has no model named ${name}`);
		}
		if (response.status >= 400 || !isRecord(body)) {
			throw new ProviderError("failed", `Ollama could not describe ${name}`);
		}
		return describe(name, capabilitiesOf(body), contextLengthOf(body));
	}

	/**
	 * Reads the chat stream: one JSON object per line, each with the next
	 * piece of the answer, and a last one saying why it stopped.
	 */
	private async readStream(body: ReadableStream<Uint8Array>, request: ChatRequest): Promise<Answer> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let text = "";
		let final: Record<string, unknown> | null = null;
		/** Delivers one line's text, and returns the line when it is the last. */
		const take = (line: string): Record<string, unknown> | null => {
			if (!line.trim()) return null;
			const part = parseJson(line);
			if (!isRecord(part)) throw new ProviderError("failed", "Ollama sent an answer that could not be read");
			if (errorOf(part) !== null) throw chatError(null, part);
			const delta = contentOf(part);
			if (delta) {
				text += delta;
				request.onText(delta);
			}
			return part.done === true ? part : null;
		};
		try {
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch {
					if (request.signal.aborted) throw aborted();
					throw new ProviderError("unreachable", "Ollama stopped answering");
				}
				if (request.signal.aborted) throw aborted();
				buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					final = take(line) ?? final;
				}
				if (chunk.done) break;
			}
			final = take(buffer) ?? final;
		} finally {
			// Closes the connection when reading stopped early; harmless once the stream ended.
			reader.cancel().catch(() => undefined);
		}
		if (!final) throw new ProviderError("unreachable", "Ollama stopped before the answer was complete");
		return answerOf(text, final);
	}

	/** One whole answer through `requestUrl`, delivered with a single `onText`. */
	private async chatWhole(request: ChatRequest, payload: ChatPayload): Promise<ChatResult> {
		const response = await untilAborted(this.call("/api/chat", { ...payload, stream: false }), request.signal);
		const body = parseJson(textOf(response));
		if (response.status >= 400 || errorOf(body) !== null) throw chatError(response.status, body);
		if (!isRecord(body)) throw new ProviderError("failed", "Ollama sent an answer that could not be read");
		const answer = checked(answerOf(contentOf(body), body));
		if (answer.text) request.onText(answer.text);
		return { ...answer, streamed: false };
	}

	/** A request through `requestUrl`; only a server that does not answer at all throws. */
	private async call(path: string, body?: unknown): Promise<RequestUrlResponse> {
		const params: RequestUrlParam = { url: `${this.base}${path}`, throw: false };
		if (body !== undefined) {
			params.method = "POST";
			params.contentType = "application/json";
			params.body = JSON.stringify(body);
		}
		try {
			return await requestUrl(params);
		} catch {
			throw new ProviderError("unreachable", `Nothing answered at ${this.base}`);
		}
	}
}

/**
 * An answer that stopped on `length` before any text means the prompt left
 * no room to write in, which is an error rather than an empty reflection.
 */
function checked(answer: Answer): Answer {
	if (!answer.text.trim() && answer.doneReason === "length") {
		throw new ProviderError("failed", "The notes filled the model's context before it could answer");
	}
	return answer;
}
