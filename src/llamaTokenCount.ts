/**
 * llama.cpp server-side token counting (experimental).
 *
 * llama.cpp's llama-server exposes a non-standard endpoint
 * `POST /chat/completions/input_tokens` (also served at
 * `/v1/chat/completions/input_tokens`) that applies the loaded model's chat
 * template and multimodal preprocessing, then tokenizes the rendered prompt
 * and returns `{ "object": "response.input_tokens", "input_tokens": N }`
 * without generating a completion.
 *
 * This module is intentionally structured as pure helpers + one thin fetch
 * wrapper so the URL/body/response logic is testable without mocking fetch
 * (same pattern as `llamaSlotCache.ts`).
 */

import type { OpenAIChatMessage } from "./openai/openaiTypes";
import { logger } from "./logger";

/**
 * Build the `/chat/completions/input_tokens` URL from the OpenAI-compatible
 * base URL.
 *
 * Mirrors the chat-completions URL pattern in `provider.ts`
 * (`${baseUrl}/chat/completions`): trailing slashes are stripped and nothing
 * else is appended, so both root (`http://host:8080`) and version-suffixed
 * (`http://host:8080/v1`) base URLs work — the server serves the endpoint
 * with and without the `/v1` prefix.
 */
export function buildInputTokensUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions/input_tokens`;
}

/**
 * Build the request body for the input_tokens endpoint.
 *
 * `model` is the base model id (WITHOUT configId) — required in llama.cpp
 * router mode to select the routed model, accepted-but-ignored in
 * single-model mode. Generation-only options are intentionally omitted: the
 * server accepts them for compatibility but they do not affect the count.
 */
export function buildInputTokensBody(
	model: string,
	messages: OpenAIChatMessage[]
): { model: string; messages: OpenAIChatMessage[] } {
	return { model, messages };
}

/**
 * Extract the token count from an input_tokens response payload.
 *
 * Returns `undefined` for anything that is not a well-formed
 * `{ object: "response.input_tokens", input_tokens: <number> }` payload —
 * callers must treat that as "server-side counting unavailable" and fall
 * back to the local estimator.
 */
export function parseInputTokensResponse(payload: unknown): number | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined;
	}
	const obj = payload as Record<string, unknown>;
	if (obj.object !== "response.input_tokens") {
		return undefined;
	}
	const n = obj.input_tokens;
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
		return undefined;
	}
	return n;
}

/**
 * `POST {baseUrl}/chat/completions/input_tokens` with the given body — a
 * single, non-retried request.
 *
 * Returns the server-computed `input_tokens`, or `undefined` on any failure
 * (4xx/5xx, non-JSON body, malformed payload) — callers must treat
 * `undefined` as "server-side counting unavailable" and fall back to the
 * local estimator.
 *
 * `signal` is the caller's cancellation signal and is forwarded to `fetch`
 * as-is. A request aborted by the signal THROWS (the abort error propagates
 * to the caller) — cancellation is not a fallback condition.
 */
export async function fetchInputTokens(
	url: string,
	body: { model: string; messages: OpenAIChatMessage[] },
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<number | undefined> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			logger.debug("llamaTokenCount.notOk", { url, status: res.status, body: text });
			return undefined;
		}
		const payload = (await res.json()) as unknown;
		const inputTokens = parseInputTokensResponse(payload);
		if (inputTokens === undefined) {
			logger.debug("llamaTokenCount.malformed", { url, payload });
			return undefined;
		}
		logger.debug("llamaTokenCount.ok", { url, inputTokens });
		return inputTokens;
	} catch (e) {
		// A cancellation abort must propagate to the caller — it is NOT a
		// fallback condition.
		if (signal.aborted) {
			throw e;
		}
		logger.debug("llamaTokenCount.error", {
			url,
			error: e instanceof Error ? e.message : String(e),
		});
		return undefined;
	}
}
