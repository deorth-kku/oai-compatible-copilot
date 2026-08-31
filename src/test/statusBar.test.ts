import * as assert from "assert";
import * as vscode from "vscode";
import { createProgressBar, formatTokenCount, updateContextStatusBarFromUsage } from "../statusBar";
import type { TokenUsage } from "../types";

function createStatusBarStub(): vscode.StatusBarItem {
	return {
		text: "",
		tooltip: "",
		backgroundColor: undefined,
		show() {},
	} as unknown as vscode.StatusBarItem;
}

function createModel(maxInputTokens: number, maxOutputTokens: number): vscode.LanguageModelChatInformation {
	return { maxInputTokens, maxOutputTokens } as unknown as vscode.LanguageModelChatInformation;
}

suite("statusBar", () => {
	test("formatTokenCount formats K/M/B", () => {
		assert.strictEqual(formatTokenCount(999), "999");
		assert.strictEqual(formatTokenCount(2300), "2.3K");
		assert.strictEqual(formatTokenCount(1_680_000), "1.7M");
		assert.strictEqual(formatTokenCount(2_300_000_000), "2.3B");
	});

	test("createProgressBar clamps above 100%", () => {
		assert.strictEqual(createProgressBar(50, 100), "▅ 50.0%");
		assert.strictEqual(createProgressBar(200, 100), "█ 100.0%");
	});

	test("updateContextStatusBarFromUsage renders server-reported totals", () => {
		const item = createStatusBarStub();
		const model = createModel(128_000, 32_000);
		const usage: TokenUsage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };

		updateContextStatusBarFromUsage(usage, model, item);

		// 1500 / 160000 = 0.9375% → first block, "0.9%"
		assert.strictEqual(item.text, "$(symbol-parameter) ▁ 0.9%");
		const tooltip = String(item.tooltip);
		assert.ok(tooltip.includes("Token Usage: 1.5K / 160.0K"), tooltip);
		assert.ok(tooltip.includes("Prompt: 1.0K  (0.6%)"), tooltip);
		assert.ok(tooltip.includes("Completion: 500  (0.3%)"), tooltip);
		// Low usage → no background color
		assert.strictEqual(item.backgroundColor, undefined);
	});

	test("updateContextStatusBarFromUsage colors high usage", () => {
		const item = createStatusBarStub();
		const model = createModel(128_000, 32_000);
		const usage: TokenUsage = { prompt_tokens: 120_000, completion_tokens: 30_000, total_tokens: 150_000 };

		updateContextStatusBarFromUsage(usage, model, item);

		// 150000 / 160000 = 93.75% → error background
		assert.ok(item.backgroundColor instanceof vscode.ThemeColor);
		assert.strictEqual(item.backgroundColor.id, "statusBarItem.errorBackground");
	});
});
