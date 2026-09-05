import * as vscode from "vscode";
import type { HFModelItem, RetryConfig } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";

import { logger } from "./logger";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
}

export function getModelProviderId(model: unknown): string {
	if (!model || typeof model !== "object") {
		return "";
	}
	const obj = model as Record<string, unknown>;
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provide) ||
		pick(obj.provider) ||
		pick(obj.ownedBy) ||
		pick(obj.owner) ||
		pick(obj.vendor)
	);
}

/**
 * Idempotent migration of legacy `reasoning.{enabled,effort,max_tokens}` into
 * the new `optimization`-driven model.
 *
 * Trigger: `model.reasoning` exists AND `model.optimization` is undefined.
 * After migration, `model.reasoning` only retains `{ exclude }`.
 */
function migrateLegacyReasoning(model: HFModelItem): HFModelItem {
	if (!model.reasoning || model.optimization !== undefined) {
		return model;
	}
	const r = model.reasoning;
	const optimization = r.enabled === false ? "default" : "openrouter";
	const migrated: HFModelItem = {
		...model,
		optimization,
		reasoning_effort: model.reasoning_effort ?? r.effort,
		thinking_budget: model.thinking_budget ?? r.max_tokens,
	};
	// Keep only `exclude` (the sole OpenRouter-unique parameter).
	const exclude = r.exclude;
	migrated.reasoning = exclude !== undefined ? { exclude } : undefined;
	return migrated;
}

export function normalizeUserModels(models: unknown): HFModelItem[] {
	const list = Array.isArray(models) ? models : [];
	const out: HFModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const provider = getModelProviderId(item);
		const model = migrateLegacyReasoning({ ...(item as HFModelItem), owned_by: provider });
		out.push(model);
	}
	return out;
}

/**
 * Parse a model ID that may contain a configuration ID separator.
 * Format: "baseId::configId" or just "baseId"
 */
export function parseModelId(modelId: string): ParsedModelId {
	const parts = modelId.split("::");
	if (parts.length >= 2) {
		return {
			baseId: parts[0],
			configId: parts.slice(1).join("::"), // In case configId itself contains '::'
		};
	}
	return {
		baseId: modelId,
	};
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Remove the first well-formed `<reminderInstructions>...</reminderInstructions>`
 * block from the given text.
 *
 * Copilot injects a `<reminderInstructions>` block into every user turn. The text
 * is not well-formed XML, so this is a strict targeted scan (not a full XML
 * parser):
 * - Only an exact, case-sensitive, paired block is removed. A non-global regex
 *   with `String.replace` removes at most one — the first — block; any further
 *   blocks are left untouched.
 * - If an opening tag has no matching closing tag, the text is returned
 *   unchanged.
 */
export function stripReminderInstructions(text: string): string {
	if (!text.includes("<reminderInstructions>")) {
		return text;
	}
	return text.replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/, (match) => {
		logger.debug("stripReminderInstructions", { stripped: match });
		return "";
	});
}

/**
 * Literal marker ending the stable memory-instructions section of the Copilot
 * system prompt. Everything after the first occurrence is
 * session/workspace-specific (skills, agents, AGENTS.md attachments, template
 * variables, the VSCODE_TARGET_SESSION_LOG line) and busts the upstream prompt
 * cache.
 */
const MEMORY_INSTRUCTIONS_END_MARKER = "</memoryInstructions>";

/**
 * Options controlling which per-message sanitizations {@link sanitizeMessages}
 * applies.
 */
export interface SanitizeMessagesOptions {
	/** Strip the first `<reminderInstructions>` block from user-role text parts. */
	stripReminder?: boolean;
	/**
	 * Split the first system-role message at the first `</memoryInstructions>`
	 * marker: the stable prefix stays a system message and the trimmed
	 * remainder becomes a following user message (when set).
	 */
	splitSystemPrompt?: boolean;
}

/**
 * Return a new message array with per-role sanitizations applied to text parts.
 *
 * In a single pass over the messages this can:
 * - strip the first `<reminderInstructions>` block from **user**-role text
 *   parts (when `options.stripReminder` is set), and
 * - split the **first** system-role message at the first
 *   `</memoryInstructions>` marker (when `options.splitSystemPrompt` is set):
 *   the first message keeps the text up to and including the marker, and the
 *   trimmed remainder becomes a following **user** message (not a second
 *   system message — llama.cpp's jinja template merges consecutive leading
 *   system messages, which would defeat the split).
 *
 * Only `LanguageModelTextPart`s in the matching role are replaced; all other
 * parts (data, tool call, tool result, thinking) and non-matching messages pass
 * through by reference. If nothing changes, the original array is returned
 * unchanged. The input array is never mutated.
 */
export function sanitizeMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: SanitizeMessagesOptions
): vscode.LanguageModelChatRequestMessage[] {
	const stripReminder = options.stripReminder === true;
	const splitSystemPrompt = options.splitSystemPrompt === true;
	if (!stripReminder && !splitSystemPrompt) {
		return messages as vscode.LanguageModelChatRequestMessage[];
	}
	let changed = false;
	let systemSplitDone = false;
	const out: vscode.LanguageModelChatRequestMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m);
		const wantReminder = stripReminder && role === "user";
		const wantSplit = splitSystemPrompt && !systemSplitDone && role === "system";
		// Only the FIRST system message is a split candidate; once it has been
		// seen (split or not) the opportunity is consumed.
		if (wantSplit) {
			systemSplitDone = true;
			if (m.content && m.content.length === 1) {
				const part = m.content[0];
				if (part instanceof vscode.LanguageModelTextPart) {
					const idx = part.value.indexOf(MEMORY_INSTRUCTIONS_END_MARKER);
					if (idx >= 0) {
						const first = part.value.slice(0, idx + MEMORY_INSTRUCTIONS_END_MARKER.length).trim();
						const rest = part.value.slice(idx + MEMORY_INSTRUCTIONS_END_MARKER.length).trim();
						if (first && rest) {
							changed = true;
							logger.debug("splitSystemPrompt", {
								firstLength: first.length,
								restLength: rest.length,
							});
							out.push({ ...m, content: [new vscode.LanguageModelTextPart(first)] });
								// The remainder becomes a following user message (not a
								// second system message: llama.cpp's jinja template
								// merges consecutive leading system messages, which
								// would defeat the split).
							out.push({
								role: vscode.LanguageModelChatMessageRole.User,
								name: undefined,
								content: [new vscode.LanguageModelTextPart(rest)],
							});
							continue;
						}
					}
				}
			}
			out.push(m);
			continue;
		}
		if (!wantReminder || !m.content) {
			out.push(m);
			continue;
		}
		let messageChanged = false;
		const parts: unknown[] = [];
		for (const part of m.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				const value = stripReminderInstructions(part.value);
				if (value !== part.value) {
					messageChanged = true;
					parts.push(new vscode.LanguageModelTextPart(value));
					continue;
				}
			}
			parts.push(part);
		}
		if (messageChanged) {
			changed = true;
			out.push({ ...m, content: parts });
		} else {
			out.push(m);
		}
	}
	return changed ? out : (messages as vscode.LanguageModelChatRequestMessage[]);
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? { type: "object", properties: {} };
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[OAI Compatible Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

export type OpenAIResponsesToolChoice = "auto" | { type: "function"; name: string };

/**
 * Convert VS Code tool definitions to OpenAI Responses API tool definitions.
 * Responses uses `{ type:"function", name, description, parameters }` (no nested `function` object).
 */
export function convertToolsToOpenAIResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: OpenAIResponsesToolChoice;
} {
	const toolConfig = convertToolsToOpenAI(options);
	if (!toolConfig.tools || toolConfig.tools.length === 0) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = toolConfig.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = {
			type: "function",
			name: t.function.name,
		};
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: OpenAIResponsesToolChoice | undefined;
	if (toolConfig.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (toolConfig.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: toolConfig.tool_choice.function.name };
	}

	return { tools, tool_choice };
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Separate a tool result's content into plain text and image data parts.
 *
 * Image {@link vscode.LanguageModelDataPart}s are returned separately (instead of
 * being serialized as base64 JSON) so that providers which support multimodal tool
 * results (e.g. Anthropic) can embed them correctly, while text-only providers
 * (OpenAI chat completions, Responses, Gemini, Ollama) can ignore them gracefully
 * instead of dumping a giant base64 blob into the content string.
 *
 * @param pr Tool result-like object with content array.
 */
export function extractToolResultMedia(pr: { content?: ReadonlyArray<unknown> }): {
	text: string;
	images: vscode.LanguageModelDataPart[];
} {
	let text = "";
	const images: vscode.LanguageModelDataPart[] = [];
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && isImageMimeType(c.mimeType)) {
			images.push(c);
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else if (c instanceof vscode.LanguageModelDataPart) {
			// Non-image data parts (e.g. json/text) are serialized as text.
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
		// Unknown part types are ignored.
	}
	return { text, images };
}

/**
 * Concatenate tool result content into a single text string, ignoring any image
 * data parts (those are handled separately via {@link extractToolResultMedia}).
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	return extractToolResultMedia(pr).text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("oaicopilot.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const baseIntervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableStatusError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));
			// Check if error is retryable based on network error patterns
			const isRetryableNetworkError = networkErrorPatterns.some((pattern) => lastError?.message.includes(pattern));
			const isRetryableError = isRetryableStatusError || isRetryableNetworkError;

			// A cancellation/abort must never be retried. An aborted `fetch` may
			// surface as a `TypeError: fetch failed` (whose message matches the
			// network-error retry patterns) or as an `AbortError`, so detect both
			// explicitly and bail out immediately.
			const isAbortError =
				lastError?.name === "AbortError" ||
				/abort(ed)?/i.test(lastError?.message ?? "");

			if (!isRetryableError || attempt === maxAttempts || isAbortError) {
				throw lastError;
			}

			// Exponential backoff: interval doubles each attempt, capped at 60s
			const delayMs = Math.min(baseIntervalMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt), RETRY_MAX_INTERVAL_MS);

			logger.warn("retry.attempt", {
				attempt: attempt + 1,
				maxAttempts,
				delayMs,
				errorName: lastError.name,
				errorMessage: lastError.message,
			});

			console.error(
				`[OAI Compatible Model Provider] Retryable error detected, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts}). Error:`,
				lastError instanceof Error ? { name: lastError.name, message: lastError.message } : String(lastError)
			);

			// Wait for the calculated interval before retrying
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// This should never be reached, but TypeScript needs it
	logger.error("retry.exhausted", {
		maxAttempts,
		lastError: lastError ? { name: lastError.name, message: lastError.message } : String(lastError),
	});
	throw lastError || new Error("Retry failed");
}
