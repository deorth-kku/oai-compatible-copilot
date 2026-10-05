import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import { formatLlamaUsageReport } from "./llamaSpeed";
import { formatOpenRouterUsageReport } from "./openrouterSpeed";
import type { TokenUsage } from "./types";

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Token Count";
	tokenCountStatusBarItem.text = "$(symbol-numeric) Ready";
	tokenCountStatusBarItem.tooltip = "Current model token usage - Click to Open Configuration UI";
	tokenCountStatusBarItem.command = "oaicopilot.openConfig";
	context.subscriptions.push(tokenCountStatusBarItem);
	// Show the status bar item initially
	tokenCountStatusBarItem.show();
	return tokenCountStatusBarItem;
}

/**
 * Format number to thousands (K, M, B) format
 * @param value The number to format
 * @returns Formatted string (e.g., "2.3K", "168.0K")
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage
 * @param usedTokens Tokens used
 * @param maxTokens Maximum tokens available
 * @returns Progress bar string (e.g., "▆ 75.2%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

	return `${blocks[blockIndex]} ${usagePercentage.toFixed(1)}%`;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 * @param convId Conversation id scoping the reasoning replay cache; pass
 * undefined when the request will not replay cached reasoning traces
 * (non-OpenAI api modes) so only round-tripped thinking is counted.
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean },
	convId?: string
): Promise<void> {
	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) => countMessageTokens(message, modelConfig, convId));

	const tokenCounts = await Promise.all(tokenCountPromises);
	const messagesTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Calculate tool definition tokens
	let toolTokens = 0;
	if (tools && tools.length > 0) {
		toolTokens = await countToolTokens(tools);
	}

	// Total tokens: messages + tool definitions + reserved output
	const totalTokenCount = messagesTokens + toolTokens;
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	// Create visual progress bar with single progressive block
	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	const displayText = `$(symbol-parameter) ${progressBar}`;
	statusBarItem.text = displayText;
	statusBarItem.tooltip = `Token Usage: ${formatTokenCount(totalTokenCount)} / ${formatTokenCount(maxTokens)}\n
${progressBar}\n
  - Messages: ${formatTokenCount(messagesTokens)}  (${Math.min((messagesTokens / maxTokens) * 100, 100).toFixed(1)}%)
  - Tools: ${formatTokenCount(toolTokens)}  (${Math.min((toolTokens / maxTokens) * 100, 100).toFixed(1)}%) \n
Click to Open Configuration UI`;

	applyUsageColoring(statusBarItem, totalTokenCount, maxTokens);

	statusBarItem.show();
}

/**
 * Color the status bar item based on token usage percentage
 * (red at >= 90%, yellow at >= 70%, otherwise no background).
 */
function applyUsageColoring(statusBarItem: vscode.StatusBarItem, totalTokenCount: number, maxTokens: number): void {
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	if (usagePercentage >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		statusBarItem.backgroundColor = undefined;
	}
}

/**
 * Update the status bar from the server-reported token usage of a finished
 * request (the `usage` of the final response chunk). Unlike
 * {@link updateContextStatusBar}, nothing is counted locally, so the number
 * already includes the just-generated assistant reply.
 * @param usage Server-reported token usage from the final response chunk
 * @param model The language model information (context window size)
 * @param statusBarItem The status bar item to update
 */
export function updateContextStatusBarFromUsage(
	usage: TokenUsage,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem
): void {
	const totalTokenCount = usage.total_tokens ?? 0;
	const promptTokens = usage.prompt_tokens ?? 0;
	const completionTokens = usage.completion_tokens ?? 0;
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	statusBarItem.text = `$(symbol-parameter) ${progressBar}`;
	// llama.cpp backends (llama-server) enrich the final usage object with
	// timing/cache fields; render them as a report section when present.
	const llamaReport = formatLlamaUsageReport(usage);
	const llamaSection = llamaReport ? `  ── llama.cpp ──\n${llamaReport}\n` : "";
	// OpenRouter backends report prompt-cache counters on every response and,
	// with the router-metadata opt-in, the upstream wall time. Rendered as its
	// own section so it never mixes with the llama.cpp one (a request is
	// served by exactly one backend).
	const openRouterReport = formatOpenRouterUsageReport(usage);
	const openRouterSection = openRouterReport ? `  ── OpenRouter ──\n${openRouterReport}\n` : "";
	statusBarItem.tooltip = `Token Usage: ${formatTokenCount(totalTokenCount)} / ${formatTokenCount(maxTokens)}\n
${progressBar}\n
  - Prompt: ${formatTokenCount(promptTokens)}  (${Math.min((promptTokens / maxTokens) * 100, 100).toFixed(1)}%)
  - Completion: ${formatTokenCount(completionTokens)}  (${Math.min((completionTokens / maxTokens) * 100, 100).toFixed(1)}%) \n
${llamaSection}${openRouterSection}Click to Open Configuration UI`;

	applyUsageColoring(statusBarItem, totalTokenCount, maxTokens);

	statusBarItem.show();
}
