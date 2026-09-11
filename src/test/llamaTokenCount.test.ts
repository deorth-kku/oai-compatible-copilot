import * as assert from "assert";
import {
	buildInputTokensBody,
	buildInputTokensUrl,
	fetchInputTokens,
	parseInputTokensResponse,
} from "../llamaTokenCount";

suite("llamaTokenCount", () => {
	suite("buildInputTokensUrl", () => {
		test("appends the endpoint to a root base URL", () => {
			assert.strictEqual(
				buildInputTokensUrl("http://host:8080"),
				"http://host:8080/chat/completions/input_tokens"
			);
		});

		test("appends the endpoint to a /v1 base URL", () => {
			assert.strictEqual(
				buildInputTokensUrl("http://host:8080/v1"),
				"http://host:8080/v1/chat/completions/input_tokens"
			);
		});

		test("strips trailing slashes", () => {
			assert.strictEqual(
				buildInputTokensUrl("http://host:8080/v1/"),
				"http://host:8080/v1/chat/completions/input_tokens"
			);
			assert.strictEqual(
				buildInputTokensUrl("http://host:8080//"),
				"http://host:8080/chat/completions/input_tokens"
			);
		});

		test("keeps non-/v1 path prefixes", () => {
			assert.strictEqual(
				buildInputTokensUrl("http://host:8080/api"),
				"http://host:8080/api/chat/completions/input_tokens"
			);
		});
	});

	suite("buildInputTokensBody", () => {
		test("returns model and messages verbatim", () => {
			const messages = [{ role: "user" as const, content: "hi" }];
			assert.deepStrictEqual(buildInputTokensBody("my/model", messages), {
				model: "my/model",
				messages,
			});
		});
	});

	suite("parseInputTokensResponse", () => {
		test("accepts a well-formed payload", () => {
			assert.strictEqual(
				parseInputTokensResponse({ object: "response.input_tokens", input_tokens: 11 }),
				11
			);
		});

		test("accepts zero tokens", () => {
			assert.strictEqual(
				parseInputTokensResponse({ object: "response.input_tokens", input_tokens: 0 }),
				0
			);
		});

		test("rejects a missing object field", () => {
			assert.strictEqual(parseInputTokensResponse({ input_tokens: 11 }), undefined);
		});

		test("rejects a wrong object field", () => {
			assert.strictEqual(
				parseInputTokensResponse({ object: "chat.completion", input_tokens: 11 }),
				undefined
			);
		});

		test("rejects a non-numeric input_tokens", () => {
			assert.strictEqual(
				parseInputTokensResponse({ object: "response.input_tokens", input_tokens: "11" }),
				undefined
			);
			assert.strictEqual(
				parseInputTokensResponse({ object: "response.input_tokens", input_tokens: NaN }),
				undefined
			);
			assert.strictEqual(
				parseInputTokensResponse({ object: "response.input_tokens", input_tokens: Infinity }),
				undefined
			);
		});

		test("rejects a negative input_tokens", () => {
			assert.strictEqual(
				parseInputTokensResponse({ object: "response.input_tokens", input_tokens: -1 }),
				undefined
			);
		});

		test("rejects non-object payloads", () => {
			assert.strictEqual(parseInputTokensResponse(null), undefined);
			assert.strictEqual(parseInputTokensResponse("11"), undefined);
			assert.strictEqual(parseInputTokensResponse(11), undefined);
		});
	});

	suite("fetchInputTokens", () => {
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
		const signal = new AbortController().signal;
		const body = { model: "my/model", messages: [{ role: "user" as const, content: "hi" }] };

		teardown(() => {
			globalThis.fetch = originalFetch;
		});

		test("returns the server-computed input_tokens", async () => {
			stubFetch(async () => json(200, { object: "response.input_tokens", input_tokens: 11 }));
			const result = await fetchInputTokens("http://h:8080/chat/completions/input_tokens", body, headers, signal);
			assert.strictEqual(result, 11);
			assert.strictEqual(calls[0].init?.method, "POST");
			assert.strictEqual(calls[0].init?.signal, signal);
			assert.strictEqual(
				(calls[0].init?.headers as Record<string, string>)["Content-Type"],
				"application/json"
			);
			assert.deepStrictEqual(JSON.parse(calls[0].init?.body as string), body);
			assert.strictEqual((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer key");
		});

		test("returns undefined on a non-200 response (e.g. 404 on older llama.cpp)", async () => {
			stubFetch(async () => new Response("Not Found", { status: 404 }));
			assert.strictEqual(
				await fetchInputTokens("http://h:8080/chat/completions/input_tokens", body, headers, signal),
				undefined
			);
		});

		test("returns undefined on a malformed payload", async () => {
			stubFetch(async () => json(200, { object: "chat.completion", choices: [] }));
			assert.strictEqual(
				await fetchInputTokens("http://h:8080/chat/completions/input_tokens", body, headers, signal),
				undefined
			);
		});

		test("returns undefined on a network error", async () => {
			stubFetch(async () => {
				throw new Error("ECONNREFUSED");
			});
			assert.strictEqual(
				await fetchInputTokens("http://h:8080/chat/completions/input_tokens", body, headers, signal),
				undefined
			);
		});

		test("propagates the abort when the caller's signal aborts", async () => {
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
			const pending = fetchInputTokens(
				"http://h:8080/chat/completions/input_tokens",
				body,
				headers,
				controller.signal
			);
			controller.abort();
			await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === "AbortError");
		});
	});
});
