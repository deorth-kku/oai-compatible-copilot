import * as vscode from "vscode";
import {
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatRequestMessage,
	LanguageModelToolCallPart,
	LanguageModelResponsePart2,
	LanguageModelThinkingPart,
	Progress,
	CancellationToken,
} from "vscode";
import { HFModelItem, CustomDataPartMimeTypes, TokenUsage } from "./types";
import { tryParseJSONObject } from "./utils";
import { logger } from "./logger";
import { VersionManager } from "./versionManager";

export abstract class CommonApi<TMessage, TRequestBody> {
	/** Buffer for assembling streamed tool calls by index. */
	protected _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	protected _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	protected _hasEmittedAssistantText = false;

	/** Track if we emitted any text. */
	protected _hasEmittedText = false;

	/** Track if we emitted any thinking text. */
	protected _hasEmittedThinking = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	protected _emittedBeginToolCallsHint = false;

	// XML think block parsing state
	protected _xmlThinkActive = false;
	protected _xmlThinkDetectionAttempted = false;

	// Thinking content state management
	protected _currentThinkingId: string | null = null;

	/** Buffer for accumulating thinking content before emitting. */
	protected _thinkingBuffer = "";

	/** Timer for delayed flushing of thinking buffer. */
	protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

	/**
	 * Cache of the last real reasoning text, keyed per turn *and* per conversation.
	 * Copilot Chat does not always round-trip assistant `LanguageModelThinkingPart`s
	 * into the next request's history (the thinking is only persisted as an opaque
	 * `ThinkingData` block that may be dropped on rebuild). When `convertMessages`
	 * cannot find a `LanguageModelThinkingPart` for an assistant turn, we replay
	 * the cached real reasoning instead of fabricating a placeholder.
	 *
	 * Keyed by `${convId}#${modelId}#${index}` where `index` is the absolute
	 * position the assistant response occupies in the (append-only) conversation
	 * and `convId` is a per-conversation id round-tripped via a data-part marker.
	 * The `convId` is what stops reasoning from one chat session leaking into
	 * another ("串台"): without it, two unrelated sessions with the same model and
	 * the same message count would share a cache key.
	 */
	private static readonly _reasoningByTurn: Map<string, string> = new Map<string, string>();

	/**
	 * Per-turn accumulator of reasoning text. Reasoning is streamed to the UI in
	 * 100ms-buffered chunks that are contiguous fragments of one continuous trace,
	 * so we must concatenate each chunk verbatim (no separators) rather than
	 * overwrite, otherwise only the final fragment survives and gets replayed
	 * next turn (e.g. "what they would like me to do next." instead of the
	 * full trace).
	 */
	protected _turnReasoning = "";

	/** Turn key (without convId) under which the current streaming turn's reasoning is cached. */
	protected _currentTurnKey = "";

	/**
	 * Per-conversation id derived from the request history. VS Code only
	 * round-trips plain text content (any extra data-parts are dropped — a VS Code
	 * bug), so we cannot carry a random session id forward. Instead we derive the
	 * id from the first user message's text content, which is stable for a given
	 * conversation and differs between conversations. This scopes the reasoning
	 * cache so sessions don't leak into each other ("串台").
	 */
	protected _convId = "";

	/**
	 * Derive and store the conversation id from the request messages. Called by
	 * the provider before `convertMessages`/`processStreamingResponse`. The id is
	 * recomputed every turn from the (append-only) history, so it stays aligned
	 * across turns of the same conversation without any round-tripped state.
	 */
	setConvIdFromMessages(messages: readonly LanguageModelChatRequestMessage[]): void {
		this._convId = CommonApi.computeConvId(messages);
	}

	/**
	 * Stable conversation id derived from the request history.
	 *
	 * The first user message is Copilot's injected environment/workspace context
	 * (system-like, near-identical across sessions in the same workspace), so it
	 * cannot distinguish conversations. We use the **second** user message — the
	 * user's actual prompt — which is stable for a conversation and differs between
	 * them. Only when there is no second user message (e.g. a brand-new single-turn
	 * request before the first prompt has been recorded) do we fall back to the
	 * first user message.
	 */
	private static computeConvId(messages: readonly LanguageModelChatRequestMessage[]): string {
		let userCount = 0;
		let firstUserText = "";
		for (const m of messages) {
			if (m.role !== vscode.LanguageModelChatMessageRole.User) {
				continue;
			}
			const text = (m.content ?? [])
				.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
				.map((p) => p.value)
				.join("")
				.trim();
			if (!text) {
				continue;
			}
			userCount++;
			if (userCount === 1) {
				firstUserText = text;
			} else if (userCount === 2) {
				// The user's real prompt — this is what distinguishes conversations.
				return CommonApi.hashString(text);
			}
		}
		// Fall back to the first (injected) user message, then to a structural
		// signature so distinct histories still get distinct ids.
		if (firstUserText) {
			return CommonApi.hashString(firstUserText);
		}
		const signature = messages.map((m) => m.role).join(",");
		return CommonApi.hashString(`empty:${messages.length}:${signature}`);
	}

	private static hashString(s: string): string {
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return h.toString(36);
	}

	/**
	 * Set the turn key for the current turn. Called by the provider before
	 * `convertMessages`/`processStreamingResponse` so both the replay lookup and
	 * the capture write target the same turn.
	 */
	setCurrentTurnKey(key: string): void {
		this._currentTurnKey = key;
	}

	/** Build the full cache key (conversation-scoped) for a turn key. */
	private reasoningKey(turnKey: string): string {
		return this._convId ? `${this._convId}#${turnKey}` : turnKey;
	}

	/** Record the real reasoning produced for this model so later turns can replay it. */
	protected cacheReasoning(text: string): void {
		if (text && this._currentTurnKey) {
			this._turnReasoning += text;
			CommonApi._reasoningByTurn.set(this.reasoningKey(this._currentTurnKey), this._turnReasoning);
		}
	}

	/**
	 * Reset the per-turn reasoning accumulator. Call this at the start of each
	 * streaming turn so a new turn accumulates fresh reasoning and the previously
	 * cached full trace remains available for convertMessages (which runs before
	 * streaming) to replay into the outgoing request.
	 */
	protected beginReasoningCapture(): void {
		this._turnReasoning = "";
	}

	/**
	 * Best-effort real reasoning for a given turn key, or undefined if none.
	 * @param turnKey The turn key (defaults to the current streaming turn).
	 */
	protected getCachedReasoning(turnKey?: string): string | undefined {
		const key = turnKey ?? this._currentTurnKey;
		const cached = key ? CommonApi._reasoningByTurn.get(this.reasoningKey(key)) : undefined;
		return cached ? cached.trim() : undefined;
	}

	/** System prompts to include in requests. */
	protected _systemContent: string | undefined;

	/** Set the model ID for logging purposes. */
	protected _modelId = "";

	/** Accumulated token usage from the API response. */
	protected _usage: TokenUsage | null = null;

	constructor(modelId: string) {
		this._modelId = modelId;
	}

	/**
	 * Convert VS Code chat messages to specific api message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig Config for special model.
	 * @param startIndex Absolute index of `messages[0]` in the full conversation
	 *   (default 0). Used to derive per-turn cache keys that stay aligned with the
	 *   streaming capture key even when only a delta slice is converted.
	 * @returns Specific api messages array.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean },
		startIndex?: number
	): TMessage[];

	/**
	 * Construct request body for Specific api
	 * @param rb Specific api Request body
	 * @param um Current Model Info
	 * @param options From VS Code
	 */
	abstract prepareRequestBody(
		rb: TRequestBody,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): TRequestBody;

	/**
	 * Process specific api streaming response (JSON lines format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	abstract processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void>;

	/**
	 * Create a message stream for the specific API.
	 * @param model The model to use.
	 * @param systemPrompt The system prompt to use.
	 * @param messages The messages to send.
	 * @param baseUrl The base URL for the API.
	 * @param apiKey The API key to use.
	 * @returns An async iterable of text chunks.
	 */
	abstract createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }>;

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		let parameters = canParse.value;
		parameters = this.adjustReadFileParameters(buf.name, parameters);
		progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			// [FIX] Normalize empty args to "{}" for parameterless tool calls
			const argsText = buf.args.trim() || "{}";
			const parsed = tryParseJSONObject(argsText);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			let parameters = parsed.value;
			parameters = this.adjustReadFileParameters(name, parameters);
			progress.report(new LanguageModelToolCallPart(id, name, parameters));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	/**
	 * Adjust read_file tool parameters to default to reading configurable number of lines.
	 * @param toolName The name of the tool being called.
	 * @param parameters The tool parameters.
	 * @returns Adjusted parameters.
	 */
	protected adjustReadFileParameters(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
		if (toolName !== "read_file") {
			return parameters;
		}
		const config = vscode.workspace.getConfiguration();
		const defaultLines = config.get<number>("oaicopilot.readFileLines", 0);
		if (defaultLines <= 0) {
			return parameters;
		}

		const startLine = typeof parameters.startLine === "number" ? parameters.startLine : 1;
		const endLine = typeof parameters.endLine === "number" ? parameters.endLine : startLine;
		if (endLine < startLine + defaultLines) {
			return { ...parameters, endLine: startLine + defaultLines };
		}
		return parameters;
	}

	/**
	 * Report to VS Code for ending thinking
	 * @param progress Progress reporter for parts
	 */
	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>) {
		if (!this._currentThinkingId) {
			return;
		}
		// Always clean up state after attempting to end the thinking sequence
		try {
			this.flushThinkingBuffer(progress);
			// End the current thinking sequence with empty content and same ID
			progress.report(new LanguageModelThinkingPart("", this._currentThinkingId));
		} catch (e) {
			console.error("[OAI Compatible Model Provider] Failed to end thinking sequence:", e);
		}
		this._currentThinkingId = null;
		// Clear thinking buffer and timer since sequence ended
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
	}

	/**
	 * Generate a unique thinking ID based on request start time and random suffix
	 */
	protected generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Buffer and schedule a flush for thinking content.
	 * @param text The thinking text to buffer
	 * @param progress Progress reporter for parts
	 */
	protected bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		this._hasEmittedThinking = true;
		// Generate thinking ID if not provided by the model
		if (!this._currentThinkingId) {
			this._currentThinkingId = this.generateThinkingId();
		}

		// Append to thinking buffer
		this._thinkingBuffer += text;

		// Schedule flush with 100ms delay
		if (!this._thinkingFlushTimer) {
			this._thinkingFlushTimer = setTimeout(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	/**
	 * Flush the thinking buffer to the progress reporter.
	 * @param progress Progress reporter for parts.
	 */
	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		// Always clear existing timer first
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}

		// Flush current buffer if we have content
		if (this._thinkingBuffer && this._currentThinkingId) {
			const text = this._thinkingBuffer;
			this._thinkingBuffer = "";
			this.cacheReasoning(text);
			progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId));
		}
	}

	/**
	 * Prepare headers for API request.
	 * @param apiKey The API key to use.
	 * @param apiMode The apiMode (affects header format).
	 * @param customHeaders Optional custom headers from model config.
	 * @returns Headers object.
	 */
	public static prepareHeaders(
		apiKey: string,
		apiMode: string,
		customHeaders?: Record<string, string>
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": VersionManager.getUserAgent(),
		};

		// Provider-specific header formats
		if (apiMode === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
		} else if (apiMode === "gemini") {
			headers["x-goog-api-key"] = apiKey;
			headers["Accept"] = "text/event-stream";
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		// Merge custom headers
		if (customHeaders) {
			return { ...headers, ...customHeaders };
		}

		return headers;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	protected processTextContent(input: string, progress: Progress<LanguageModelResponsePart2>): { emittedAny: boolean } {
		let emittedAny = false;

		// Emit any visible text
		const textToEmit = input;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedAny = true;
		}

		return { emittedAny };
	}

	/**
	 * Process streamed text content for XML think blocks and buffer thinking content.
	 * Returns whether any XML think tags were processed (preventing text fallback).
	 */
	protected processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		// If we've already attempted detection and found no THINK_START, skip processing
		if (this._xmlThinkDetectionAttempted && !this._xmlThinkActive) {
			return { emittedAny: false };
		}

		const THINK_START = "<think>";
		const THINK_END = "</think>";

		let data = input;
		let emittedAny = false;

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				// Look for think start tag
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					// No think start found, mark detection as attempted and skip future processing
					this._xmlThinkDetectionAttempted = true;
					data = "";
					break;
				}

				// Found think start tag - mark that we processed XML tags
				emittedAny = true;
				this._xmlThinkActive = true;

				// Skip the start tag and continue processing
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			// We are inside a think block, look for end tag
			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
				this.bufferThinkingContent(data, progress);
				emittedAny = true;
				data = "";
				break;
			}

			// Found end tag, buffer final thinking content before the end tag
			const thinkContent = data.slice(0, endIdx);
			this.bufferThinkingContent(thinkContent, progress);

			// Mark end tag as processed and reset state
			emittedAny = true;
			this._xmlThinkActive = false;
			data = data.slice(endIdx + THINK_END.length);
		}

		return { emittedAny };
	}

	/**
	 * Report accumulated token usage as a LanguageModelDataPart so VS Code
	 * can display usage stats in the Context Window widget.
	 */
	protected reportUsage(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this._usage) {
			return;
		}
		logger.info("usage.report", { modelId: this._modelId, usage: this._usage });
		try {
			const bytes = new TextEncoder().encode(JSON.stringify(this._usage));
			progress.report(new vscode.LanguageModelDataPart(bytes, CustomDataPartMimeTypes.Usage));
		} catch (e) {
			logger.error("usage.report.error", { modelId: this._modelId, error: e instanceof Error ? e.message : String(e) });
		}
	}
}
