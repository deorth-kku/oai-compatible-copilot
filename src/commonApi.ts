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
import { tryParseJSONObject, mapRole } from "./utils";
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
	 * Cache of the real reasoning text per turn, per conversation.
	 * Copilot Chat does not always round-trip assistant `LanguageModelThinkingPart`s
	 * into the next request's history (the thinking is only persisted as an opaque
	 * `ThinkingData` block that may be dropped on rebuild). When `convertMessages`
	 * cannot find a `LanguageModelThinkingPart` for an assistant turn, we replay
	 * the cached real reasoning instead of fabricating a placeholder.
	 *
	 * Keyed by `${convId}#${turnHash}` where `turnHash` is a content hash of the
	 * assistant turn's text + tool calls (see `computeTurnHashFromParts`) and
	 * `convId` is a per-conversation id derived from the request history (see
	 * `computeConvId`). A content hash — unlike the positional index the cache
	 * used to be keyed by — survives context compression/summarization, which
	 * shortens the history and shifts indices (which used to break replay and
	 * could even misattribute one turn's reasoning to another). The key is
	 * intentionally model-agnostic so that switching models mid-session keeps
	 * replaying the same turn's reasoning instead of dropping it.
	 *
	 * The entry is written at the end of the streaming turn (see
	 * `endTurnCapture`) because the content hash is only known once the turn's
	 * text/tool calls have been emitted.
	 *
	 * Older caches were keyed by positional index (`${convId}#${index}`, and
	 * before that `${convId}#${modelId}#${index}`); `hydrate` drops those
	 * persisted entries on load because they cannot be mapped to content hashes.
	 *
	 * The `convId` is what stops reasoning from one chat session leaking into
	 * another ("串台"): without it, two unrelated sessions with the same message
	 * content would share a cache key.
	 */
	private static readonly _reasoningByTurn: Map<string, string> = new Map<string, string>();

	/**
	 * Persisted mirror of `_reasoningByTurn` in `context.globalState` (Memento) so the
	 * reasoning replay survives extension reload / window restart. The in-memory `Map`
	 * remains the synchronous hot cache (`getCachedReasoning` runs inside the synchronous
	 * `convertMessages`), and we write through to storage on a debounce. Storage reads
	 * are synchronous (`Memento.get`), so `hydrate` can populate the Map at `activate()`
	 * before any request runs.
	 */
	private static readonly REASONING_CACHE_KEY = "oaicopilot.reasoningCache";
	private static readonly REASONING_CACHE_MAX_DEFAULT = 1024;
	private static _memento: vscode.Memento | null = null;
	private static _persistTimer: NodeJS.Timeout | null = null;

	/** Attach the Memento used to persist the reasoning cache across sessions. */
	static setMemento(memento: vscode.Memento): void {
		CommonApi._memento = memento;
	}

	/**
	 * Validate a persisted cache key against the current on-disk format
	 * (`${convId}#${turnHash}`), returning the key to keep or `null` to drop.
	 *
	 * Older versions keyed the cache by the turn's positional index
	 * (`${convId}#${index}`, and before that `${convId}#${modelId}#${index}`).
	 * Positional keys cannot be mapped to the content-hash scheme, so they are
	 * dropped on hydrate. The turn key is the last `#`-separated segment: old
	 * keys end in a plain numeric index, while new keys end in a base-36 content
	 * hash. (An all-digit base-36 hash is extremely unlikely; at worst it would
	 * cost one cache miss.)
	 */
	private static migrateCacheKey(key: string): string | null {
		const parts = key.split("#");
		if (parts.length < 2) {
			return null;
		}
		const turnKey = parts[parts.length - 1];
		if (/^\d+$/.test(turnKey)) {
			return null;
		}
		return key;
	}

	/** Load any persisted cache from storage into the in-memory Map. Call at activate(). */
	static hydrate(): void {
		if (!CommonApi._memento) {
			return;
		}
		try {
			const stored = CommonApi._memento.get<Record<string, string>>(CommonApi.REASONING_CACHE_KEY);
			if (stored && typeof stored === "object") {
				for (const [k, v] of Object.entries(stored)) {
					if (typeof k === "string" && typeof v === "string") {
						const migrated = CommonApi.migrateCacheKey(k);
						if (migrated !== null) {
							CommonApi._reasoningByTurn.set(migrated, v);
						}
					}
				}
			}
		} catch (e) {
			logger.error("reasoningCache.hydrate.error", { error: e instanceof Error ? e.message : String(e) });
		}
	}

	/** Max number of entries to keep (LRU). <= 0 means unbounded. */
	private static getMaxEntries(): number {
		const cfg = vscode.workspace.getConfiguration();
		const max = cfg.get<number>("oaicopilot.reasoningCacheMax", CommonApi.REASONING_CACHE_MAX_DEFAULT);
		return typeof max === "number" && max > 0 ? Math.floor(max) : 0;
	}

	/** Evict oldest entries (front of the insertion-ordered Map) when over the cap. */
	private static enforceCap(): void {
		const max = CommonApi.getMaxEntries();
		if (max <= 0) {
			return;
		}
		let overflow = CommonApi._reasoningByTurn.size - max;
		if (overflow <= 0) {
			return;
		}
		for (const key of CommonApi._reasoningByTurn.keys()) {
			if (overflow <= 0) {
				break;
			}
			CommonApi._reasoningByTurn.delete(key);
			overflow--;
		}
	}

	/** Schedule a debounced write-through of the current Map to storage. */
	private static schedulePersist(): void {
		if (!CommonApi._memento) {
			return;
		}
		CommonApi.enforceCap();
		if (CommonApi._persistTimer) {
			clearTimeout(CommonApi._persistTimer);
		}
		CommonApi._persistTimer = setTimeout(() => {
			void CommonApi.flushNow();
		}, 500);
	}

	/** Force an immediate write-through to storage (best-effort, never throws). */
	static async flushNow(): Promise<void> {
		if (!CommonApi._memento) {
			return;
		}
		if (CommonApi._persistTimer) {
			clearTimeout(CommonApi._persistTimer);
			CommonApi._persistTimer = null;
		}
		try {
			const record: Record<string, string> = {};
			for (const [k, v] of CommonApi._reasoningByTurn.entries()) {
				record[k] = v;
			}
			await CommonApi._memento.update(CommonApi.REASONING_CACHE_KEY, record);
		} catch (e) {
			logger.error("reasoningCache.persist.error", { error: e instanceof Error ? e.message : String(e) });
		}
	}

	/**
	 * Per-turn accumulator of reasoning text. Reasoning is streamed to the UI in
	 * 100ms-buffered chunks that are contiguous fragments of one continuous trace,
	 * so we must concatenate each chunk verbatim (no separators) rather than
	 * overwrite, otherwise only the final fragment survives and gets replayed
	 * next turn (e.g. "what they would like me to do next." instead of the
	 * full trace).
	 */
	protected _turnReasoning = "";

	/**
	 * The assistant parts (text + tool calls, in emit order) reported to VS Code
	 * during the current streaming turn. Retained so the turn's content hash
	 * (the cache key) can be computed at the end of the turn — the hash is only
	 * known once the turn's content has been emitted. Thinking/data parts are
	 * not recorded: they are excluded from the hash so it stays aligned with
	 * what VS Code round-trips into history.
	 */
	protected _turnAssistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];

	/**
	 * Per-conversation id derived from the request history. VS Code only
	 * round-trips plain text content (any extra data-parts are dropped — a VS Code
	 * bug), so we cannot carry a random session id forward. Instead we derive the
	 * id from the *original* (pre-sanitize) system prompt, which Copilot seeds
	 * with a per-session UUID (the VSCODE_TARGET_SESSION_LOG line), so it is
	 * unique per session and stable across turns of the same session. This scopes
	 * the reasoning cache so sessions don't leak into each other ("串台").
	 */
	protected _convId = "";

	/**
	 * Derive and store the conversation id from the request messages. Called by
	 * the provider before `convertMessages`/`processStreamingResponse`. The id is
	 * recomputed every turn from the (append-only) history, so it stays aligned
	 * across turns of the same conversation without any round-tripped state.
	 *
	 * IMPORTANT: pass the *original* messages (before any sanitization such as
	 * splitting the system prompt), otherwise the per-session UUID line
	 * (VSCODE_TARGET_SESSION_LOG) is no longer in the first system message and
	 * the id would collide across sessions.
	 */
	setConvIdFromMessages(messages: readonly LanguageModelChatRequestMessage[]): void {
		this._convId = CommonApi.computeConvId(messages);
	}

	/**
	 * The conversation id derived by {@link setConvIdFromMessages} ("" until it
	 * is set). Used by the provider to track the llama.cpp disk KV cache id
	 * per conversation (see `llamaSlotCache.ts`).
	 */
	getConvId(): string {
		return this._convId;
	}

	/**
	 * Stable conversation id derived from the request history.
	 *
	 * Preferred: the first non-empty **system**-role message. Copilot injects a
	 * per-session UUID into the system prompt (the VSCODE_TARGET_SESSION_LOG
	 * line), so it is unique per session and stable across that session's turns.
	 *
	 * Fallback (when there is no system message): the **second** user message —
	 * the user's actual prompt — which is stable for a conversation and differs
	 * between them; then the first user message; then a structural signature so
	 * distinct histories still get distinct ids.
	 */
	private static computeConvId(messages: readonly LanguageModelChatRequestMessage[]): string {
		let systemText = "";
		let userCount = 0;
		let firstUserText = "";
		let secondUserText = "";
		for (const m of messages) {
			const text = (m.content ?? [])
				.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
				.map((p) => p.value)
				.join("")
				.trim();
			if (!text) {
				continue;
			}
			// mapRole returns "system" for anything that is neither User nor
			// Assistant (the shipped @types/vscode enum only defines User/Assistant,
			// while the runtime System role is 3).
			switch (mapRole(m)) {
				case "system":
					if (!systemText) {
						systemText = text;
					}
					break;
				case "user":
					userCount++;
					if (userCount === 1) {
						firstUserText = text;
					} else if (userCount === 2) {
						// The user's real prompt — this is what distinguishes conversations.
						secondUserText = text;
					}
					break;
				case "assistant":
					// Assistant turns don't contribute to the conversation id.
					break;
			}
		}
		// Preferred: the system prompt (per-session UUID makes it unique per session).
		if (systemText) {
			return CommonApi.hashString(systemText);
		}
		// Fallback: the user's real prompt (second user message), then the first
		// (injected) user message, then a structural signature so distinct
		// histories still get distinct ids.
		if (secondUserText) {
			return CommonApi.hashString(secondUserText);
		}
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
	 * Normalize an ordered part sequence into content fragments: consecutive
	 * text parts are merged and trimmed into `T<text>` fragments; tool calls
	 * become `C<name>~<canonicalJson(input)>` fragments. Thinking, data and
	 * tool-result parts are excluded — thinking is what the cache is meant to
	 * recover, and data parts are opaque blobs that may be dropped on rebuild.
	 *
	 * Merging consecutive text (and trimming each merged segment) makes the hash
	 * insensitive to how VS Code splits/merges text parts when it round-trips
	 * the message, and to whitespace-only flush parts. Returns `null` when the
	 * sequence carries no text/tool-call content (e.g. a pure-thinking turn),
	 * which must not be hashed — an empty hash would collide across turns.
	 */
	static turnFragments(parts: readonly unknown[]): string[] | null {
		const frags: string[] = [];
		let buf = "";
		for (const part of parts) {
			if (part instanceof vscode.LanguageModelTextPart) {
				buf += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const text = buf.trim();
				if (text) {
					frags.push(`T${text}`);
				}
				buf = "";
				frags.push(`C${part.name}~${CommonApi.canonicalJson(part.input ?? {})}`);
			}
		}
		const text = buf.trim();
		if (text) {
			frags.push(`T${text}`);
		}
		return frags.length > 0 ? frags : null;
	}

	/**
	 * Content hash identifying an assistant turn (see {@link turnFragments}).
	 * Used as the reasoning-cache turn key on both sides: the write side hashes
	 * the parts emitted to VS Code, the read side hashes the parts VS Code
	 * round-trips into history — the same normalization keeps them aligned.
	 * Returns `null` when the turn has no text/tool-call content to hash.
	 */
	static computeTurnHashFromParts(parts: readonly unknown[]): string | null {
		const frags = CommonApi.turnFragments(parts);
		return frags ? CommonApi.hashString(frags.join("\u0000")) : null;
	}

	/**
	 * Deterministic JSON serialization for hashing: object keys sorted
	 * recursively, so the result does not depend on key order (which differs
	 * between what we emit and what VS Code round-trips).
	 */
	private static canonicalJson(value: unknown): string {
		if (value === null || typeof value !== "object") {
			return JSON.stringify(value) ?? "null";
		}
		if (Array.isArray(value)) {
			return `[${value.map((v) => CommonApi.canonicalJson(v)).join(",")}]`;
		}
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${CommonApi.canonicalJson(obj[k])}`).join(",")}}`;
	}

	/** Build the full cache key (conversation-scoped) for a turn key. */
	private reasoningKey(turnKey: string): string {
		return this._convId ? `${this._convId}#${turnKey}` : turnKey;
	}

	/**
	 * Append streamed reasoning text to the per-turn accumulator. The cache
	 * entry itself is written at the end of the turn (see `endTurnCapture`),
	 * because the turn's content hash is only known once its text/tool calls
	 * have been emitted.
	 */
	protected cacheReasoning(text: string): void {
		if (text) {
			this._turnReasoning += text;
		}
	}

	/**
	 * Reset the per-turn reasoning accumulator and assistant-parts capture.
	 * Call this at the start of each streaming turn so a new turn accumulates
	 * fresh reasoning and the previously cached full trace remains available
	 * for convertMessages (which runs before streaming) to replay into the
	 * outgoing request.
	 */
	protected beginReasoningCapture(): void {
		this._turnReasoning = "";
		this._turnAssistantParts = [];
	}

	/**
	 * Finalize the current streaming turn's reasoning capture. Call this from
	 * the `finally` block of `processStreamingResponse`, after
	 * `reportEndThinking`, so it runs on every exit path (normal completion,
	 * [DONE], cancellation, errors) and after the last thinking chunk has been
	 * flushed into `_turnReasoning`.
	 *
	 * The cache entry is keyed by the turn's content hash rather than its
	 * positional index, so it survives context compression/summarization that
	 * shortens the history. For interrupted turns the entry is written for
	 * whatever was emitted: if VS Code kept that partial assistant message in
	 * history it still matches; otherwise the entry is orphaned and eventually
	 * LRU-evicted (harmless).
	 *
	 * Turns with no text/tool-call content (pure thinking) are not cached:
	 * there is no stable content to hash, and an empty hash would collide
	 * across turns.
	 */
	protected endTurnCapture(): void {
		if (!this._turnReasoning.trim() || this._turnAssistantParts.length === 0) {
			return;
		}
		const turnKey = CommonApi.computeTurnHashFromParts(this._turnAssistantParts);
		if (!turnKey) {
			return;
		}
		CommonApi._reasoningByTurn.set(this.reasoningKey(turnKey), this._turnReasoning);
		this._turnReasoning = "";
		this._turnAssistantParts = [];
		// Write-through to globalState (debounced) so replay survives reload,
		// plus an immediate best-effort flush so the last turn isn't lost if
		// the window closes right after.
		CommonApi.schedulePersist();
		void CommonApi.flushNow();
	}

	/**
	 * Best-effort real reasoning for a given turn, or undefined if none.
	 * @param turnKey The turn's content hash (from `computeTurnHashFromParts`).
	 */
	protected getCachedReasoning(turnKey: string): string | undefined {
		if (!turnKey) {
			return undefined;
		}
		const fullKey = this.reasoningKey(turnKey);
		const cached = CommonApi._reasoningByTurn.get(fullKey);
		if (cached === undefined) {
			return undefined;
		}
		// LRU: refresh recency by moving the entry to the most-recent end.
		CommonApi._reasoningByTurn.delete(fullKey);
		CommonApi._reasoningByTurn.set(fullKey, cached);
		return cached.trim();
	}

	/** System prompts to include in requests. */
	protected _systemContent: string | undefined;

	/** Set the model ID for logging purposes. */
	protected _modelId = "";

	/** Accumulated token usage from the API response. */
	protected _usage: TokenUsage | null = null;

	/**
	 * Token usage captured from the response (server-reported counts).
	 * Null when the stream ended before a usage payload arrived
	 * (e.g. the request was cancelled before the final chunk).
	 */
	getUsage(): TokenUsage | null {
		return this._usage;
	}

	constructor(modelId: string) {
		this._modelId = modelId;
	}

	/**
	 * Convert VS Code chat messages to specific api message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig Config for special model.
	 * @returns Specific api messages array.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
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
		// Best-effort immediate persist so the last thought isn't lost on reload.
		void CommonApi.flushNow();
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
