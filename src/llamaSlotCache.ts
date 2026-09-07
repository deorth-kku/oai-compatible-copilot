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
 * Session-aware flow (see provider.ts and {@link decideSlotCache}):
 *   0. The provider decides `(restore, save)` per request from a matrix over
 *      (message count, per-conversation cache-id change). The previous cache
 *      id is tracked in this module's Map, keyed by the conversation id from
 *      `CommonApi.computeConvId` (per-session UUID in the system prompt).
 *   1. `GET {root}/slots?model={baseId}` on EVERY gated request (router mode
 *      REQUIRES the `?model=` param — undocumented; 400 without it). The same
 *      response serves the idle-slot selection AND the restart check: when
 *      all slots are empty ({@link allSlotsEmpty} — no slot has ever been
 *      used since the server started, i.e. llama.cpp restarted), the restore
 *      branch is forced even when the matrix said F.
 *   2. If restore (matrix or forced): best idle slot id from the same
 *      response, then `POST {root}/slots/{id}?action=restore` with JSON body
 *      `{ "filename": "{cacheId}.bin", "model": "{baseId}" }` (awaited).
 *   3. Chat request with `verbose: true` when a restore was attempted
 *      (+ `id_slot` when the restore succeeded); the server's actual slot is
 *      learned from `__verbose.id_slot`.
 *   4. If the decision wanted a save (first turn, len === 3) AND a restore was
 *      attempted and missed, `POST {root}/slots/{id}?action=save` with the
 *      same JSON body, fire-and-forget after the stream ends so the cache
 *      exists next time.
 *   5. The cache id is recorded for the conversation (non-throwing completion
 *      only) so later requests can apply the matrix.
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
 * Whether ALL slots are empty — the "llama.cpp restarted" signal.
 *
 * The server emits `n_prompt_tokens` on a slot only while that slot has a
 * current or previous task (`server_slot::to_json` writes the field from
 * `task ? task : task_prev`). A slot that has never been used since the
 * server started therefore LACKS the field; a slot that WAS used keeps it
 * (even `0` after a purge/erase). So every slot lacking `n_prompt_tokens`
 * means no slot has ever held a prompt since the server started — the
 * in-memory KV cache is gone and a disk `.bin` can be restored without
 * discarding live VRAM KV.
 *
 * Conservative by design: a purged-but-used slot counts as NOT empty, so the
 * restart override can miss a restore opportunity but never discards live
 * VRAM KV. Busy slots always carry the field, so they are never empty.
 *
 * An empty slot array is NOT "all empty": there is nothing to restore into,
 * and the caller should treat it as "feature unavailable".
 */
export function allSlotsEmpty(slots: readonly LlamaSlot[]): boolean {
	return slots.length > 0 && slots.every((s) => typeof s?.n_prompt_tokens !== "number");
}

/**
 * `GET {root}/slots?model={modelId}` and return the full slot array.
 *
 * The `?model=` query param is REQUIRED in llama.cpp *router mode*
 * (undocumented — the server answers 400 "model name is missing from the
 * request" without it).
 *
 * Returns `undefined` on any failure (400/404/503/network, non-array body) —
 * callers must treat this as "feature unavailable" and continue the chat
 * request without slot pinning or the restart check.
 *
 * `signal` is the caller-owned deadline (e.g. the per-model timeout merged
 * with the chat request's cancellation); it is forwarded to `fetch` as-is.
 */
export async function fetchSlots(
	rootUrl: string,
	modelId: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<LlamaSlot[] | undefined> {
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
		return slots as LlamaSlot[];
	} catch (e) {
		logger.debug("llamaSlotCache.slots.error", {
			url,
			error: e instanceof Error ? e.message : String(e),
		});
		return undefined;
	}
}

/**
 * `GET {root}/slots?model={modelId}` and return the best idle slot id
 * (selection rule: see {@link findIdleSlot}).
 *
 * Thin wrapper over {@link fetchSlots} — kept for callers/tests that only
 * need the idle slot id.
 *
 * Returns `undefined` on any failure (see {@link fetchSlots}) or when no
 * idle slot exists (empty list, all slots busy).
 *
 * `signal` is the caller-owned deadline; it is forwarded to `fetch` as-is.
 */
export async function fetchIdleSlot(
	rootUrl: string,
	modelId: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<number | undefined> {
	const slots = await fetchSlots(rootUrl, modelId, headers, signal);
	if (slots === undefined) {
		return undefined;
	}
	const idle = findIdleSlot(slots);
	if (idle !== undefined) {
		logger.debug("llamaSlotCache.slots.idleFound", { slotId: idle, total: slots.length });
	} else {
		logger.debug("llamaSlotCache.slots.noIdle", { total: slots.length });
	}
	return idle;
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

// =====================================================================
// Session-aware decision matrix
// =====================================================================

/**
 * Per-conversation disk KV cache id tracking.
 *
 * Keyed by the conversation id derived from the request history (see
 * `CommonApi.computeConvId` — the per-session UUID embedded in the system
 * prompt). The extension process is shared across all chat sessions, so this
 * Map is module-level. It is in-memory only: after an extension reload every
 * conversation is a "first fill" again, which the matrix handles (self-healing
 * — at len > 3 a first fill does no slot work).
 */
const _cacheIdByConv = new Map<string, string>();

/** Maximum number of tracked conversations; oldest (least recently used) evicted. */
const CACHE_ID_MAP_MAX = 512;

/**
 * The last disk KV cache id recorded for a conversation, or `undefined` if the
 * conversation has never completed a request under this feature.
 */
export function getRecordedCacheId(convId: string): string | undefined {
	return _cacheIdByConv.get(convId);
}

/**
 * Record (or update) the disk KV cache id for a conversation.
 *
 * The provider calls this only when the stream completes without throwing
 * (user cancellation counts as a normal completion). A FAILED first request
 * therefore leaves no record, so its retry is treated as a first fill again
 * (restore + save).
 *
 * Re-recording an existing conversation refreshes its recency (it moves to
 * the tail of the insertion-ordered Map, which is the LRU order).
 */
export function recordCacheId(convId: string, cacheId: string): void {
	// Refresh recency: re-insert at the tail.
	_cacheIdByConv.delete(convId);
	_cacheIdByConv.set(convId, cacheId);
	// Evict the oldest entries when over the cap.
	let overflow = _cacheIdByConv.size - CACHE_ID_MAP_MAX;
	while (overflow > 0) {
		const oldest = _cacheIdByConv.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		_cacheIdByConv.delete(oldest);
		overflow--;
	}
}

/** Clear all tracked conversations (test isolation). */
export function clearCacheIdMap(): void {
	_cacheIdByConv.clear();
}

/**
 * The restore/save decision for a request under the disk KV cache feature.
 *
 * Decision matrix (user-confirmed):
 *
 * | len \ cache_id | ① none→new (first fill) | ② unchanged | ③ old≠new (changed) |
 * |----------------|-------------------------|-------------|---------------------|
 * | < 3            | F / F                   | F / F       | F / F               |
 * | = 3            | R / S                   | F / S       | R / S               |
 * | > 3            | F / F                   | F / F       | R / F               |
 *
 * - `restore`: attempt the awaited restore, and pin `id_slot` when it
 *   succeeds. The provider ORs in a runtime override: when `GET /slots`
 *   reports ALL slots empty ({@link allSlotsEmpty} — llama.cpp restarted, so
 *   the in-memory KV is gone), the restore branch is forced even for matrix-F
 *   cells (restoring then cannot discard live VRAM KV).
 * - `save`: the save is *desired* — a NECESSARY condition only. It is
 *   `len === 3` (the context is still short, so the `.bin` is cheap to write
 *   and fully reusable). The actual save additionally requires that a restore
 *   was attempted AND missed — the extension only saves what it did not
 *   restore (a successful restore already has the `.bin` on disk), and NOT
 *   attempting a restore is NOT a restore miss. So `= 3, unchanged` saves
 *   only when the all-slots-empty override forced a restore that then missed
 *   (e.g. the `.bin` was deleted).
 *
 * Rationale:
 * - `len < 3`: not a well-formed conversation turn of this feature (system +
 *   injected env + user message); never touch the disk cache. In principle
 *   unreachable — a new session's first request is exactly 3 messages.
 * - `= 3, first fill / changed`: the context is still short (3 messages), so
 *   saving is cheap and establishes the `.bin` for future sessions; a restore
 *   is a free long-shot that the combination was used in another session.
 *   `= 3, unchanged` is the first message being edited/resubmitted: no restore
 *   by the matrix — the `.bin` already exists (from this session's first
 *   request) and the conversation's KV is in VRAM.
 * - `> 3`: the context is long at response time, so saving would persist a
 *   mostly-unusable cache (disk waste) — never save. A changed combination is
 *   still worth a restore attempt: it may have been used at an earlier
 *   new-session creation, in which case a `.bin` exists.
 */
export function decideSlotCache(
	messageCount: number,
	prevCacheId: string | undefined,
	cacheId: string
): { restore: boolean; save: boolean } {
	// Save is desired only on the first turn (len === 3): the context is short,
	// so the .bin is cheap to write and fully reusable. At len > 3 the context
	// is long at response time and only a short head would be reusable — disk
	// waste.
	const save = messageCount === 3;
	if (messageCount < 3) {
		return { restore: false, save: false };
	}
	if (messageCount === 3) {
		// First fill (no record yet) or a changed combination (e.g. the first
		// message resubmitted after changing the reasoning level): the context
		// is short, so restore (long-shot) + save (cheap, establishes the .bin).
		// Unchanged: no restore by the matrix — the .bin already exists from
		// this session's first request and the conversation's KV is in VRAM
		// (the provider's all-slots-empty override can still force a restore,
		// in which case a miss saves).
		const firstFillOrChanged = prevCacheId === undefined || prevCacheId !== cacheId;
		return { restore: firstFillOrChanged, save };
	}
	// len > 3: never save (long context). Restore only when the combination
	// changed since this conversation's last recorded request — the
	// combination may have been used at an earlier new-session creation.
	const changed = prevCacheId !== undefined && prevCacheId !== cacheId;
	return { restore: changed, save };
}
