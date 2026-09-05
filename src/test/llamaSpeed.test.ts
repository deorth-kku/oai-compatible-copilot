import * as assert from "assert";
import {
	formatDurationMs,
	formatLlamaUsageReport,
	formatPpLine,
	formatTgLine,
	parseLlamaSpeed,
} from "../llamaSpeed";
import type { TokenUsage } from "../types";

suite("llamaSpeed", () => {
	test("formatPpLine: SPEC §6 worked example", () => {
		// pps = (300-128)/(182.4ms), pct = (300-128)/(512-128)
		assert.strictEqual(formatPpLine(300, 128, 512, 182.4), "PP 943.0 t/s 45%");
		// PP complete
		assert.strictEqual(formatPpLine(512, 128, 512, 451.0), "PP 851.4 t/s 100%");
	});

	test("formatPpLine: fully cached prompt", () => {
		assert.strictEqual(formatPpLine(128, 128, 128, 0.1), "PP 100%");
	});

	test("formatPpLine: first progress chunk (nothing timed yet)", () => {
		assert.strictEqual(formatPpLine(128, 128, 512, 0.1), "PP 0.0 t/s 0%");
	});

	test("formatTgLine: rate held until 8 tokens", () => {
		assert.strictEqual(formatTgLine(33.2, 5), "TG — t/s 5 tok");
		assert.strictEqual(formatTgLine(32.3, 42), "TG 32.3 t/s 42 tok");
	});

	test("parseLlamaSpeed: prompt_progress chunk", () => {
		const state = parseLlamaSpeed({
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {} }],
			prompt_progress: { total: 512, cache: 128, processed: 300, time_ms: 182.4 },
		});
		assert.deepStrictEqual(state, {
			phase: "pp",
			line: "PP 943.0 t/s 45%",
			detail: "prompt 300/512 · cache 128",
		});
	});

	test("parseLlamaSpeed: timings chunk switches to TG", () => {
		const state = parseLlamaSpeed({
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: " world" } }],
			timings: {
				prompt_n: 512,
				prompt_ms: 451.0,
				prompt_per_second: 581.0,
				predicted_n: 5,
				predicted_ms: 120.3,
				predicted_per_token_ms: 30.1,
				predicted_per_second: 33.2,
			},
		});
		assert.deepStrictEqual(state, {
			phase: "tg",
			line: "TG — t/s 5 tok",
			detail: "prompt 512 tok",
		});
	});

	test("parseLlamaSpeed: timings wins when both fields present", () => {
		const state = parseLlamaSpeed({
			prompt_progress: { total: 512, cache: 128, processed: 512, time_ms: 451.0 },
			timings: { prompt_n: 512, predicted_n: 1, predicted_per_second: 0.0 },
		});
		assert.strictEqual(state?.phase, "tg");
		assert.strictEqual(state?.line, "TG — t/s 1 tok");
	});

	test("parseLlamaSpeed: plain chunk without extension fields", () => {
		assert.strictEqual(
			parseLlamaSpeed({
				object: "chat.completion.chunk",
				choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
			}),
			undefined
		);
	});

	test("parseLlamaSpeed: malformed fields are ignored", () => {
		assert.strictEqual(
			parseLlamaSpeed({
				prompt_progress: { total: 512, cache: "x", processed: 300, time_ms: 182.4 },
				timings: { prompt_n: 512, predicted_n: "many" },
			}),
			undefined
		);
	});
});

suite("formatDurationMs", () => {
	test("milliseconds below one second", () => {
		assert.strictEqual(formatDurationMs(271.907), "271.9 ms");
		assert.strictEqual(formatDurationMs(0), "0.0 ms");
	});

	test("seconds at and above one second", () => {
		assert.strictEqual(formatDurationMs(1000), "1.00 s");
		assert.strictEqual(formatDurationMs(5810.913), "5.81 s");
	});
});

suite("formatLlamaUsageReport", () => {
	test("full llama.cpp usage object (screenshot values)", () => {
		const usage: TokenUsage = {
			prompt_tokens: 5660,
			completion_tokens: 155,
			total_tokens: 5815,
			prompt_tokens_details: { cached_tokens: 5644 },
			completion_tokens_details: { reasoning_tokens: 25, visible_tokens: 130 },
			timings: {
				cache_n: 5644,
				cache_reprocessed_n: 16,
				cache_source: "ram",
				cache_reason: "committed",
				prompt_n: 16,
				prompt_ms: 271.907,
				prompt_per_second: 58.843648747549715,
				predicted_n: 155,
				predicted_ms: 5810.913,
				predicted_per_second: 26.501859518461213,
			},
		};

		assert.deepStrictEqual(formatLlamaUsageReport(usage)?.split("\n"), [
			"  - Cache: 5644/5660 (99.7%) · ram · committed · reprocessed 16",
			"  - Prefill: 16 tok · 271.9 ms · 58.8 t/s",
			"  - Decode: 155 tok · 5.81 s · 26.5 t/s",
			"  - Reasoning: 25 · Visible: 130",
			"  - Total: 6.08 s",
		]);
	});

	test("plain OpenAI usage (no llama.cpp fields) → undefined", () => {
		const usage: TokenUsage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
		assert.strictEqual(formatLlamaUsageReport(usage), undefined);
	});

	test("missing predicted_ms → undefined", () => {
		const usage: TokenUsage = {
			prompt_tokens: 100,
			completion_tokens: 10,
			total_tokens: 110,
			timings: { prompt_ms: 50 },
		};
		assert.strictEqual(formatLlamaUsageReport(usage), undefined);
	});

	test("malformed (non-numeric) timings → undefined", () => {
		const usage = {
			prompt_tokens: 100,
			completion_tokens: 10,
			total_tokens: 110,
			timings: { prompt_ms: "50", predicted_ms: 1200 },
		} as unknown as TokenUsage;
		assert.strictEqual(formatLlamaUsageReport(usage), undefined);
	});

	test("timings without cache/reasoning fields → degraded report", () => {
		const usage: TokenUsage = {
			prompt_tokens: 100,
			completion_tokens: 10,
			total_tokens: 110,
			timings: { prompt_ms: 200, predicted_ms: 1200 },
		};

		assert.deepStrictEqual(formatLlamaUsageReport(usage)?.split("\n"), [
			"  - Prefill: 200.0 ms",
			"  - Decode: 10 tok · 1.20 s · 8.3 t/s",
			"  - Total: 1.40 s",
		]);
	});

	test("draft model stats render a Draft line", () => {
		const usage: TokenUsage = {
			prompt_tokens: 104948,
			completion_tokens: 176,
			total_tokens: 105124,
			prompt_tokens_details: { cached_tokens: 104254 },
			timings: {
				cache_n: 104254,
				prompt_n: 694,
				prompt_ms: 2977.98,
				prompt_per_second: 233.04387537861234,
				predicted_n: 176,
				predicted_ms: 12539.596,
				predicted_per_second: 13.95579251516556,
				draft_n: 32,
				draft_n_accepted: 9,
			},
		};

		assert.deepStrictEqual(formatLlamaUsageReport(usage)?.split("\n"), [
			"  - Cache: 104254/104948 (99.3%)",
			"  - Prefill: 694 tok · 2.98 s · 233.0 t/s",
			"  - Decode: 176 tok · 12.54 s · 14.0 t/s",
			"  - Draft: 9/32 (28.1%)",
			"  - Total: 15.52 s",
		]);
	});

	test("only draft_n (no accepted count) → no Draft line", () => {
		const usage: TokenUsage = {
			prompt_tokens: 100,
			completion_tokens: 10,
			total_tokens: 110,
			timings: { prompt_ms: 200, predicted_ms: 1200, draft_n: 32 },
		};

		assert.ok(!formatLlamaUsageReport(usage)?.includes("Draft"), String(formatLlamaUsageReport(usage)));
	});

	test("cache hit rate falls back to cache_n", () => {
		const usage: TokenUsage = {
			prompt_tokens: 1000,
			completion_tokens: 10,
			total_tokens: 1010,
			timings: { cache_n: 900, prompt_ms: 100, predicted_ms: 200 },
		};

		assert.strictEqual(formatLlamaUsageReport(usage)?.split("\n")?.[0], "  - Cache: 900/1000 (90.0%)");
	});

	test("real llama-server payload (nested timings, log values)", () => {
		const usage: TokenUsage = {
			prompt_tokens: 24313,
			completion_tokens: 285,
			total_tokens: 24598,
			prompt_tokens_details: { cached_tokens: 23175 },
			timings: {
				cache_n: 23175,
				prompt_n: 1138,
				prompt_ms: 275.416,
				prompt_per_token_ms: 0.24201757469244287,
				prompt_per_second: 4131.931332965405,
				predicted_n: 285,
				predicted_ms: 1707.33,
				predicted_per_token_ms: 6.011725352112676,
				predicted_per_second: 166.34159769933171,
			},
		};

		assert.deepStrictEqual(formatLlamaUsageReport(usage)?.split("\n"), [
			"  - Cache: 23175/24313 (95.3%)",
			"  - Prefill: 1138 tok · 275.4 ms · 4131.9 t/s",
			"  - Decode: 285 tok · 1.71 s · 166.3 t/s",
			"  - Total: 1.98 s",
		]);
	});
});
