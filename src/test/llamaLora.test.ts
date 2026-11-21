import * as assert from "assert";
import {
	buildLoraRequestField,
	fetchLoraAdapters,
	loraFastTwinId,
	offersLlamaLoraFast,
	type LlamaLoraAdapter,
} from "../llamaLora";

suite("llamaLora", () => {
	suite("loraFastTwinId", () => {
		test("appends the -fast suffix to a plain entry id", () => {
			assert.strictEqual(loraFastTwinId("my-model"), "my-model-fast");
		});

		test("appends the -fast suffix after any ::configId", () => {
			assert.strictEqual(loraFastTwinId("my-model::cfg"), "my-model::cfg-fast");
		});
	});

	suite("offersLlamaLoraFast", () => {
		test("true for a llama.cpp model with a numeric adapter id (default api mode)", () => {
			assert.strictEqual(offersLlamaLoraFast({ optimization: "llama.cpp", llama_lora_fast: { id: 0 } }), true);
			assert.strictEqual(
				offersLlamaLoraFast({ optimization: "llama.cpp", apiMode: "openai", llama_lora_fast: { id: 2 } }),
				true
			);
		});

		test("false without llama_lora_fast or without a numeric id", () => {
			assert.strictEqual(offersLlamaLoraFast({ optimization: "llama.cpp" }), false);
			assert.strictEqual(offersLlamaLoraFast({ optimization: "llama.cpp", llama_lora_fast: { id: 1.5 } }), false);
		});

		test("false for other optimizations or non-OpenAI api modes", () => {
			assert.strictEqual(offersLlamaLoraFast({ optimization: "openrouter", llama_lora_fast: { id: 0 } }), false);
			assert.strictEqual(
				offersLlamaLoraFast({ optimization: "llama.cpp", apiMode: "openai-responses", llama_lora_fast: { id: 0 } }),
				false
			);
			assert.strictEqual(
				offersLlamaLoraFast({ optimization: "llama.cpp", apiMode: "ollama", llama_lora_fast: { id: 0 } }),
				false
			);
		});
	});

	suite("buildLoraRequestField", () => {
		test("undefined config -> undefined", () => {
			assert.strictEqual(buildLoraRequestField(undefined), undefined);
		});

		test("non-integer id -> undefined", () => {
			assert.strictEqual(buildLoraRequestField({ id: 1.5 }), undefined);
			assert.strictEqual(buildLoraRequestField({ id: NaN }), undefined);
		});

		test("id only", () => {
			assert.deepStrictEqual(buildLoraRequestField({ id: 2 }), [{ id: 2 }]);
		});

		test("id + scale", () => {
			assert.deepStrictEqual(buildLoraRequestField({ id: 0, scale: 0.5 }), [{ id: 0, scale: 0.5 }]);
		});

		test("non-finite scale is dropped", () => {
			assert.deepStrictEqual(buildLoraRequestField({ id: 1, scale: NaN }), [{ id: 1 }]);
		});
	});

	suite("fetchLoraAdapters", () => {
		const originalFetch = globalThis.fetch;
		const calls: { url: string; init?: RequestInit }[] = [];

		const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
			calls.length = 0;
			globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				calls.push({ url, init });
				return impl(url, init);
			};
		};

		const json = (status: number, body: unknown): Response =>
			new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

		const headers = { Authorization: "Bearer test-key" };
		// A caller-owned deadline that never fires during the tests.
		const signal = new AbortController().signal;

		teardown(() => {
			globalThis.fetch = originalFetch;
		});

		test("sends the model query param and returns the adapter array", async () => {
			const adapters: LlamaLoraAdapter[] = [
				{ id: 0, path: "adapter_a.gguf", scale: 0.0, task_name: "", prompt_prefix: "" },
				{ id: 1, path: "adapter_b.gguf", scale: 1.0, task_name: "task", prompt_prefix: "prefix" },
			];
			stubFetch(async () => json(200, adapters));
			const result = await fetchLoraAdapters("http://h:8080", "my/model", headers, signal);
			assert.deepStrictEqual(result, adapters);
			assert.strictEqual(calls[0].url, "http://h:8080/lora-adapters?model=my%2Fmodel");
		});

		test("forwards the caller's signal to fetch", async () => {
			stubFetch(async () => json(200, []));
			await fetchLoraAdapters("http://h:8080", "m", headers, signal);
			assert.strictEqual((calls[0].init as RequestInit).signal, signal);
		});

		test("filters out entries without a numeric id", async () => {
			stubFetch(async () => json(200, [{ id: 0, path: "a.gguf" }, { path: "no-id.gguf" }, null]));
			const result = await fetchLoraAdapters("http://h:8080", "m", headers, signal);
			assert.deepStrictEqual(result, [{ id: 0, path: "a.gguf" }]);
		});

		test("returns undefined on a non-array body", async () => {
			stubFetch(async () => json(200, { adapters: [] }));
			assert.strictEqual(await fetchLoraAdapters("http://h:8080", "m", headers, signal), undefined);
		});

		test("returns undefined on a non-200 response (e.g. 400 missing model in router mode)", async () => {
			stubFetch(async () => json(400, { error: "model name is missing from the request" }));
			assert.strictEqual(await fetchLoraAdapters("http://h:8080", "m", headers, signal), undefined);
		});

		test("returns undefined on a network error", async () => {
			stubFetch(async () => {
				throw new Error("ECONNREFUSED");
			});
			assert.strictEqual(await fetchLoraAdapters("http://h:8080", "m", headers, signal), undefined);
		});

		test("returns undefined when the caller's signal aborts", async () => {
			// A server that hangs until the caller's signal aborts.
			globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const s = init?.signal;
					if (!s) {
						return; // hang forever
					}
					if (s.aborted) {
						reject(new DOMException("The operation was aborted.", "AbortError"));
						return;
					}
					s.addEventListener(
						"abort",
						() => reject(new DOMException("The operation was aborted.", "AbortError")),
						{ once: true }
					);
				});
			const controller = new AbortController();
			const pending = fetchLoraAdapters("http://h:8080", "m", headers, controller.signal);
			controller.abort();
			assert.strictEqual(await pending, undefined);
		});
	});
});
