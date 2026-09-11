import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { CommonApi } from "./commonApi";
import { LlamaSpeedDisplay, END_REASONING_COMMAND } from "./llamaSpeed";
import { ReasoningControlManager } from "./reasoningControl";

/**
 * Compact elapsed-time readout for the end-reasoning picker, e.g. `42s`,
 * `3m 12s`, `1h 5m`. With concurrent streams the longest-running one is
 * usually the one the user wants to stop, so this is the primary
 * discriminator (the absolute start time is derivable from it).
 */
function formatTgElapsed(startedAt: number): string {
	const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) {
		return `${h}h ${m}m`;
	}
	if (m > 0) {
		return `${m}m ${s}s`;
	}
	return `${s}s`;
}

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	const llamaSpeedDisplay = new LlamaSpeedDisplay(tokenCountStatusBarItem);
	const reasoningControl = new ReasoningControlManager();
	context.subscriptions.push(llamaSpeedDisplay, reasoningControl);
	const provider = new HuggingFaceChatModelProvider(
		context.secrets,
		tokenCountStatusBarItem,
		llamaSpeedDisplay,
		context.globalState,
		reasoningControl
	);
	// Hydrate the persisted reasoning cache into memory before any request can run.
	CommonApi.hydrate();
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OAI Compatible Provider API Key",
				prompt: existing ? "Update your OAI Compatible API key" : "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage("OAI Compatible API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("OAI Compatible API key saved.");
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in oaicopilot.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `OAI Compatible API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	// Invoked by clicking the token status bar of a reasoning-control request
	// (see LlamaSpeedDisplay): shows a picker of all registered in-flight
	// streams and force-ends the one the user selects.
	context.subscriptions.push(
		vscode.commands.registerCommand(END_REASONING_COMMAND, async () => {
			logger.debug("reasoningControl.command.invoked", { source: "status-bar" });
			const targets = reasoningControl.listTargets();
			if (targets.length === 0) {
				vscode.window.showInformationMessage("No active completion is available for reasoning control.");
				return;
			}
			const pick = await vscode.window.showQuickPick(
				targets.map((t) => ({
					label: t.model,
					description: `TG ${formatTgElapsed(t.tgStartedAt)}`,
					detail: `${t.id} · ${t.baseUrl}`,
					target: t,
				})),
				{ placeHolder: "Select the stream to end reasoning on" }
			);
			if (!pick) {
				return;
			}
			const result = await reasoningControl.endReasoning(pick.target.id);
			logger.debug("reasoningControl.command.result", {
				id: pick.target.id,
				success: result.success,
				message: result.message,
			});
			if (result.success) {
				vscode.window.showInformationMessage("Reasoning ended.");
			} else {
				vscode.window.showWarningMessage(result.message ?? "Unable to end reasoning.");
			}
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("oaicopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("oaicopilot.logLevel")) {
				logger.reloadConfig();
			}
		})
	);
}

export function deactivate() {
	void CommonApi.flushNow();
}
