import * as vscode from "vscode";

import { logger } from "./logger";

const AVAILABLE_CONTEXT_KEY = "oaicopilot.reasoningControlAvailable";
const BUSY_CONTEXT_KEY = "oaicopilot.reasoningControlBusy";
const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

export interface ReasoningControlTarget {
	id: string;
	model: string;
	baseUrl: string;
	headers: Record<string, string>;
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

/** Tracks active completions and the context keys used by the chat input menu. */
export class ReasoningControlManager implements vscode.Disposable {
	private readonly targets = new Map<string, ReasoningControlTarget>();
	private readonly busyIds = new Set<string>();
	private latestId: string | undefined;

	activate(target: ReasoningControlTarget): void {
		if (!target.id || !target.model || !target.baseUrl) {
			throw new Error("Invalid reasoning control target.");
		}
		this.targets.set(target.id, {
			...target,
			headers: { ...target.headers },
		});
		this.latestId = target.id;
		logger.debug("reasoningControl.activate", { id: target.id, model: target.model });
		this.updateContextKeys();
	}

	deactivate(id: string | undefined): void {
		// Unknown ids (e.g. completions captured while the feature was not
		// wired for this request) are no-ops: nothing to remove and no
		// context keys to refresh.
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
		this.updateContextKeys();
	}

	getLatestTarget(): ReasoningControlTarget | undefined {
		if (!this.latestId || this.busyIds.has(this.latestId)) {
			return undefined;
		}
		const target = this.targets.get(this.latestId);
		return target ? { ...target, headers: { ...target.headers } } : undefined;
	}

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

		this.busyIds.add(target.id);
		this.updateContextKeys();
		try {
			const result = await sendReasoningControlRequest(target);
			logger.debug("reasoningControl.endLatestReasoning.result", {
				id: target.id,
				success: result.success,
				message: result.message,
			});
			if (result.success) {
				this.deactivate(target.id);
			}
			return result;
		} finally {
			this.busyIds.delete(target.id);
			this.updateContextKeys();
		}
	}

	clear(): void {
		this.targets.clear();
		this.busyIds.clear();
		this.latestId = undefined;
		this.updateContextKeys();
	}

	dispose(): void {
		this.clear();
	}

	private updateContextKeys(): void {
		const available = this.latestId !== undefined && this.targets.has(this.latestId);
		const busy = available && this.latestId !== undefined && this.busyIds.has(this.latestId);
		void vscode.commands
			.executeCommand("setContext", AVAILABLE_CONTEXT_KEY, available)
			.then(undefined, (e: unknown) =>
				logger.error("reasoningControl.contextFailed", { key: AVAILABLE_CONTEXT_KEY, error: String(e) })
			);
		void vscode.commands
			.executeCommand("setContext", BUSY_CONTEXT_KEY, busy)
			.then(undefined, (e: unknown) =>
				logger.error("reasoningControl.contextFailed", { key: BUSY_CONTEXT_KEY, error: String(e) })
			);
	}
}
