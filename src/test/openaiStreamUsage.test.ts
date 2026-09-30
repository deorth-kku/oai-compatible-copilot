import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiApi } from "../openai/openaiApi";
import { formatLlamaUsageReport } from "../llamaSpeed";
import { formatOpenRouterUsageReport } from "../openrouterSpeed";
import { CustomDataPartMimeTypes } from "../types";
import finalChunk from "./fixtures/llamaFinalChunk.json";

/**
 * The final SSE chunk is a real llama-server payload captured from the
 * extension log (see fixtures/llamaFinalChunk.json). It carries `timings`
 * as a SIBLING of `usage`. Used to verify that timings survives the full
 * streaming pipeline: SSE parse → usage capture → getUsage() → status bar
 * report formatter → Context Window data part serialization.
 */

function sseStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

function createProgressStub() {
	const parts: unknown[] = [];
	const progress = {
		report: (part: unknown) => {
			parts.push(part);
		},
	} as unknown as vscode.Progress<vscode.LanguageModelResponsePart2>;
	return { progress, parts };
}

suite("openai streaming usage pipeline (real log payload)", () => {
	test("usage.timings survives SSE parse → capture → getUsage → report formatter", async () => {
		const api = new OpenaiApi("test-model");
		const { progress, parts } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		// Split the SSE event across two network chunks to exercise the
		// line-buffering logic in processStreamingResponse.
		const full = new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`);
		const mid = Math.floor(full.length / 2);
		await api.processStreamingResponse(sseStream([full.slice(0, mid), full.slice(mid)]), progress, token);

		// Step 1: captured usage — the exact object provider.ts passes to the status bar
		const usage = api.getUsage();
		assert.ok(usage, "usage was captured from the final chunk");
		assert.ok(usage!.timings, "timings survived into getUsage()");
		assert.strictEqual(usage!.timings!.prompt_ms, 275.416);
		assert.strictEqual(usage!.timings!.predicted_ms, 1707.33);

		// Step 2: the exact formatter the status bar tooltip uses
		const report = formatLlamaUsageReport(usage!);
		assert.ok(report, "llama.cpp report was generated");
		assert.ok(report!.includes("Cache: 23175/24313 (95.3%)"), report);
		assert.ok(report!.includes("Prefill: 1138 tok · 275.4 ms · 4131.9 t/s"), report);
		assert.ok(report!.includes("Decode: 285 tok · 1.71 s · 166.3 t/s"), report);
		assert.ok(report!.includes("Total: 1.98 s"), report);

		// Step 3: the Context Window data part serialization
		const usagePart = parts.find(
			(p) => p instanceof vscode.LanguageModelDataPart && p.mimeType === CustomDataPartMimeTypes.Usage
		) as vscode.LanguageModelDataPart | undefined;
		assert.ok(usagePart, "usage data part was reported");
		const decoded = JSON.parse(new TextDecoder().decode(usagePart!.data));
		assert.ok(decoded.timings, "timings survived serialization into the data part");
		assert.strictEqual(decoded.timings.prompt_ms, 275.416);
	});

	test("captures the completion id and fires onCompletionId exactly once", async () => {
		const api = new OpenaiApi("test-model");
		const { progress } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		const ids: string[] = [];
		api.onCompletionId = (id) => {
			ids.push(id);
		};

		const full = new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`);
		await api.processStreamingResponse(sseStream([full]), progress, token);

		assert.strictEqual(api.getCompletionId(), "chatcmpl-6vKoe2eQMBCZcxpuavsi4oE8dSRY1oNQ");
		assert.deepStrictEqual(ids, ["chatcmpl-6vKoe2eQMBCZcxpuavsi4oE8dSRY1oNQ"]);
	});

	test("swallows errors thrown by the completion id callback", async () => {
		const api = new OpenaiApi("test-model");
		const { progress } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;
		api.onCompletionId = () => {
			throw new Error("boom");
		};

		const full = new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`);
		await api.processStreamingResponse(sseStream([full]), progress, token);

		assert.strictEqual(api.getCompletionId(), "chatcmpl-6vKoe2eQMBCZcxpuavsi4oE8dSRY1oNQ");
	});

	test("fires onReasoningEnd exactly once when the answer begins", async () => {
		const api = new OpenaiApi("test-model");
		const { progress } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		let fired = 0;
		api.onReasoningEnd = () => {
			fired++;
		};

		const chunks = [
			{ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "hmm" }, finish_reason: null }] },
			{ choices: [{ delta: { reasoning_content: "more" }, finish_reason: null }] },
			{ choices: [{ delta: { content: "answer" }, finish_reason: null }] },
			{ choices: [{ delta: { content: " text" }, finish_reason: "stop" }] },
		];
		const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
		await api.processStreamingResponse(sseStream([new TextEncoder().encode(sse)]), progress, token);

		assert.strictEqual(fired, 1, "onReasoningEnd fires exactly once, at the first answer chunk");
	});

	test("does not fire onReasoningEnd for thinking-only streams", async () => {
		const api = new OpenaiApi("test-model");
		const { progress } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		let fired = 0;
		api.onReasoningEnd = () => {
			fired++;
		};

		const chunks = [
			{ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "hmm" }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		];
		const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
		await api.processStreamingResponse(sseStream([new TextEncoder().encode(sse)]), progress, token);

		assert.strictEqual(fired, 0);
	});

	test("fires onReasoningEnd when tool calls begin", async () => {
		const api = new OpenaiApi("test-model");
		const { progress } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		let fired = 0;
		api.onReasoningEnd = () => {
			fired++;
		};

		const chunks = [
			{ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "hmm" }, finish_reason: null }] },
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] },
						finish_reason: null,
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		];
		const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
		await api.processStreamingResponse(sseStream([new TextEncoder().encode(sse)]), progress, token);

		assert.strictEqual(fired, 1);
	});
});

suite("openai streaming OpenRouter metadata pipeline", () => {
	/**
	 * OpenRouter delivers `openrouter_metadata` as a SIBLING of `usage` on the
	 * final streamed chunk (and only when the request opted in with
	 * `X-OpenRouter-Metadata: enabled`). This verifies it survives the same
	 * pipeline as llama.cpp's `timings`: SSE parse → usage capture →
	 * getUsage() → status bar report formatter.
	 */
	test("openrouter_metadata survives SSE parse → capture → getUsage → report", async () => {
		const api = new OpenaiApi("test-model");
		const { progress, parts } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		const chunks = [
			{ id: "gen-abc123", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
			{
				id: "gen-abc123",
				choices: [{ delta: { content: "" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10339,
					completion_tokens: 60,
					total_tokens: 10399,
					prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 45 },
				},
				openrouter_metadata: {
					requested: "anthropic/claude-sonnet-4",
					strategy: "direct",
					region: "iad",
					attempt: 1,
					is_byok: false,
					generation_time: 2016,
				},
			},
		];
		const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
		await api.processStreamingResponse(sseStream([new TextEncoder().encode(sse)]), progress, token);

		const usage = api.getUsage();
		assert.ok(usage, "usage was captured from the final chunk");
		assert.ok(usage!.openrouter, "openrouter_metadata survived into getUsage()");
		assert.strictEqual(usage!.openrouter!.generation_time, 2016);
		assert.strictEqual(usage!.openrouter!.strategy, "direct");

		// llama.cpp `timings` must NOT be synthesized for an OpenRouter request.
		assert.strictEqual(usage!.timings, undefined);

		const report = formatOpenRouterUsageReport(usage!);
		assert.ok(report, "OpenRouter report was generated");
		assert.ok(report!.includes("Cache: 10318/10339 (99.8%)"), report!);
		assert.ok(report!.includes("Throughput: 60 tok · 2.02 s · 29.8 t/s"), report!);
		assert.ok(report!.includes("Total: 2.02 s · iad · direct"), report!);

		// Context Window data part serialization keeps the metadata.
		const usagePart = parts.find(
			(p) => p instanceof vscode.LanguageModelDataPart && p.mimeType === CustomDataPartMimeTypes.Usage
		) as vscode.LanguageModelDataPart | undefined;
		assert.ok(usagePart, "usage data part was reported");
		const decoded = JSON.parse(new TextDecoder().decode(usagePart!.data));
		assert.strictEqual(decoded.openrouter.generation_time, 2016);
	});

	test("a response without openrouter_metadata leaves usage.openrouter undefined", async () => {
		const api = new OpenaiApi("test-model");
		const { progress } = createProgressStub();
		const token = { isCancellationRequested: false } as unknown as vscode.CancellationToken;

		const chunks = [
			{ id: "gen-1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
			{
				id: "gen-1",
				choices: [{ delta: { content: "" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			},
		];
		const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
		await api.processStreamingResponse(sseStream([new TextEncoder().encode(sse)]), progress, token);

		const usage = api.getUsage();
		assert.ok(usage);
		assert.strictEqual(usage!.openrouter, undefined);
		assert.strictEqual(formatOpenRouterUsageReport(usage!), undefined);
	});
});
