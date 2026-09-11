import * as assert from "assert";
import { ReasoningControlManager, sendReasoningControlRequest, type ReasoningControlTarget } from "../reasoningControl";

const TARGET: ReasoningControlTarget = {
	id: "chatcmpl-test",
	model: "my/model",
	baseUrl: "http://h:8080/v1/",
	headers: { Authorization: "Bearer key" },
	tgStartedAt: 1_700_000_000_000,
};

suite("reasoningControl HTTP client", () => {
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

	teardown(() => {
		globalThis.fetch = originalFetch;
	});

	test("sends POST to <baseUrl>/chat/completions/control with id, action, model", async () => {
		stubFetch(async () => json(200, { success: true }));
		const result = await sendReasoningControlRequest(TARGET);
		assert.strictEqual(result.success, true);
		assert.strictEqual(calls[0].url, "http://h:8080/v1/chat/completions/control");
		const init = calls[0].init as RequestInit;
		assert.strictEqual(init.method, "POST");
		assert.deepStrictEqual(JSON.parse(init.body as string), {
			id: "chatcmpl-test",
			action: "reasoning_end",
			model: "my/model",
		});
		assert.strictEqual((init.headers as Record<string, string>)["Authorization"], "Bearer key");
		assert.strictEqual((init.headers as Record<string, string>)["Content-Type"], "application/json");
	});

	test("rejects an invalid base URL before any request", async () => {
		stubFetch(async () => json(200, { success: true }));
		const result = await sendReasoningControlRequest({ ...TARGET, baseUrl: "not-a-url" });
		assert.strictEqual(result.success, false);
		assert.ok(result.message);
		assert.strictEqual(calls.length, 0);
	});

	test("reports success: true", async () => {
		stubFetch(async () => json(200, { success: true }));
		assert.deepStrictEqual(await sendReasoningControlRequest(TARGET), { success: true });
	});

	test("reports the server message when success is false", async () => {
		stubFetch(async () => json(200, { success: false, message: "no active reasoning" }));
		const result = await sendReasoningControlRequest(TARGET);
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.message, "no active reasoning");
	});

	test("reports non-2xx responses with the status and body", async () => {
		stubFetch(async () => json(500, { error: "boom" }));
		const result = await sendReasoningControlRequest(TARGET);
		assert.strictEqual(result.success, false);
		assert.ok(result.message!.includes("500"), result.message);
		assert.ok(result.message!.includes("boom"), result.message);
	});

	test("reports malformed JSON bodies", async () => {
		stubFetch(async () => new Response("not json", { status: 200 }));
		const result = await sendReasoningControlRequest(TARGET);
		assert.strictEqual(result.success, false);
		assert.ok(result.message!.includes("invalid JSON"), result.message);
	});

	test("reports network errors", async () => {
		stubFetch(async () => {
			throw new Error("ECONNREFUSED");
		});
		const result = await sendReasoningControlRequest(TARGET);
		assert.strictEqual(result.success, false);
		assert.ok(result.message!.includes("ECONNREFUSED"), result.message);
	});

	test("times out after the configured budget", async () => {
		globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const s = init?.signal;
				if (!s) {
					return;
				}
				s.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), {
					once: true,
				});
			});
		const result = await sendReasoningControlRequest(TARGET, 15);
		assert.strictEqual(result.success, false);
		assert.ok(result.message!.includes("timed out"), result.message);
	});
});

suite("ReasoningControlManager", () => {
	const target = (id: string): ReasoningControlTarget => ({
		id,
		model: "m",
		baseUrl: "http://h:8080/v1",
		headers: { Authorization: "Bearer key" },
		tgStartedAt: Date.now(),
	});

	test("activating a target makes it the latest target", () => {
		const manager = new ReasoningControlManager();
		manager.activate(target("c1"));
		assert.strictEqual(manager.getLatestTarget()?.id, "c1");
		manager.dispose();
	});

	test("rejects targets without an id, model, base URL, or TG start time", () => {
		const manager = new ReasoningControlManager();
		assert.throws(() => manager.activate({ ...target("c1"), id: "" }), /Invalid reasoning control target/);
		assert.throws(() => manager.activate({ ...target("c1"), model: "" }), /Invalid reasoning control target/);
		assert.throws(() => manager.activate({ ...target("c1"), baseUrl: "" }), /Invalid reasoning control target/);
		assert.throws(() => manager.activate({ ...target("c1"), tgStartedAt: NaN }), /Invalid reasoning control target/);
		manager.dispose();
	});

	test("deactivating the latest target falls back to the previous one", () => {
		const manager = new ReasoningControlManager();
		manager.activate(target("c1"));
		manager.activate(target("c2"));
		assert.strictEqual(manager.getLatestTarget()?.id, "c2");
		manager.deactivate("c2");
		assert.strictEqual(manager.getLatestTarget()?.id, "c1");
		manager.deactivate("c1");
		assert.strictEqual(manager.getLatestTarget(), undefined);
		manager.dispose();
	});

	test("deactivating an unknown id is a no-op", () => {
		const manager = new ReasoningControlManager();
		manager.activate(target("c1"));
		manager.deactivate("unknown");
		assert.strictEqual(manager.getLatestTarget()?.id, "c1");
		manager.dispose();
	});

	test("endLatestReasoning succeeds and deactivates the target", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
		try {
			const manager = new ReasoningControlManager();
			manager.activate(target("c1"));
			const result = await manager.endLatestReasoning();
			assert.strictEqual(result.success, true);
			assert.strictEqual(manager.getLatestTarget(), undefined);
			manager.dispose();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("endLatestReasoning keeps the target active on failure", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ success: false, message: "no active reasoning" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		try {
			const manager = new ReasoningControlManager();
			manager.activate(target("c1"));
			const result = await manager.endLatestReasoning();
			assert.strictEqual(result.success, false);
			assert.strictEqual(result.message, "no active reasoning");
			assert.strictEqual(manager.getLatestTarget()?.id, "c1");
			manager.dispose();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("endLatestReasoning reports when no completion is active", async () => {
		const manager = new ReasoningControlManager();
		const result = await manager.endLatestReasoning();
		assert.strictEqual(result.success, false);
		assert.ok(result.message);
		manager.dispose();
	});
});
