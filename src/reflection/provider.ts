/**
 * What Reflection needs from a local model server. Ollama is the only
 * implementation for now (`ollama.ts`); the interface leaves room for LM
 * Studio or llama.cpp without the rest of the feature knowing which it talks to.
 */

export interface ModelInfo {
	name: string;
	/** The model can call tools, which every reflection needs to read the journal. */
	tools: boolean;
	/** The model reasons before answering unless told not to. */
	thinking: boolean;
	/** The longest context the model takes, in tokens, when the server says. */
	contextLength: number | null;
}

/** A tool the model may call, described by a JSON schema of its arguments. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** A call the model asked for, with the arguments it gave; they are not checked yet. */
export interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export type ChatMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: ToolCall[] }
	/** What a tool returned, for the call of that name before it. */
	| { role: "tool"; content: string; toolName: string };

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	/** The context window to ask for, in tokens: prompt plus room for the answer. */
	numCtx: number;
	/** Aborting stops the request; text written so far has already been delivered. */
	signal: AbortSignal;
	/** Receives the answer as it is written. Called once with all of it when streaming is unavailable. */
	onText: (delta: string) => void;
	/** Tools the model may call instead of answering; their calls come back in `toolCalls`. */
	tools?: ToolDefinition[];
}

export interface ChatResult {
	text: string;
	/** Tokens the server counted in the prompt, to check the estimate against. */
	promptTokens: number | null;
	/** Why the server stopped: "stop" when the answer was complete, "length" when it ran out of room. */
	doneReason: string | null;
	/** False when the answer arrived in one piece, through the fallback. */
	streamed: boolean;
	/** The tools the model asked to call, in order; empty when it answered. */
	toolCalls: ToolCall[];
}

/** `no-tools`: the model was offered tools and the server says it cannot use them. */
export type ProviderErrorKind = "unreachable" | "model-missing" | "no-tools" | "aborted" | "failed";

export class ProviderError extends Error {
	constructor(
		readonly kind: ProviderErrorKind,
		message: string,
	) {
		super(message);
		this.name = "ProviderError";
	}
}

/** What the server has installed: the models that write answers, and by name those that only embed text. */
export interface InstalledModels {
	chat: ModelInfo[];
	embedding: string[];
}

export interface ReflectionProvider {
	/** The models installed on the server that write answers. Throws `ProviderError("unreachable")` when nothing answers. */
	listModels(): Promise<ModelInfo[]>;
	/** Every model installed on the server, by what it does. Throws as `listModels` does. */
	listInstalled(): Promise<InstalledModels>;
	/**
	 * Turns texts into vectors with an embedding model, one for each, for
	 * search by meaning. Throws `ProviderError("model-missing")` when the
	 * model is not installed, and `ProviderError("aborted")` when the signal fires.
	 */
	embed(model: string, texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
	/** One model's capabilities and context length. Throws `ProviderError("model-missing")` when it is not installed. */
	showModel(name: string): Promise<ModelInfo>;
	/** Streams one answer. Throws `ProviderError("aborted")` when the signal fires. */
	chat(request: ChatRequest): Promise<ChatResult>;
}

/**
 * The model the window suggests pulling. Reflection is tuned and judged on
 * models of about this size and up; smaller ones find and read notes too
 * unreliably to suggest.
 */
export const SUGGESTED_MODEL = "gemma4:26b";

/**
 * The model reflections use while none is chosen: the suggested one when it
 * is installed, else the first that can use tools, else the first, which a
 * run then says cannot read the journal.
 */
export function defaultModel(models: readonly ModelInfo[]): ModelInfo | null {
	return (
		models.find((model) => model.tools && model.name === SUGGESTED_MODEL) ??
		models.find((model) => model.tools) ??
		models[0] ??
		null
	);
}

/**
 * The embedding model the settings suggest pulling for search by meaning.
 * Of those compared on the sample journal it found the most, reads over a
 * hundred languages, and is small; its larger tags add only encoders for
 * images and sound, which a journal's text does not use.
 */
export const SUGGESTED_EMBEDDING_MODEL = "embeddinggemma-2:270m";

/** The embedding model search by meaning uses while none is chosen: the suggested one when installed, else the first. */
export function defaultEmbeddingModel(models: readonly string[]): string | null {
	return models.find((model) => model === SUGGESTED_EMBEDDING_MODEL) ?? models[0] ?? null;
}

/** What to tell the reader when the server answers but has nothing to run. */
export const NO_MODELS_MESSAGE = `Ollama answers, but no model is installed yet (try: ollama pull ${SUGGESTED_MODEL})`;

/** What to tell the reader when the model cannot call tools, which is how a reflection reads the journal. */
export const NO_TOOLS_MESSAGE =
	"This model cannot use tools, which a reflection needs to read your journal. Choose another model in the Reflect window's settings.";

/** What to tell the reader when a request to the model server fails. */
export function describeProviderError(error: unknown): string {
	if (error instanceof ProviderError) {
		switch (error.kind) {
			case "unreachable":
				return "Ollama is not answering. Install it from ollama.com and start it, then try again.";
			case "aborted":
				return "Stopped.";
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : String(error);
}
