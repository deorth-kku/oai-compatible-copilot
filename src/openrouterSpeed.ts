import type { TokenUsage } from "./types";

/**
 * Final-report renderer for OpenRouter-backed requests.
 *
 * OpenRouter exposes no live per-chunk speed fields (nothing equivalent to
 * llama.cpp's `prompt_progress` / `timings`), so there is no live status bar
 * readout for this backend — only this end-of-request summary.
 *
 * Two independent pieces of data land in the final streamed chunk:
 *
 * 1. `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens` —
 *    reported by EVERY OpenRouter response with no opt-in, giving the prompt
 *    cache hit rate.
 * 2. `openrouter_metadata.generation_time` — the upstream wall time in ms,
 *    available only when the request opted in with the
 *    `X-OpenRouter-Metadata: enabled` header. Combined with the completion
 *    token count this yields end-to-end decode throughput. OpenRouter defines
 *    it as "from dispatching the upstream request until its response body
 *    ended", so it covers BOTH prefill and decode and must not be presented
 *    as a decode-only rate.
 */

/** Human-readable single line summarizing an OpenRouter request. */
export interface OpenRouterSpeedState {
	/** e.g. `TG 32.4 t/s · cache 99.8%` */
	line: string;
	/** Secondary tooltip info, e.g. `OpenRouter · 1.24 s · Direct`. */
	detail: string;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Format a duration in milliseconds: `271.9 ms` below one second, otherwise
 * seconds with two decimals (e.g. `5.81 s`).
 */
export function formatOrDurationMs(ms: number): string {
	if (ms < 1000) {
		return `${ms.toFixed(1)} ms`;
	}
	return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Whether the usage object carries any OpenRouter-specific signal worth
 * rendering. Cache counters alone qualify (they need no opt-in), as does
 * router metadata (which carries the generation time).
 */
export function isOpenRouterUsage(usage: TokenUsage): boolean {
	if (usage.openrouter) {
		return true;
	}
	const details = usage.prompt_tokens_details;
	return typeof details?.cache_write_tokens === "number";
}

/**
 * Build the OpenRouter section of the final status bar tooltip.
 *
 * Returns undefined when the usage object carries no OpenRouter signal (a
 * different backend, or an OpenRouter response-cache replay, which strips
 * `openrouter_metadata`).
 *
 * The layout mirrors the llama.cpp report: a cache line, a throughput line,
 * and a total. Unlike llama.cpp there is no prefill/decode split — OpenRouter
 * reports a single upstream wall time, so it is shown once as the total and
 * the completion rate derived from it is explicitly labeled end-to-end.
 */
export function formatOpenRouterUsageReport(usage: TokenUsage): string | undefined {
	const metadata = usage.openrouter;
	const details = usage.prompt_tokens_details;
	if (!metadata && typeof details?.cache_write_tokens !== "number") {
		return undefined;
	}

	const lines: string[] = [];

	// Prompt cache hit rate. Unlike llama.cpp, `cached_tokens` covers the
	// whole prompt (there is no separate timings.cache_n), and OpenRouter also
	// reports explicit cache writes for models that bill them.
	const promptTokens = num(usage.prompt_tokens);
	const cached = num(details?.cached_tokens);
	if (cached !== undefined && promptTokens !== undefined && promptTokens > 0) {
		const cacheParts = [`${Math.round(cached)}/${promptTokens} (${((cached / promptTokens) * 100).toFixed(1)}%)`];
		const written = num(details?.cache_write_tokens);
		if (written !== undefined && written > 0) {
			cacheParts.push(`written ${written}`);
		}
		lines.push(`  - Cache: ${cacheParts.join(" · ")}`);
	}

	// Upstream wall time. OpenRouter omits `generation_time` when no upstream
	// request was dispatched; a non-positive value is treated the same way
	// (it cannot yield a meaningful duration or rate).
	const rawGenerationTime = num(metadata?.generation_time);
	const generationTime = rawGenerationTime !== undefined && rawGenerationTime > 0 ? rawGenerationTime : undefined;

	// Decode throughput. `generation_time` spans prefill AND decode, so the
	// rate is an end-to-end average, not a pure decode rate.
	const completionTokens = num(usage.completion_tokens);
	if (generationTime !== undefined && completionTokens !== undefined) {
		const rate = completionTokens / (generationTime / 1000);
		lines.push(
			`  - Throughput: ${completionTokens} tok · ${formatOrDurationMs(generationTime)} · ${rate.toFixed(1)} t/s`
		);
	}

	// Reasoning vs. visible tokens
	const completionDetails = usage.completion_tokens_details;
	if (completionDetails) {
		const detailParts: string[] = [];
		const reasoning = num(completionDetails.reasoning_tokens);
		const visible = num(completionDetails.visible_tokens);
		if (reasoning !== undefined) {
			// `~N (local)` marks a count the extension derived from the streamed
			// reasoning text because the backend reported none — see
			// CommonApi.reconcileReasoningUsage.
			detailParts.push(
				completionDetails.reasoning_tokens_estimated ? `Reasoning: ~${reasoning} (local)` : `Reasoning: ${reasoning}`
			);
		}
		if (visible !== undefined) {
			detailParts.push(`Visible: ${visible}`);
		} else if (reasoning !== undefined && completionTokens !== undefined) {
			// Reasoning tokens are billed as output tokens, so the remainder is
			// the visible output. Only shown when the backend did not say so.
			const derived = Math.max(0, completionTokens - reasoning);
			detailParts.push(`Visible: ${derived}`);
		}
		if (detailParts.length > 0) {
			lines.push(`  - ${detailParts.join(" · ")}`);
		}
	}

	// Total upstream wall time and where the request was served.
	if (generationTime !== undefined) {
		const totalParts = [formatOrDurationMs(generationTime)];
		if (typeof metadata?.region === "string" && metadata.region.length > 0) {
			totalParts.push(metadata.region);
		}
		if (typeof metadata?.strategy === "string" && metadata.strategy.length > 0) {
			totalParts.push(metadata.strategy);
		}
		lines.push(`  - Total: ${totalParts.join(" · ")}`);
	}

	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Build the single-line summary shown while an OpenRouter request is live.
 *
 * OpenRouter streams no progress fields, so the line only carries what can be
 * derived from arrival timing: the completion rate so far and, once the final
 * chunk has landed, the cache hit rate. Returns undefined when there is
 * nothing meaningful to show yet.
 */
export function formatOpenRouterSpeedLine(
	usage: TokenUsage | null,
	elapsedMs: number,
	completionTokens: number
): OpenRouterSpeedState | undefined {
	const parts: string[] = [];
	if (completionTokens > 0 && elapsedMs > 0) {
		parts.push(`TG ${(completionTokens / (elapsedMs / 1000)).toFixed(1)} t/s`);
	}
	const details = usage?.prompt_tokens_details;
	const cached = num(details?.cached_tokens);
	const promptTokens = num(usage?.prompt_tokens);
	if (cached !== undefined && promptTokens !== undefined && promptTokens > 0) {
		parts.push(`cache ${((cached / promptTokens) * 100).toFixed(1)}%`);
	}
	if (parts.length === 0) {
		return undefined;
	}
	return {
		line: parts.join(" · "),
		detail: "OpenRouter",
	};
}
