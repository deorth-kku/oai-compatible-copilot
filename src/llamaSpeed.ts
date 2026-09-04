import * as vscode from "vscode";
import type { TokenUsage } from "./types";

/**
 * Live llama.cpp PP/TG speed display.
 *
 * llama-server (OpenAI-compatible endpoint) can emit two extension objects in
 * streamed chunks: `prompt_progress` (PP phase) and `timings` (both phases).
 * Both are llama.cpp-specific and OPTIONAL — always guard for their absence.
 * This module parses them into a display state and renders it into the shared
 * token status bar slot while a request is in flight.
 */

export type LlamaSpeedPhase = "pp" | "tg";

export interface LlamaSpeedState {
	phase: LlamaSpeedPhase;
	/** Human-readable single line, e.g. `PP 943.0 t/s 45%`. */
	line: string;
	/** Secondary info for the tooltip, e.g. `prompt 300/512 · cache 128`. */
	detail: string;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Format the PP (prompt processing) readout using the "timed" form: the cached
 * portion is excluded from both progress and speed.
 */
export function formatPpLine(processed: number, cache: number, total: number, timeMs: number): string {
	const span = total - cache;
	if (span <= 0) {
		return "PP 100%"; // fully cached (or degenerate): no real work
	}
	const timed = Math.max(0, processed - cache);
	const pct = (timed / span) * 100;
	let line = "PP";
	if (timeMs > 0) {
		line += ` ${(timed / (timeMs / 1000)).toFixed(1)} t/s`;
	}
	return `${line} ${Math.round(pct)}%`;
}

/**
 * Format the TG (token generation) readout. The cumulative rate is noisy for
 * the first few tokens (small denominator), so the t/s readout is held until
 * 8 tokens; the token count always shows.
 */
export function formatTgLine(perSecond: number, n: number): string {
	const rate = n >= 8 ? `${perSecond.toFixed(1)} t/s` : "— t/s";
	return `TG ${rate} ${n} tok`;
}

/**
 * Format a duration in milliseconds: `271.9 ms` below one second, otherwise
 * seconds with two decimals (e.g. `5.81 s`).
 */
export function formatDurationMs(ms: number): string {
	if (ms < 1000) {
		return `${ms.toFixed(1)} ms`;
	}
	return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Build the detailed llama.cpp usage report for the final status bar tooltip
 * (cache hit rate, prefill and decode timings). Returns undefined when the
 * usage object carries no `timings` object, or it lacks `prompt_ms`/
 * `predicted_ms` (non-llama.cpp backend, or the fields are disabled).
 *
 * llama.cpp's `prompt_n`/`prompt_ms` cover only the non-cached portion of the
 * prompt, so the prefill line reports real work. The cache hit rate is
 * computed from `prompt_tokens_details.cached_tokens`, falling back to
 * `timings.cache_n`.
 */
export function formatLlamaUsageReport(usage: TokenUsage): string | undefined {
	const timings = usage.timings;
	if (!timings) {
		return undefined;
	}
	const promptMs = num(timings.prompt_ms);
	const predictedMs = num(timings.predicted_ms);
	if (promptMs === undefined || predictedMs === undefined) {
		return undefined;
	}

	const lines: string[] = [];

	// Cache hit rate + provenance
	const promptTokens = num(usage.prompt_tokens);
	const cached = num(usage.prompt_tokens_details?.cached_tokens) ?? num(timings.cache_n);
	if (cached !== undefined && promptTokens !== undefined && promptTokens > 0) {
		const cacheParts = [`${Math.round(cached)}/${promptTokens} (${((cached / promptTokens) * 100).toFixed(1)}%)`];
		if (typeof timings.cache_source === "string" && timings.cache_source.length > 0) {
			cacheParts.push(timings.cache_source);
		}
		if (typeof timings.cache_reason === "string" && timings.cache_reason.length > 0) {
			cacheParts.push(timings.cache_reason);
		}
		const reprocessed = num(timings.cache_reprocessed_n);
		if (reprocessed !== undefined && reprocessed > 0) {
			cacheParts.push(`reprocessed ${reprocessed}`);
		}
		lines.push(`  - Cache: ${cacheParts.join(" · ")}`);
	}

	// Prefill (prompt processing of the non-cached portion)
	const promptN = num(timings.prompt_n);
	const promptRate =
		num(timings.prompt_per_second) ?? (promptN !== undefined && promptMs > 0 ? promptN / (promptMs / 1000) : undefined);
	const prefillParts: string[] = [];
	if (promptN !== undefined) {
		prefillParts.push(`${promptN} tok`);
	}
	prefillParts.push(formatDurationMs(promptMs));
	if (promptRate !== undefined) {
		prefillParts.push(`${promptRate.toFixed(1)} t/s`);
	}
	lines.push(`  - Prefill: ${prefillParts.join(" · ")}`);

	// Decode (token generation)
	const predictedN = num(timings.predicted_n) ?? num(usage.completion_tokens);
	const predictedRate =
		num(timings.predicted_per_second) ??
		(predictedN !== undefined && predictedMs > 0 ? predictedN / (predictedMs / 1000) : undefined);
	const decodeParts: string[] = [];
	if (predictedN !== undefined) {
		decodeParts.push(`${predictedN} tok`);
	}
	decodeParts.push(formatDurationMs(predictedMs));
	if (predictedRate !== undefined) {
		decodeParts.push(`${predictedRate.toFixed(1)} t/s`);
	}
	lines.push(`  - Decode: ${decodeParts.join(" · ")}`);

	// Reasoning vs. visible tokens
	const details = usage.completion_tokens_details;
	if (details) {
		const detailParts: string[] = [];
		const reasoning = num(details.reasoning_tokens);
		const visible = num(details.visible_tokens);
		if (reasoning !== undefined) {
			detailParts.push(`Reasoning: ${reasoning}`);
		}
		if (visible !== undefined) {
			detailParts.push(`Visible: ${visible}`);
		}
		if (detailParts.length > 0) {
			lines.push(`  - ${detailParts.join(" · ")}`);
		}
	}

	// Total wall time (prefill + decode)
	lines.push(`  - Total: ${formatDurationMs(promptMs + predictedMs)}`);

	return lines.join("\n");
}

/**
 * Extract the live speed state from a parsed SSE chunk. Returns undefined when
 * the chunk carries neither llama.cpp extension field (non-llama.cpp backend,
 * or the fields are disabled). When both are present, `timings` wins, which is
 * the natural PP→TG switch once the first token lands.
 */
export function parseLlamaSpeed(parsed: Record<string, unknown>): LlamaSpeedState | undefined {
	let state: LlamaSpeedState | undefined;

	const pp = parsed.prompt_progress;
	if (pp && typeof pp === "object") {
		const p = pp as Record<string, unknown>;
		const total = num(p.total);
		const cache = num(p.cache);
		const processed = num(p.processed);
		const timeMs = num(p.time_ms);
		if (total !== undefined && cache !== undefined && processed !== undefined && timeMs !== undefined) {
			state = {
				phase: "pp",
				line: formatPpLine(processed, cache, total, timeMs),
				detail: `prompt ${processed}/${total} · cache ${cache}`,
			};
		}
	}

	const timings = parsed.timings;
	if (timings && typeof timings === "object") {
		const t = timings as Record<string, unknown>;
		const n = num(t.predicted_n);
		if (n !== undefined && n >= 1) {
			const perSecond = num(t.predicted_per_second) ?? 0;
			const promptN = num(t.prompt_n);
			state = {
				phase: "tg",
				line: formatTgLine(perSecond, n),
				detail: promptN !== undefined ? `prompt ${promptN} tok` : "",
			};
		}
	}

	return state;
}

/**
 * Renders live llama.cpp PP/TG state into an existing status bar slot while at
 * least one request is in flight. The slot's token usage display is refreshed
 * by the provider after the request ends (no snapshot/restore here).
 */
export class LlamaSpeedDisplay implements vscode.Disposable {
	private static readonly THROTTLE_MS = 250;

	private _active = 0;
	private _pending: LlamaSpeedState | undefined;
	private _timer: NodeJS.Timeout | undefined;
	private _lastWrite = 0;

	constructor(private readonly item: vscode.StatusBarItem) {}

	/** Mark the start of a request. */
	begin(): void {
		this._active++;
	}

	/** Report a new speed state; UI writes are throttled (trailing edge). */
	update(state: LlamaSpeedState): void {
		if (this._active === 0) {
			return;
		}
		this._pending = state;
		if (this._timer === undefined) {
			const delay = Math.max(0, LlamaSpeedDisplay.THROTTLE_MS - (Date.now() - this._lastWrite));
			this._timer = setTimeout(() => {
				this._timer = undefined;
				this.flush();
			}, delay);
		}
	}

	/** Mark the end of a request; clears any pending throttled write at zero. */
	end(): void {
		if (this._active <= 0) {
			return;
		}
		this._active--;
		if (this._active === 0) {
			this.cancelPending();
		}
	}

	private cancelPending(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		this._pending = undefined;
	}

	private flush(): void {
		const state = this._pending;
		if (!state || this._active === 0) {
			return;
		}
		const icon = state.phase === "pp" ? "$(loading~spin)" : "$(zap)";
		this.item.backgroundColor = undefined;
		this.item.text = `${icon} ${state.line}`;
		this.item.tooltip = state.detail ? `${state.line}\n${state.detail}` : state.line;
		this._lastWrite = Date.now();
	}

	dispose(): void {
		this._active = 0;
		this.cancelPending();
	}
}
