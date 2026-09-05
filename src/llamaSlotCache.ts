/**
 * llama.cpp disk KV cache reuse (experimental).
 *
 * llama.cpp servers can persist a slot's prompt cache to disk
 * (`--slot-save-path`) and restore it later (see the `/slots` endpoint docs).
 * When the identifying request parameters (model, reasoning effort, sanitized
 * system prompt, tools) are unchanged across *new* sessions, the prefix KV
 * cache can be restored into an idle slot before the first request, avoiding a
 * full prompt re-prefill.
 *
 * Flow (see provider.ts):
 *   1. `GET  {root}/slots?model={baseId}` → first idle slot id (router mode
 *      REQUIRES the `?model=` param — undocumented; 400 without it).
 *   2. `POST {root}/slots/{id}?action=restore` with JSON body
 *      `{ "filename": "{cacheId}.bin", "model": "{baseId}" }` (awaited).
 *   3. Chat request with `verbose: true` (+ `id_slot` when restore succeeded);
 *      the server's actual slot is learned from `__verbose.id_slot`.
 *   4. If restore failed, `POST {root}/slots/{id}?action=save` with the same
 *      JSON body, fire-and-forget after the stream ends so the cache exists
 *      next time.
 *
 *   Note: GET /slots takes `model` as a QUERY param, but the POST actions take
 *   `model` in the JSON BODY (400 "model name is missing" otherwise).
 *
 * This module is a thin API adapter: it owns NO timeout/cancellation policy.
 * Each call takes the caller's `signal` and passes it straight to `fetch`.
 * The caller (provider.ts) builds the Go-`context`-style deadline:
 *   - fetchIdleSlot / restoreSlotCache:
 *     `AbortSignal.any([AbortSignal.timeout(t), requestSignal])`
 *   - saveSlotCache (fire-and-forget): `AbortSignal.timeout(t)` only — it must
 *     outlive the request (the provider aborts the request signal in `finally`).
 */
import { createHash } from "crypto";

import { logger } from "./logger";

/** A single slot entry returned by `GET /slots` (llama.cpp server). */
export interface LlamaSlot {
	id: number;
	id_task?: number;
	n_ctx?: number;
	speculative?: boolean;
	is_processing: boolean;
	/**
	 * Total prompt tokens the slot has processed since it was created. ABSENT
	 * on slots that have never been used — their presence/absence is the
	 * "has this slot been used" signal for idle-slot selection.
	 */
	n_prompt_tokens?: number;
	params?: Record<string, unknown>;
	next_token?: Record<string, unknown>;
}

/**
 * Derive the llama.cpp server root URL from the OpenAI-compatible base URL.
 *
 * The `/slots` endpoint lives at the server ROOT, not under the `/v1` prefix:
 * `http://test.com/v1` → `http://test.com`. A base URL without a `/v1` suffix
 * is returned unchanged (trailing slashes are stripped).
 */
export function getServerRootUrl(baseUrl: string): string {
	let root = baseUrl.replace(/\/+$/, "");
	if (root.endsWith("/v1")) {
		root = root.slice(0, -"/v1".length);
	}
	return root;
}

/** Parts that identify a reusable disk KV cache (see {@link computeSlotCacheId}). */
export interface SlotCacheIdParts {
	/** Model base id (WITHOUT configId). */
	model: string;
	/** The `reasoning_effort` value actually sent ("" when absent). */
	reasoning: string;
	/** Sanitized system prompt text ("" when absent). */
	system: string;
	/** `tools` as sent in the request body (undefined → []). */
	tools?: unknown;
	/** `tool_choice` as sent in the request body (undefined → "auto"). */
	toolChoice?: unknown;
}

/**
 * Compute the disk KV cache file id for a request: the sha256 hex digest of
 * the canonical JSON of the identifying parts. The digest is filesystem-safe
 * (hex) and is used as `{digest}.bin` in the server's `--slot-save-path`.
 */
export function computeSlotCacheId(parts: SlotCacheIdParts): string {
	const payload = JSON.stringify({
		model: parts.model,
		reasoning: parts.reasoning,
		system: parts.system,
		tools: parts.tools ?? [],
		toolChoice: parts.toolChoice ?? "auto",
	});
	return createHash("sha256").update(payload).digest("hex");
}

/**
 * Extract the first system message text from converted OpenAI messages.
 * System messages are always plain strings (see `OpenaiApi.convertMessages`).
 */
export function extractSystemText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
	for (const m of messages) {
		if (m.role === "system") {
			return typeof m.content === "string" ? m.content : "";
		}
	}
	return "";
}

/**
 * Pick the best idle slot from a `GET /slots` response. Pure for testability.
 *
 * Preference among idle slots (`is_processing === false`):
 * 1. Slots that have never been used — the `n_prompt_tokens` field is ABSENT.
 * 2. Otherwise, the slot with the smallest `n_prompt_tokens`.
 * Ties (several never-used slots, or several with the same minimum
 * `n_prompt_tokens`) resolve to the first one in array order.
 */
export function findIdleSlot(slots: readonly LlamaSlot[]): number | undefined {
	let best: LlamaSlot | undefined;
	let bestTokens: number | undefined; // undefined = never used (no n_prompt_tokens)
	for (const slot of slots) {
		if (!slot || typeof slot.id !== "number" || slot.is_processing !== false) {
			continue;
		}
		const tokens = typeof slot.n_prompt_tokens === "number" ? slot.n_prompt_tokens : undefined;
		if (best === undefined) {
			best = slot;
			bestTokens = tokens;
			continue;
		}
		if (bestTokens === undefined) {
			// The current best has never been used; a used slot can never beat it.
			continue;
		}
		if (tokens === undefined) {
			// This slot has never been used; it beats the used best.
			best = slot;
			bestTokens = undefined;
		} else if (tokens < bestTokens) {
			// Strictly less used; ties keep the first-seen slot.
			best = slot;
			bestTokens = tokens;
		}
	}
	return best?.id;
}

/**
 * `GET {root}/slots?model={modelId}` and return the best idle slot id
 * (selection rule: see {@link findIdleSlot}).
 *
 * The `?model=` query param is REQUIRED in llama.cpp *router mode*
 * (undocumented — the server answers 400 "model name is missing from the
 * request" without it).
 *
 * Returns `undefined` on any failure (400/404/503/network, non-array body,
 * empty list, all slots busy) — callers must treat this as "feature
 * unavailable" and continue the chat request without slot pinning.
 *
 * `signal` is the caller-owned deadline (e.g. the per-model timeout merged
 * with the chat request's cancellation); it is forwarded to `fetch` as-is.
 */
export async function fetchIdleSlot(
	rootUrl: string,
	modelId: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<number | undefined> {
	const url = `${rootUrl}/slots?model=${encodeURIComponent(modelId)}`;
	try {
		const res = await fetch(url, {
			method: "GET",
			headers,
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			logger.debug("llamaSlotCache.slots.notOk", { url, status: res.status, body: text });
			return undefined;
		}
		const slots = (await res.json()) as unknown;
		if (!Array.isArray(slots)) {
			logger.debug("llamaSlotCache.slots.notArray", { url });
			return undefined;
		}
		const idle = findIdleSlot(slots as LlamaSlot[]);
		if (idle !== undefined) {
			logger.debug("llamaSlotCache.slots.idleFound", { url, slotId: idle, total: slots.length });
		} else {
			logger.debug("llamaSlotCache.slots.noIdle", { url, total: slots.length });
		}
		return idle;
	} catch (e) {
		logger.debug("llamaSlotCache.slots.error", {
			url,
			error: e instanceof Error ? e.message : String(e),
		});
		return undefined;
	}
}

/**
 * `POST {root}/slots/{id}?action=restore` with JSON body
 * `{ "filename": {filename}, "model": {modelId} }` — AWAITED; the chat request
 * only proceeds after this settles. Success = HTTP 200 with `n_restored > 0`.
 *
 * Unlike `GET /slots` (where `model` is a query param), the POST actions take
 * `model` in the JSON BODY — the server answers 400 "model name is missing from
 * the request" when it is absent.
 *
 * `signal` is the caller-owned deadline (e.g. the per-model timeout merged
 * with the chat request's cancellation); it is forwarded to `fetch` as-is.
 */
export async function restoreSlotCache(
	rootUrl: string,
	modelId: string,
	slotId: number,
	filename: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<boolean> {
	const url = `${rootUrl}/slots/${slotId}?action=restore`;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ filename, model: modelId }),
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			logger.debug("llamaSlotCache.restore.notOk", { url, status: res.status, body: text });
			return false;
		}
		const body = (await res.json()) as Record<string, unknown>;
		const ok = typeof body.n_restored === "number" && body.n_restored > 0;
		logger.info("llamaSlotCache.restore", { url, ...body });
		return ok;
	} catch (e) {
		logger.debug("llamaSlotCache.restore.error", {
			url,
			error: e instanceof Error ? e.message : String(e),
		});
		return false;
	}
}

/**
 * `POST {root}/slots/{id}?action=save` with JSON body
 * `{ "filename": {filename}, "model": {modelId} }` — intended to be used
 * fire-and-forget after the stream ends.
 *
 * `signal` is the caller-owned deadline. For the fire-and-forget use case the
 * caller passes a plain `AbortSignal.timeout(ms)` — NOT the chat request's
 * cancellation signal (this call must outlive the request, whose signal the
 * provider aborts in `finally`).
 *
 * Unlike `GET /slots` (where `model` is a query param), the POST actions take
 * `model` in the JSON BODY — the server answers 400 "model name is missing from
 * the request" when it is absent.
 */
export async function saveSlotCache(
	rootUrl: string,
	modelId: string,
	slotId: number,
	filename: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<boolean> {
	const url = `${rootUrl}/slots/${slotId}?action=save`;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ filename, model: modelId }),
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			logger.debug("llamaSlotCache.save.notOk", { url, status: res.status, body: text });
			return false;
		}
		const body = (await res.json()) as Record<string, unknown>;
		const ok = typeof body.n_saved === "number" && body.n_saved > 0;
		logger.info("llamaSlotCache.save", { url, ...body });
		return ok;
	} catch (e) {
		logger.debug("llamaSlotCache.save.error", {
			url,
			error: e instanceof Error ? e.message : String(e),
		});
		return false;
	}
}
