/**
 * What Reflection needs from a local model server. Ollama is the only
 * implementation for now (`ollama.ts`); the interface leaves room for LM
 * Studio or llama.cpp without the rest of the feature knowing which it talks to.
 */

export interface ModelInfo {
	name: string;
	/** The model can call tools, which custom prompts need to choose their own notes. */
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

export interface ReflectionProvider {
	/** The models installed on the server. Throws `ProviderError("unreachable")` when nothing answers. */
	listModels(): Promise<ModelInfo[]>;
	/** One model's capabilities and context length. Throws `ProviderError("model-missing")` when it is not installed. */
	showModel(name: string): Promise<ModelInfo>;
	/** Streams one answer. Throws `ProviderError("aborted")` when the signal fires. */
	chat(request: ChatRequest): Promise<ChatResult>;
}

/** What to tell the reader when the server answers but has nothing to run. */
export const NO_MODELS_MESSAGE = "Ollama answers, but no model is installed yet (try: ollama pull gemma4:e4b)";

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
