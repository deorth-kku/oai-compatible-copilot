import * as assert from "assert";
import {
	computeSlotCacheId,
	extractSystemText,
	fetchIdleSlot,
	findIdleSlot,
	getServerRootUrl,
	restoreSlotCache,
	saveSlotCache,
	type LlamaSlot,
	type SlotCacheIdParts,
} from "../llamaSlotCache";

suite("llamaSlotCache", () => {
	suite("getServerRootUrl", () => {
		test("strips /v1 suffix", () => {
			assert.strictEqual(getServerRootUrl("http://test.com/v1"), "http://test.com");
		});

		test("strips /v1 suffix with trailing slash", () => {
			assert.strictEqual(getServerRootUrl("http://test.com/v1/"), "http://test.com");
		});

		test("keeps base URL without /v1", () => {
			assert.strictEqual(getServerRootUrl("http://test.com"), "http://test.com");
		});

		test("strips trailing slash without /v1", () => {
			assert.strictEqual(getServerRootUrl("http://test.com/"), "http://test.com");
		});

		test("keeps non-/v1 path prefixes", () => {
			assert.strictEqual(getServerRootUrl("http://test.com/api"), "http://test.com/api");
		});

		test("handles host with port", () => {
			assert.strictEqual(getServerRootUrl("http://localhost:8080/v1"), "http://localhost:8080");
		});
	});

	suite("computeSlotCacheId", () => {
		const base: SlotCacheIdParts = {
			model: "gpt-oss-120b",
			reasoning: "medium",
			system: "You are a helpful assistant.",
			tools: [{ type: "function", function: { name: "read_file" } }],
			toolChoice: "auto",
		};

		test("is deterministic", () => {
			assert.strictEqual(computeSlotCacheId(base), computeSlotCacheId(base));
		});

		test("produces a hex-only filesystem-safe id", () => {
			assert.match(computeSlotCacheId(base), /^[0-9a-f]{64}$/);
		});

		test("changes when model changes", () => {
			assert.notStrictEqual(
				computeSlotCacheId({ ...base, model: "gpt-oss-20b" }),
				computeSlotCacheId(base)
			);
		});

		test("changes when reasoning effort changes", () => {
			assert.notStrictEqual(
				computeSlotCacheId({ ...base, reasoning: "high" }),
				computeSlotCacheId(base)
			);
		});

		test("changes when system prompt changes", () => {
			assert.notStrictEqual(
				computeSlotCacheId({ ...base, system: "You are a helpful assistant. (extra)" }),
				computeSlotCacheId(base)
			);
		});

		test("changes when tools change", () => {
			assert.notStrictEqual(
				computeSlotCacheId({ ...base, tools: [{ type: "function", function: { name: "write_file" } }] }),
				computeSlotCacheId(base)
			);
		});

		test("changes when tool_choice changes", () => {
			assert.notStrictEqual(
				computeSlotCacheId({ ...base, toolChoice: { type: "function", function: { name: "read_file" } } }),
				computeSlotCacheId(base)
			);
		});

		test("treats absent tools/tool_choice as []/auto", () => {
			assert.strictEqual(
				computeSlotCacheId({ model: base.model, reasoning: base.reasoning, system: base.system }),
				computeSlotCacheId({ ...base, tools: [], toolChoice: "auto" })
			);
		});
	});

	suite("extractSystemText", () => {
		test("returns the first system message text", () => {
			const messages = [
				{ role: "system", content: "sys prompt" },
				{ role: "user", content: "hello" },
			];
			assert.strictEqual(extractSystemText(messages), "sys prompt");
		});

		test("returns empty string when no system message", () => {
			assert.strictEqual(extractSystemText([{ role: "user", content: "hello" }]), "");
		});

		test("returns empty string for non-string system content", () => {
			const messages = [{ role: "system", content: [{ type: "text", text: "x" }] }];
			assert.strictEqual(extractSystemText(messages), "");
		});
	});

	suite("findIdleSlot", () => {
		const slot = (id: number, isProcessing: boolean): LlamaSlot => ({ id, is_processing: isProcessing });

		test("returns the first idle slot id", () => {
			const slots = [slot(0, true), slot(1, false), slot(2, false)];
			assert.strictEqual(findIdleSlot(slots), 1);
		});

		test("returns undefined for an empty list", () => {
			assert.strictEqual(findIdleSlot([]), undefined);
		});

		test("returns undefined when all slots are busy", () => {
			assert.strictEqual(findIdleSlot([slot(0, true), slot(1, true)]), undefined);
		});

		test("skips malformed entries", () => {
			const slots: LlamaSlot[] = [{ id: "x" as unknown as number, is_processing: false }, slot(3, false)];
			assert.strictEqual(findIdleSlot(slots), 3);
		});

		test("prefers a never-used slot (no n_prompt_tokens) over a used one", () => {
			const slots = [
				{ id: 0, is_processing: false, n_prompt_tokens: 100 },
				{ id: 1, is_processing: false },
			];
			assert.strictEqual(findIdleSlot(slots), 1);
		});

		test("never-used wins even over a used slot with 0 tokens", () => {
			const slots = [
				{ id: 0, is_processing: false, n_prompt_tokens: 0 },
				{ id: 1, is_processing: false },
			];
			assert.strictEqual(findIdleSlot(slots), 1);
		});

		test("picks the smallest n_prompt_tokens when all slots are used", () => {
			const slots = [
				{ id: 0, is_processing: false, n_prompt_tokens: 500 },
				{ id: 1, is_processing: false, n_prompt_tokens: 50 },
				{ id: 2, is_processing: false, n_prompt_tokens: 200 },
			];
			assert.strictEqual(findIdleSlot(slots), 1);
		});

		test("ties on the minimum n_prompt_tokens keep the first slot", () => {
			const slots = [
				{ id: 0, is_processing: false, n_prompt_tokens: 10 },
				{ id: 1, is_processing: false, n_prompt_tokens: 10 },
			];
			assert.strictEqual(findIdleSlot(slots), 0);
		});

		test("multiple never-used slots keep the first one", () => {
			const slots = [
				{ id: 0, is_processing: false },
				{ id: 1, is_processing: false },
			];
			assert.strictEqual(findIdleSlot(slots), 0);
		});

		test("busy slots are ignored even if never used", () => {
			const slots = [
				{ id: 0, is_processing: true },
				{ id: 1, is_processing: false, n_prompt_tokens: 999 },
			];
			assert.strictEqual(findIdleSlot(slots), 1);
		});
	});

	suite("slots HTTP calls", () => {
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

		const headers = { Authorization: "Bearer key" };

		teardown(() => {
			globalThis.fetch = originalFetch;
		});

		test("fetchIdleSlot sends the model query param", async () => {
			stubFetch(async () => json(200, [{ id: 0, is_processing: false }]));
			const idle = await fetchIdleSlot("http://h:8080", "my/model", headers);
			assert.strictEqual(idle, 0);
			assert.strictEqual(calls[0].url, "http://h:8080/slots?model=my%2Fmodel");
		});

		test("restore sends filename and model in the JSON body (no query model)", async () => {
			stubFetch(async () => json(200, { n_restored: 42 }));
			const ok = await restoreSlotCache("http://h:8080", "my/model", 3, "abc.bin", headers);
			assert.strictEqual(ok, true);
			assert.strictEqual(calls[0].url, "http://h:8080/slots/3?action=restore");
			const init = calls[0].init as RequestInit;
			assert.strictEqual(init.method, "POST");
			assert.deepStrictEqual(JSON.parse(init.body as string), { filename: "abc.bin", model: "my/model" });
			assert.strictEqual((init.headers as Record<string, string>)["Content-Type"], "application/json");
			assert.strictEqual((init.headers as Record<string, string>).Authorization, "Bearer key");
		});

		test("restore fails when n_restored is 0", async () => {
			stubFetch(async () => json(200, { n_restored: 0 }));
			assert.strictEqual(await restoreSlotCache("http://h:8080", "m", 1, "a.bin", headers), false);
		});

		test("restore fails on a non-200 response", async () => {
			stubFetch(async () => json(500, { error: "boom" }));
			assert.strictEqual(await restoreSlotCache("http://h:8080", "m", 1, "a.bin", headers), false);
		});

		test("restore fails on a network error", async () => {
			stubFetch(async () => {
				throw new Error("ECONNREFUSED");
			});
			assert.strictEqual(await restoreSlotCache("http://h:8080", "m", 1, "a.bin", headers), false);
		});

		test("save sends filename and model in the JSON body (no query model)", async () => {
			stubFetch(async () => json(200, { n_saved: 7 }));
			const ok = await saveSlotCache("http://h:8080", "my/model", 3, "abc.bin", headers);
			assert.strictEqual(ok, true);
			assert.strictEqual(calls[0].url, "http://h:8080/slots/3?action=save");
			const init = calls[0].init as RequestInit;
			assert.strictEqual(init.method, "POST");
			assert.deepStrictEqual(JSON.parse(init.body as string), { filename: "abc.bin", model: "my/model" });
			assert.strictEqual((init.headers as Record<string, string>)["Content-Type"], "application/json");
		});

		test("save fails when n_saved is 0", async () => {
			stubFetch(async () => json(200, { n_saved: 0 }));
			assert.strictEqual(await saveSlotCache("http://h:8080", "m", 1, "a.bin", headers), false);
		});

		test("save fails on a non-200 response", async () => {
			stubFetch(async () => json(500, { error: "boom" }));
			assert.strictEqual(await saveSlotCache("http://h:8080", "m", 1, "a.bin", headers), false);
		});
	});
});
