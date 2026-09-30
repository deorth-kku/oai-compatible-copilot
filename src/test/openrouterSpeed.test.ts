import * as assert from "assert";
import * as vscode from "vscode";
import { formatOrDurationMs, formatOpenRouterUsageReport, isOpenRouterUsage } from "../openrouterSpeed";
import { updateContextStatusBarFromUsage } from "../statusBar";
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

suite("openrouterSpeed", () => {
	test("formatOrDurationMs: milliseconds below one second", () => {
		assert.strictEqual(formatOrDurationMs(271.907), "271.9 ms");
		assert.strictEqual(formatOrDurationMs(0), "0.0 ms");
	});

	test("formatOrDurationMs: seconds at and above one second", () => {
		assert.strictEqual(formatOrDurationMs(1000), "1.00 s");
		assert.strictEqual(formatOrDurationMs(5810.913), "5.81 s");
	});

	test("no metadata and no cache writes → no report (other backends)", () => {
		// A plain OpenAI-style usage: cached_tokens only, no openrouter metadata
		// and no cache_write_tokens. Must not produce an OpenRouter section.
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 500,
			total_tokens: 1500,
			prompt_tokens_details: { cached_tokens: 512 },
		};
		assert.strictEqual(isOpenRouterUsage(usage), false);
		assert.strictEqual(formatOpenRouterUsageReport(usage), undefined);
	});

	test("cache_write_tokens alone is enough to opt in", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 100,
			total_tokens: 1100,
			prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 },
		};
		assert.strictEqual(isOpenRouterUsage(usage), true);
		const report = formatOpenRouterUsageReport(usage);
		assert.ok(report, report);
		assert.ok(report!.includes("Cache: 0/1000 (0.0%) · written 1000"), report);
	});

	test("full report: cache, throughput, reasoning/visible, total", () => {
		const usage: TokenUsage = {
			prompt_tokens: 10339,
			completion_tokens: 60,
			total_tokens: 10399,
			prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 21 },
			completion_tokens_details: { reasoning_tokens: 45 },
			openrouter: {
				requested: "anthropic/claude-sonnet-4",
				strategy: "direct",
				region: "iad",
				summary: "available=1, selected=Anthropic",
				attempt: 1,
				is_byok: false,
				generation_time: 2016,
			},
		};

		const report = formatOpenRouterUsageReport(usage);
		assert.ok(report, "report was generated");
		const lines = report!.split("\n");
		assert.deepStrictEqual(lines, [
			"  - Cache: 10318/10339 (99.8%) · written 21",
			"  - Throughput: 60 tok · 2.02 s · 29.8 t/s",
			"  - Reasoning: 45 · Visible: 15",
			"  - Total: 2.02 s · iad · direct",
		]);
	});

	test("explicit visible_tokens wins over the derived remainder", () => {
		const usage: TokenUsage = {
			prompt_tokens: 100,
			completion_tokens: 155,
			total_tokens: 255,
			completion_tokens_details: { reasoning_tokens: 25, visible_tokens: 130 },
			openrouter: { generation_time: 5810 },
		};
		const report = formatOpenRouterUsageReport(usage)!;
		assert.ok(report.includes("Reasoning: 25 · Visible: 130"), report);
	});

	test("derived visible never goes negative", () => {
		// Reasoning tokens can exceed completion_tokens on some backends
		// (they are billed separately); the remainder must clamp at 0.
		const usage: TokenUsage = {
			prompt_tokens: 100,
			completion_tokens: 10,
			total_tokens: 110,
			completion_tokens_details: { reasoning_tokens: 25 },
			openrouter: { generation_time: 1000 },
		};
		const report = formatOpenRouterUsageReport(usage)!;
		assert.ok(report.includes("Reasoning: 25 · Visible: 0"), report);
	});

	test("cache replay (metadata stripped) still shows the cache line", () => {
		// OpenRouter strips openrouter_metadata from response-cache replays, so
		// cache_write_tokens is the only remaining opt-in signal.
		const usage: TokenUsage = {
			prompt_tokens: 800,
			completion_tokens: 40,
			total_tokens: 840,
			prompt_tokens_details: { cached_tokens: 768, cache_write_tokens: 0 },
		};
		const report = formatOpenRouterUsageReport(usage);
		assert.deepStrictEqual(report?.split("\n"), ["  - Cache: 768/800 (96.0%)"]);
	});

	test("zero cache_write_tokens is not rendered as a write", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 10,
			total_tokens: 1010,
			prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 0 },
		};
		const report = formatOpenRouterUsageReport(usage)!;
		assert.ok(!report.includes("written"), report);
	});

	test("missing generation_time drops throughput and total", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 50,
			total_tokens: 1050,
			prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
			openrouter: { strategy: "fallback", region: null },
		};
		const report = formatOpenRouterUsageReport(usage);
		assert.deepStrictEqual(report?.split("\n"), ["  - Cache: 900/1000 (90.0%)"]);
	});

	test("malformed metadata fields are ignored", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 50,
			total_tokens: 1050,
			prompt_tokens_details: { cached_tokens: "many" as unknown as number },
			openrouter: { generation_time: "fast" as unknown as number, strategy: 42 as unknown as string },
		};
		// Nothing usable survives → the opt-in signal is the openrouter object
		// itself, but no line can be built from it.
		assert.strictEqual(formatOpenRouterUsageReport(usage), undefined);
	});

	test("zero generation_time does not divide by zero", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 50,
			total_tokens: 1050,
			prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			openrouter: { generation_time: 0 },
		};
		const report = formatOpenRouterUsageReport(usage);
		assert.deepStrictEqual(report?.split("\n"), ["  - Cache: 0/1000 (0.0%)"]);
	});

	test("isOpenRouterUsage: llama.cpp timings alone do not opt in", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 50,
			total_tokens: 1050,
			prompt_tokens_details: { cached_tokens: 900 },
			timings: { prompt_ms: 200, predicted_ms: 1200 },
		};
		assert.strictEqual(isOpenRouterUsage(usage), false);
	});
});

suite("statusBar OpenRouter section", () => {
	test("renders an OpenRouter section alongside the token totals", () => {
		const item = createStatusBarStub();
		const model = createModel(128_000, 32_000);
		const usage: TokenUsage = {
			prompt_tokens: 10339,
			completion_tokens: 60,
			total_tokens: 10399,
			prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: 45 },
			openrouter: { generation_time: 2016, region: "iad", strategy: "direct" },
		};

		updateContextStatusBarFromUsage(usage, model, item);

		const tooltip = String(item.tooltip);
		assert.ok(tooltip.includes("── OpenRouter ──"), tooltip);
		assert.ok(tooltip.includes("Cache: 10318/10339 (99.8%)"), tooltip);
		assert.ok(tooltip.includes("Throughput: 60 tok · 2.02 s · 29.8 t/s"), tooltip);
		assert.ok(tooltip.includes("Reasoning: 45 · Visible: 15"), tooltip);
		assert.ok(tooltip.includes("Total: 2.02 s · iad · direct"), tooltip);
		// Never mixed with the llama.cpp section for the same request.
		assert.ok(!tooltip.includes("llama.cpp"), tooltip);
		assert.ok(tooltip.endsWith("Click to Open Configuration UI"), tooltip);
	});

	test("no OpenRouter section for a plain backend", () => {
		const item = createStatusBarStub();
		const model = createModel(128_000, 32_000);
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 500,
			total_tokens: 1500,
			prompt_tokens_details: { cached_tokens: 512 },
		};

		updateContextStatusBarFromUsage(usage, model, item);

		assert.ok(!String(item.tooltip).includes("OpenRouter"), String(item.tooltip));
	});
});
