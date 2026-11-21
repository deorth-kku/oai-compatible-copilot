/**
 * llama.cpp per-request LoRA ("fast" variant) support.
 *
 * llama-server can load LoRA adapters at startup (`--lora ...`,
 * `--lora-scaled ...`) and apply a per-request adapter list via the `lora`
 * field of the OpenAI-compatible chat request body:
 * `{"lora": [{"id": 0, "scale": 0.5}]}`. Adapters NOT listed in the request
 * fall back to scale 0 (disabled) for that request; a request without the
 * `lora` field uses the server's global adapter list.
 *
 * The extension maps ONE server-loaded adapter to a synthetic `{id}-fast`
 * model so VS Code's Speed selector (Standard/Fast) can offer it — VS Code
 * has a single "fast" slot per model, so only one adapter can be mapped.
 *
 * This module is a thin API adapter: it owns NO timeout/cancellation policy.
 * Each call takes the caller's `signal` and passes it straight to `fetch`.
 */
import { logger } from "./logger";
import type { HFModelItem } from "./types";

/**
 * A single adapter entry from `GET /lora-adapters` (llama.cpp server).
 * Shape produced by `server_task_result_get_lora::to_json` in llama.cpp's
 * `tools/server/server-task.cpp`.
 */
export interface LlamaLoraAdapter {
	/** Adapter index — the value referenced by the request's `lora` field. */
	id: number;
	/** File path used when the adapter was loaded. */
	path?: string;
	/** Current global scale (0 when the adapter is not applied). */
	scale?: number;
	/** Adapter GGUF metadata: task name (empty string when absent). */
	task_name?: string;
	/** Adapter GGUF metadata: prompt prefix (empty string when absent). */
	prompt_prefix?: string;
	/** Present only for aLoRA (activation LoRA) adapters. */
	alora_invocation_string?: string;
	/** Present only for aLoRA (activation LoRA) adapters. */
	alora_invocation_tokens?: number[];
}

/** Suffix VS Code uses to mark the "fast" twin of a model id. */
export const LORA_FAST_SUFFIX = "-fast";

/**
 * The synthetic picker id of a model entry's "fast" twin.
 *
 * `entryId` is the picker id of the base entry — `id`, or `id::configId` when
 * the entry has a configuration id (so the twin id is e.g. `my-model::cfg-fast`).
 */
export function loraFastTwinId(entryId: string): string {
	return `${entryId}${LORA_FAST_SUFFIX}`;
}

/**
 * Whether a configured model entry OFFERS a "fast" twin, i.e. it is a
 * llama.cpp-optimized entry on the default OpenAI-compatible api mode (the
 * only branch of provider.ts that applies the per-request `lora` field) with
 * an integer adapter id configured.
 *
 * provider.ts (virtual-entry match) and provideModel.ts (twin emission) must
 * agree on this predicate, or the Speed selector could offer a Fast variant
 * that the request path never applies the adapter for.
 */
export function offersLlamaLoraFast(
	m: Pick<HFModelItem, "optimization" | "apiMode" | "llama_lora_fast">
): boolean {
	if (m.optimization !== "llama.cpp") {
		return false;
	}
	if (m.apiMode !== undefined && m.apiMode !== "openai") {
		return false;
	}
	// Integer, mirroring buildLoraRequestField: a non-integer id would offer
	// a twin whose `lora` field is then dropped (silent no-op).
	const id = m.llama_lora_fast?.id;
	return typeof id === "number" && Number.isInteger(id);
}

/**
 * Build the per-request `lora` body field for a configured fast variant.
 *
 * Returns `undefined` when the config is missing or its `id` is not an
 * integer (no `lora` field should be sent — the server then falls back to
 * its global adapter list). A non-finite `scale` is dropped (server-side
 * scale applies).
 */
export function buildLoraRequestField(
	config: { id: number; scale?: number } | undefined
): Array<{ id: number; scale?: number }> | undefined {
	if (!config || !Number.isInteger(config.id)) {
		return undefined;
	}
	const entry: { id: number; scale?: number } = { id: config.id };
	if (typeof config.scale === "number" && Number.isFinite(config.scale)) {
		entry.scale = config.scale;
	}
	return [entry];
}

/**
 * `GET {root}/lora-adapters?model={modelId}` and return the adapter array.
 *
 * The `?model=` query param is REQUIRED in llama.cpp *router mode* (the
 * server answers 400 "model name is missing from the request" without it).
 *
 * Returns `undefined` on any failure (4xx/5xx/network, non-array body) —
 * callers must treat this as "feature unavailable".
 *
 * `signal` is the caller-owned deadline; it is forwarded to `fetch` as-is.
 */
export async function fetchLoraAdapters(
	rootUrl: string,
	modelId: string,
	headers: Record<string, string>,
	signal: AbortSignal
): Promise<LlamaLoraAdapter[] | undefined> {
	const url = `${rootUrl}/lora-adapters?model=${encodeURIComponent(modelId)}`;
	try {
		const res = await fetch(url, {
			method: "GET",
			headers,
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			logger.debug("llamaLora.fetch.notOk", { url, status: res.status, body: text });
			return undefined;
		}
		const body = (await res.json()) as unknown;
		if (!Array.isArray(body)) {
			logger.debug("llamaLora.fetch.notArray", { url });
			return undefined;
		}
		// Keep only well-formed entries (numeric id) — the picker keys off it.
		const adapters = (body as LlamaLoraAdapter[]).filter((a) => a && typeof a.id === "number");
		logger.debug("llamaLora.fetch.ok", { url, count: adapters.length });
		return adapters;
	} catch (e) {
		logger.debug("llamaLora.fetch.error", {
			url,
			error: e instanceof Error ? e.message : String(e),
		});
		return undefined;
	}
}
