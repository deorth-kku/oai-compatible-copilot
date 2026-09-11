import * as vscode from "vscode";

import { logger } from "./logger";

const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

export interface ReasoningControlTarget {
	id: string;
	model: string;
	baseUrl: string;
	headers: Record<string, string>;
	/** Epoch milliseconds when TG started (the stream is registered at that point). */
	tgStartedAt: number;
}

export interface ReasoningControlResult {
	success: boolean;
	message?: string;
}

/** Send one non-retried llama.cpp reasoning-control request. */
export async function sendReasoningControlRequest(
	target: ReasoningControlTarget,
	timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS
): Promise<ReasoningControlResult> {
	const normalizedBaseUrl = target.baseUrl.trim().replace(/\/+$/, "");
	if (!normalizedBaseUrl.startsWith("http")) {
		return { success: false, message: "Invalid base URL for reasoning control." };
	}

	const url = `${normalizedBaseUrl}/chat/completions/control`;
	const body = {
		id: target.id,
		action: "reasoning_end",
		model: target.model,
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	logger.debug("reasoningControl.request.start", { url, id: target.id, model: target.model });

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...target.headers,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		logger.debug("reasoningControl.request.response", { url, status: response.status, ok: response.ok });

		if (!response.ok) {
			let responseText = "";
			try {
				responseText = await response.text();
			} catch {
				// The status code is sufficient when the error body cannot be read.
			}
			const detail = responseText ? ` ${responseText}` : "";
			return {
				success: false,
				message: `Reasoning control failed with HTTP ${response.status}${detail}`.trim(),
			};
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { success: false, message: "Reasoning control returned an invalid JSON response." };
		}

		if (!payload || typeof payload !== "object" || (payload as { success?: unknown }).success !== true) {
			const message =
				payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
					? (payload as { message: string }).message
					: "Reasoning control was not accepted by the server.";
			return { success: false, message };
		}

		return { success: true };
	} catch (e) {
		if (controller.signal.aborted) {
			return { success: false, message: `Reasoning control timed out after ${timeoutMs} ms.` };
		}
		const message = e instanceof Error ? e.message : String(e);
		logger.warn("reasoningControl.requestFailed", { url, error: message });
		return { success: false, message: `Reasoning control request failed: ${message}` };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Tracks active opt-in completions so the status bar click (see
 * LlamaSpeedDisplay / extension.ts) can target the latest one.
 */
export class ReasoningControlManager implements vscode.Disposable {
	private readonly targets = new Map<string, ReasoningControlTarget>();
	private readonly busyIds = new Set<string>();
	private latestId: string | undefined;

	activate(target: ReasoningControlTarget): void {
		if (!target.id || !target.model || !target.baseUrl || !Number.isFinite(target.tgStartedAt)) {
			throw new Error("Invalid reasoning control target.");
		}
		this.targets.set(target.id, {
			...target,
			headers: { ...target.headers },
		});
		this.latestId = target.id;
		logger.debug("reasoningControl.activate", { id: target.id, model: target.model });
	}

	deactivate(id: string | undefined): void {
		// Unknown ids (e.g. completions captured while the feature was not
		// wired for this request) are no-ops: nothing to remove.
		if (!id || !this.targets.has(id)) {
			return;
		}
		logger.debug("reasoningControl.deactivate", { id });
		this.targets.delete(id);
		this.busyIds.delete(id);
		if (this.latestId === id) {
			const remaining = Array.from(this.targets.keys());
			this.latestId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
		}
	}

	getLatestTarget(): ReasoningControlTarget | undefined {
		if (!this.latestId || this.busyIds.has(this.latestId)) {
			return undefined;
		}
		const target = this.targets.get(this.latestId);
		return target ? { ...target, headers: { ...target.headers } } : undefined;
	}

	/**
	 * All currently registered targets in registration order, excluding any
	 * that are busy (a `reasoning_end` request is already in flight for them).
	 */
	listTargets(): ReasoningControlTarget[] {
		return Array.from(this.targets.values())
			.filter((t) => !this.busyIds.has(t.id))
			.map((t) => ({ ...t, headers: { ...t.headers } }));
	}

	/**
	 * Send `reasoning_end` to one specific registered stream. On success the
	 * stream is deactivated; on failure it stays registered so the request can
	 * be retried.
	 */
	async endReasoning(id: string): Promise<ReasoningControlResult> {
		const target = this.targets.get(id);
		logger.debug("reasoningControl.endReasoning", { id, known: target !== undefined });
		if (!target) {
			return { success: false, message: "No registered completion matches that id." };
		}
		this.busyIds.add(id);
		try {
			const result = await sendReasoningControlRequest(target);
			logger.debug("reasoningControl.endReasoning.result", {
				id,
				success: result.success,
				message: result.message,
			});
			if (result.success) {
				this.deactivate(id);
			}
			return result;
		} finally {
			this.busyIds.delete(id);
		}
	}

	/**
	 * Send `reasoning_end` to the most recently registered stream.
	 */
	async endLatestReasoning(): Promise<ReasoningControlResult> {
		const target = this.getLatestTarget();
		logger.debug("reasoningControl.endLatestReasoning", {
			latestId: this.latestId,
			targetId: target?.id,
			busy: this.latestId !== undefined && this.busyIds.has(this.latestId),
		});
		if (!target) {
			return { success: false, message: "No active completion is available for reasoning control." };
		}
		return this.endReasoning(target.id);
	}

	clear(): void {
		this.targets.clear();
		this.busyIds.clear();
		this.latestId = undefined;
	}

	dispose(): void {
		this.clear();
	}
}
