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
import { LlamaSpeedDisplay, END_REASONING_COMMAND, REASONING_NOT_ACTIVE_COMMAND } from "./llamaSpeed";
import { ReasoningControlManager } from "./reasoningControl";

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

	// Invoked by clicking the token status bar during the TG phase of a
	// reasoning-control request (see LlamaSpeedDisplay).
	context.subscriptions.push(
		vscode.commands.registerCommand(END_REASONING_COMMAND, async () => {
			logger.debug("reasoningControl.command.invoked", { source: "status-bar" });
			const result = await reasoningControl.endLatestReasoning();
			logger.debug("reasoningControl.command.result", { success: result.success, message: result.message });
			if (result.success) {
				vscode.window.showInformationMessage("Reasoning ended.");
			} else {
				vscode.window.showWarningMessage(result.message ?? "Unable to end reasoning.");
			}
		})
	);

	// Invoked by clicking the token status bar during the PP phase of a
	// reasoning-control request: reasoning has not started yet, so there is
	// nothing to end.
	context.subscriptions.push(
		vscode.commands.registerCommand(REASONING_NOT_ACTIVE_COMMAND, () => {
			logger.debug("reasoningControl.notActive.invoked", { source: "status-bar" });
			return vscode.window.showInformationMessage("Not in a reasoning phase yet.");
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
