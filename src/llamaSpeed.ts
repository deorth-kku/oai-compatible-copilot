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

/**
 * Status bar command while a reasoning-control request is live (both phases):
 * shows a picker of all registered in-flight streams and force-ends the
 * reasoning block of the one the user selects. During PP the requesting
 * stream itself is not registered yet, so the picker only lists other
 * streams already in TG (or nothing, if there is none).
 */
export const END_REASONING_COMMAND = "oaicopilot.endReasoning";

export interface LlamaSpeedState {
	phase: LlamaSpeedPhase;
	/** Human-readable single line, e.g. `PP 943.0 t/s 45%`. */
	line: string;
	/** Secondary info for the tooltip, e.g. `prompt 128/512 · cache 25.0%`. */
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

	// Speculative decoding draft acceptance (llama.cpp only)
	const draftN = num(timings.draft_n);
	const draftAccepted = num(timings.draft_n_accepted);
	if (draftN !== undefined && draftAccepted !== undefined) {
		const ratio = `${draftAccepted}/${draftN}`;
		const pct = draftN > 0 ? ` (${((draftAccepted / draftN) * 100).toFixed(1)}%)` : "";
		lines.push(`  - Draft: ${ratio}${pct}`);
	}

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
			// Tooltip detail: cache hit ratio (one decimal) instead of the live
			// processed counter, so the value is stable and matches the final
			// usage report.
			const cachePct = total > 0 ? ((cache / total) * 100).toFixed(1) : "0.0";
			state = {
				phase: "pp",
				line: formatPpLine(processed, cache, total, timeMs),
				detail: `prompt ${cache}/${total} · cache ${cachePct}%`,
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

/** Per-request bookkeeping for the shared display. */
interface LiveRequest {
	id: number;
	reasoningControl: boolean;
	/** Latest speed state reported for this request (undefined before the first chunk). */
	state: LlamaSpeedState | undefined;
	/** First PP cache detail; rendered into the tooltip exactly once. */
	tooltipDetail: string | undefined;
}

/**
 * Renders live llama.cpp PP/TG state into an existing status bar slot while at
 * least one request is in flight.
 *
 * With CONCURRENT requests the display always follows the MOST RECENTLY
 * STARTED request: the status bar LINE and the TOOLTIP (a one-shot snapshot of
 * the first PP cache detail) come from the SAME request, so the two never
 * disagree. Chunks from an earlier request that arrive later are stored for
 * that request but do not clobber the rendered display. When the rendered
 * request ends, the display falls back to the previous request's state and
 * tooltip snapshot.
 *
 * The status bar LINE updates in real time (throttled); the TOOLTIP stays
 * static and does not flicker on every chunk. The slot's token usage display
 * is refreshed by the provider after the request ends (no snapshot/restore
 * here).
 */
export class LlamaSpeedDisplay implements vscode.Disposable {
	private static readonly THROTTLE_MS = 250;

	private _nextId = 0;
	/** In-flight requests in start order; the last entry is the "latest". */
	private readonly _requests: LiveRequest[] = [];
	/** Id of the request whose tooltip snapshot is currently shown. */
	private _tooltipShownFor: number | undefined;
	private _timer: NodeJS.Timeout | undefined;
	private _lastWrite = 0;
	/** Command the slot carries outside of a live request (open configuration). */
	private readonly defaultCommand: string | vscode.Command | undefined;

	constructor(private readonly item: vscode.StatusBarItem) {
		this.defaultCommand = this.item.command;
	}

	/**
	 * Mark the start of a request and return its id, which must be passed back
	 * to {@link update} and {@link end}.
	 * @param reasoningControl Whether the request opted into real-time reasoning
	 * control (llama.cpp + `reasoning_control`); enables the click-to-end
	 * behavior and the tooltip hint while the stream is live.
	 */
	begin(reasoningControl = false): number {
		const id = this._nextId++;
		this._requests.push({
			id,
			reasoningControl,
			state: undefined,
			tooltipDetail: undefined,
		});
		return id;
	}

	/** Report a new speed state for a request; UI writes are throttled (trailing edge). */
	update(id: number, state: LlamaSpeedState): void {
		const req = this._requests.find((r) => r.id === id);
		if (!req) {
			return;
		}
		// Capture the first PP detail for the tooltip. The TG detail
		// (`prompt N tok`) is less informative and must never overwrite it.
		if (state.phase === "pp" && state.detail && req.tooltipDetail === undefined) {
			req.tooltipDetail = state.detail;
		}
		req.state = state;
		this.scheduleFlush();
	}

	/** Mark the end of a request; the display falls back to the previous one. */
	end(id: number): void {
		const index = this._requests.findIndex((r) => r.id === id);
		if (index === -1) {
			return;
		}
		const wasLatest = index === this._requests.length - 1;
		this._requests.splice(index, 1);
		if (this._requests.length === 0) {
			this.cancelPending();
			// Restore the default click behavior (open configuration UI).
			this.item.command = this.defaultCommand;
		} else if (wasLatest) {
			// The rendered request changed: the next flush falls back to the
			// previous request's state and tooltip snapshot.
			this.scheduleFlush();
		}
	}

	private scheduleFlush(): void {
		if (this._timer === undefined) {
			const delay = Math.max(0, LlamaSpeedDisplay.THROTTLE_MS - (Date.now() - this._lastWrite));
			this._timer = setTimeout(() => {
				this._timer = undefined;
				this.flush();
			}, delay);
		}
	}

	private cancelPending(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	/** The request whose state is rendered: the most recent one that reported a state. */
	private renderedRequest(): LiveRequest | undefined {
		for (let i = this._requests.length - 1; i >= 0; i--) {
			const req = this._requests[i];
			if (req.state) {
				return req;
			}
		}
		return undefined;
	}

	private flush(): void {
		const latest = this._requests[this._requests.length - 1];
		if (!latest) {
			return;
		}
		// Click behavior follows the most recently started request: with
		// reasoning control wired, clicking the status bar opens the
		// end-reasoning picker in both phases: during TG the requesting
		// stream is listed (it is registered once TG starts), during PP it is
		// not registered yet, so the picker only offers any OTHER stream
		// already in TG (or nothing, if there is none). Without it, the
		// default command (open configuration UI) applies.
		this.item.command = latest.reasoningControl ? END_REASONING_COMMAND : this.defaultCommand;
		const req = this.renderedRequest();
		if (req) {
			const state = req.state as LlamaSpeedState;
			const icon = state.phase === "pp" ? "$(loading~spin)" : "$(zap)";
			this.item.backgroundColor = undefined;
			this.item.text = `${icon} ${state.line}`;
			// Tooltip: write the rendered request's first PP cache snapshot
			// exactly once (even if the first flush already carries a TG
			// state, i.e. PP and TG arrived within the same throttle window).
			// When the display falls back to an earlier request after the
			// latest one ended, that request's snapshot is written then. With
			// reasoning control wired, the click hint is appended so the hint
			// is visible from the PP phase on.
			if (req.tooltipDetail !== undefined && this._tooltipShownFor !== req.id) {
				this.item.tooltip = latest.reasoningControl
					? `${req.tooltipDetail}\nClick To End Reasoning`
					: req.tooltipDetail;
				this._tooltipShownFor = req.id;
			}
		}
		this._lastWrite = Date.now();
	}

	dispose(): void {
		this._requests.length = 0;
		this.cancelPending();
	}
}
