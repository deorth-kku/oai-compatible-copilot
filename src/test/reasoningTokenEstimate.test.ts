import * as assert from "assert";
import * as vscode from "vscode";
import { tokenizerManager } from "../tokenizer/tokenizerManager";
import { OpenaiApi } from "../openai/openaiApi";
import { formatOpenRouterUsageReport } from "../openrouterSpeed";
import { formatLlamaUsageReport } from "../llamaSpeed";

/**
 * Some gateways (observed on OpenRouter) stream a reasoning trace but leave
 * `completion_tokens_details.reasoning_tokens` at 0, because the upstream
 * provider never populates the field. The extension then counts the streamed
 * reasoning text itself, so the status bar does not claim "Reasoning: 0" for
 * a response that clearly reasoned.
 *
 * The tokenizer is stubbed here: the real one needs the extension asset path
 * and is exercised through the Context Window widget in normal use.
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
	return { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart2>;
}

const token = () => ({ isCancellationRequested: false }) as unknown as vscode.CancellationToken;

function encode(chunks: unknown[]): ReadableStream<Uint8Array> {
	return sseStream([new TextEncoder().encode(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""))]);
}

/** Build a stream that reasons, answers, and reports a usage chunk. */
function reasoningStream(opts: {
	reasoning: string;
	content: string;
	reasoningTokens: number | undefined;
}): ReadableStream<Uint8Array> {
	const completionDetails: Record<string, unknown> = { image_tokens: 0, audio_tokens: 0 };
	if (opts.reasoningTokens !== undefined) {
		completionDetails.reasoning_tokens = opts.reasoningTokens;
	}
	return encode([
		{ id: "gen-1", choices: [{ delta: { reasoning: opts.reasoning }, finish_reason: null }] },
		{ id: "gen-1", choices: [{ delta: { content: opts.content }, finish_reason: null }] },
		{
			id: "gen-1",
			choices: [{ delta: { content: "" }, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 100,
				completion_tokens: 99,
				total_tokens: 199,
				completion_tokens_details: completionDetails,
			},
		},
	]);
}

suite("local reasoning token estimate", () => {
	const original = tokenizerManager.countTokens.bind(tokenizerManager);

	function stub(fn: (text: string) => number | Promise<number>): void {
		(tokenizerManager as unknown as { countTokens: (t: string) => Promise<number> }).countTokens = async (t: string) =>
			fn(t);
	}

	teardown(() => {
		(tokenizerManager as unknown as { countTokens: (t: string) => Promise<number> }).countTokens = original;
	});

	test("fills in a local estimate when the backend reports 0", async () => {
		// 4 tokens per character keeps the arithmetic in the assertions obvious.
		stub((t) => t.length * 4);
		const api = new OpenaiApi("test-model");
		await api.processStreamingResponse(
			reasoningStream({ reasoning: "abcd", content: "hi", reasoningTokens: 0 }),
			createProgressStub(),
			token()
		);

		const usage = api.getUsage()!;
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 16);
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens_estimated, true);

		// The report must label the value as an estimate, not pass it off as
		// server-reported.
		const report = formatOpenRouterUsageReport({ ...usage, openrouter: { generation_time: 1000 } })!;
		assert.ok(report.includes("Reasoning: ~16 (local)"), report);
		// Visible is derived by subtracting the estimate from completion_tokens.
		assert.ok(report.includes("Visible: 83"), report);
	});

	test("fills in a local estimate when the field is absent entirely", async () => {
		stub((t) => t.length * 4);
		const api = new OpenaiApi("test-model");
		await api.processStreamingResponse(
			reasoningStream({ reasoning: "abcd", content: "hi", reasoningTokens: undefined }),
			createProgressStub(),
			token()
		);

		const usage = api.getUsage()!;
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 16);
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens_estimated, true);
	});

	test("a non-zero server count is never overridden", async () => {
		stub(() => {
			throw new Error("tokenizer must not be consulted when the server reported a count");
		});
		const api = new OpenaiApi("test-model");
		await api.processStreamingResponse(
			reasoningStream({ reasoning: "abcd", content: "hi", reasoningTokens: 42 }),
			createProgressStub(),
			token()
		);

		const usage = api.getUsage()!;
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 42);
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens_estimated, undefined);
	});

	test("no streamed reasoning leaves the reported 0 untouched", async () => {
		stub(() => {
			throw new Error("tokenizer must not be consulted without a reasoning trace");
		});
		const api = new OpenaiApi("test-model");
		await api.processStreamingResponse(
			encode([
				{ id: "gen-1", choices: [{ delta: { content: "hi" }, finish_reason: null }] },
				{
					id: "gen-1",
					choices: [{ delta: { content: "" }, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 99,
						total_tokens: 199,
						completion_tokens_details: { reasoning_tokens: 0 },
					},
				},
			]),
			createProgressStub(),
			token()
		);

		const usage = api.getUsage()!;
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 0);
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens_estimated, undefined);
	});

	test("a tokenizer failure leaves the server's 0 in place", async () => {
		stub(() => {
			throw new Error("no extension asset path");
		});
		const api = new OpenaiApi("test-model");
		await api.processStreamingResponse(
			reasoningStream({ reasoning: "abcd", content: "hi", reasoningTokens: 0 }),
			createProgressStub(),
			token()
		);

		const usage = api.getUsage()!;
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 0);
		assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens_estimated, undefined);
	});

	test("the llama.cpp report labels the estimate too", async () => {
		stub((t) => t.length * 4);
		const api = new OpenaiApi("test-model");
		await api.processStreamingResponse(
			reasoningStream({ reasoning: "abcd", content: "hi", reasoningTokens: 0 }),
			createProgressStub(),
			token()
		);

		const report = formatLlamaUsageReport({
			...api.getUsage()!,
			timings: { prompt_ms: 100, predicted_ms: 1000 },
		})!;
		assert.ok(report.includes("Reasoning: ~16 (local)"), report);
	});
});
