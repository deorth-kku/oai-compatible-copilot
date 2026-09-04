import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiApi } from "../openai/openaiApi";
import { formatLlamaUsageReport } from "../llamaSpeed";
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
});
