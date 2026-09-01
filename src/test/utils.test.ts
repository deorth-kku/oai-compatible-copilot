import * as assert from "assert";
import { normalizeUserModels } from "../utils";
import type { HFModelItem } from "../types";

suite("normalizeUserModels migration", () => {
	test("migrates legacy reasoning.{enabled,effort,max_tokens} to optimization fields", () => {
		const input: HFModelItem[] = [
			{
				id: "m1",
				owned_by: "p",
				reasoning: { enabled: true, effort: "high", max_tokens: 3000, exclude: true },
			},
		];
		const out = normalizeUserModels(input);
		assert.strictEqual(out.length, 1);
		const m = out[0];
		assert.strictEqual(m.optimization, "openrouter");
		assert.strictEqual(m.reasoning_effort, "high");
		assert.strictEqual(m.thinking_budget, 3000);
		// reasoning keeps only `exclude`
		assert.deepStrictEqual(m.reasoning, { exclude: true });
	});

	test("migrates reasoning.enabled === false to default optimization", () => {
		const out = normalizeUserModels([{ id: "m", owned_by: "p", reasoning: { enabled: false, effort: "low" } }]);
		assert.strictEqual(out[0].optimization, "default");
		assert.strictEqual(out[0].reasoning_effort, "low");
		assert.strictEqual(out[0].reasoning, undefined);
	});

	test("does not migrate when optimization is already set", () => {
		const out = normalizeUserModels([
			{ id: "m", owned_by: "p", optimization: "llama.cpp", reasoning: { effort: "high" } },
		]);
		// optimization preserved; reasoning untouched (no migration)
		assert.strictEqual(out[0].optimization, "llama.cpp");
		assert.deepStrictEqual(out[0].reasoning, { effort: "high" });
	});

	test("does not migrate models without legacy reasoning", () => {
		const out = normalizeUserModels([{ id: "m", owned_by: "p" }]);
		assert.strictEqual(out[0].optimization, undefined);
		assert.strictEqual(out[0].reasoning, undefined);
	});

	test("is idempotent (second pass is a no-op)", () => {
		const input: HFModelItem[] = [
			{ id: "m", owned_by: "p", reasoning: { enabled: true, effort: "high", max_tokens: 2500 } },
		];
		const first = normalizeUserModels(input);
		const second = normalizeUserModels(first);
		assert.deepStrictEqual(second, first);
	});
});
