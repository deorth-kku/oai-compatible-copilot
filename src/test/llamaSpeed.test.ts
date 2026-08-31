import * as assert from "assert";
import { formatPpLine, formatTgLine, parseLlamaSpeed } from "../llamaSpeed";

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
