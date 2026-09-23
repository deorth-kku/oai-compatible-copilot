import * as assert from "assert";
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { CommonApi } from "../commonApi";
import type { HFModelItem } from "../types";

suite("reasoningCache migration", () => {
	// Clear the static memento and in-memory cache between tests so state
	// doesn't leak. `teardown` is the tdd-ui equivalent of `afterEach` (the
	// suite runs under mocha's tdd interface, where `afterEach` is not defined).
	teardown(() => {
		(CommonApi as unknown as { _memento: vscode.Memento | null })._memento = null;
		(CommonApi as unknown as { _reasoningByTurn: Map<string, string> })._reasoningByTurn.clear();
	});

	/**
	 * Build a Memento whose `get` returns `initial` and whose `update` records
	 * the last persisted record into `persisted` for assertions.
	 */
	function recordingMemento(initial: Record<string, string>): {
		memento: vscode.Memento;
		persisted: Record<string, string>;
	} {
		const persisted: Record<string, string> = {};
		const memento = {
			get: (_key: string) => initial,
			update: async (key: string, value: unknown) => {
				if (key === "oaicopilot.reasoningCache" && value && typeof value === "object") {
					Object.assign(persisted, value as Record<string, string>);
				}
			},
		} as unknown as vscode.Memento;
		return { memento, persisted };
	}

	test("drops old positional keys (convId#index and convId#modelId#index) on hydrate", async () => {
		const initial: Record<string, string> = {
			"abc123#4": "old positional key",
			"abc123#deepseek-chat#4": "old model-scoped positional key",
			// model id itself containing '#' -> convId#model#id#index (4 parts)
			"def456#my#weird#model#2": "old key with hash in model id",
			// New-format content-hash key must survive.
			"abc123#k7x2q9": "content-hash key",
		};
		const { memento, persisted } = recordingMemento(initial);
		CommonApi.setMemento(memento);

		CommonApi.hydrate();
		await CommonApi.flushNow();

		assert.strictEqual(persisted["abc123#k7x2q9"], "content-hash key");
		// No positional (numeric-tailed) keys should survive.
		assert.strictEqual(persisted["abc123#4"], undefined);
		assert.strictEqual(persisted["abc123#deepseek-chat#4"], undefined);
		assert.strictEqual(persisted["def456#my#weird#model#2"], undefined);
	});

	test("leaves content-hash keys untouched", async () => {
		const initial: Record<string, string> = {
			"abc123#k7x2q9": "reasoning for a turn",
			"ghi789#z0m4v2": "another turn",
		};
		const { memento, persisted } = recordingMemento(initial);
		CommonApi.setMemento(memento);

		CommonApi.hydrate();
		await CommonApi.flushNow();

		assert.strictEqual(persisted["abc123#k7x2q9"], "reasoning for a turn");
		assert.strictEqual(persisted["ghi789#z0m4v2"], "another turn");
	});
});

suite("reasoningCache content hash", () => {
	teardown(() => {
		(CommonApi as unknown as { _memento: vscode.Memento | null })._memento = null;
		(CommonApi as unknown as { _reasoningByTurn: Map<string, string> })._reasoningByTurn.clear();
	});

	// The shipped @types/vscode enum only defines User/Assistant; the runtime
	// System role is 3 (mapRole treats anything not User/Assistant as system).
	const SYSTEM_ROLE = 3 as unknown as vscode.LanguageModelChatMessageRole;
	const sys = (value: string): vscode.LanguageModelChatRequestMessage => ({
		role: SYSTEM_ROLE,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(value)],
	});
	const text = (value: string): vscode.LanguageModelTextPart => new vscode.LanguageModelTextPart(value);
	const tool = (
		name: string,
		input: Record<string, unknown>
	): vscode.LanguageModelToolCallPart => new vscode.LanguageModelToolCallPart("call_1", name, input);
	const thinking = (value: string): vscode.LanguageModelThinkingPart => new vscode.LanguageModelThinkingPart(value);

	/**
	 * Minimal concrete subclass exposing the protected capture API so the
	 * write/read flow can be exercised without a real stream.
	 */
	class CapturingApi extends CommonApi<unknown, unknown> {
		setConv(messages: readonly LanguageModelChatRequestMessage[]): void {
			this.setConvIdFromMessages(messages);
		}

		begin(): void {
			this.beginReasoningCapture();
		}

		addReasoning(text: string): void {
			this.cacheReasoning(text);
		}

		addParts(parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>): void {
			this._turnAssistantParts.push(...parts);
		}

		end(): void {
			this.endTurnCapture();
		}

		getCached(turnKey: string): string | undefined {
			return this.getCachedReasoning(turnKey);
		}

		convertMessages(
			_messages: readonly LanguageModelChatRequestMessage[],
			_modelConfig: { includeReasoningInRequest: boolean }
		): unknown[] {
			return [];
		}

		prepareRequestBody(
			rb: unknown,
			_um: HFModelItem | undefined,
			_options?: ProvideLanguageModelChatResponseOptions
		): unknown {
			return rb;
		}

		async processStreamingResponse(
			_responseBody: ReadableStream<Uint8Array>,
			_progress: Progress<LanguageModelResponsePart2>,
			_token: CancellationToken
		): Promise<void> {
			return;
		}

		createMessage(
			_model: HFModelItem,
			_systemPrompt: string,
			_messages: { role: string; content: string }[],
			_baseUrl: string,
			_apiKey: string
		): AsyncGenerator<{ type: "text"; text: string }> {
			throw new Error("not implemented");
		}
	}

	test("same parts → same hash", () => {
		const parts = [text("hello"), tool("read_file", { path: "a.ts" })];
		const a = CommonApi.computeTurnHashFromParts(parts);
		const b = CommonApi.computeTurnHashFromParts([...parts]);
		assert.ok(a);
		assert.strictEqual(a, b);
	});

	test("tool call argument key order does not change the hash", () => {
		const a = CommonApi.computeTurnHashFromParts([tool("read_file", { path: "a.ts", startLine: 1 })]);
		const b = CommonApi.computeTurnHashFromParts([tool("read_file", { startLine: 1, path: "a.ts" })]);
		assert.strictEqual(a, b);
	});

	test("thinking parts are excluded from the hash", () => {
		const a = CommonApi.computeTurnHashFromParts([thinking("deep thoughts"), text("hello")]);
		const b = CommonApi.computeTurnHashFromParts([text("hello")]);
		assert.strictEqual(a, b);
	});

	test("different text → different hash", () => {
		const a = CommonApi.computeTurnHashFromParts([text("hello")]);
		const b = CommonApi.computeTurnHashFromParts([text("world")]);
		assert.notStrictEqual(a, b);
	});

	test("text/tool-call order changes the hash", () => {
		const a = CommonApi.computeTurnHashFromParts([text("hello"), tool("t", {})]);
		const b = CommonApi.computeTurnHashFromParts([tool("t", {}), text("hello")]);
		assert.notStrictEqual(a, b);
	});

	test("consecutive text parts are merged (splitting does not change the hash)", () => {
		const a = CommonApi.computeTurnHashFromParts([text("hel"), text("lo")]);
		const b = CommonApi.computeTurnHashFromParts([text("hello")]);
		assert.strictEqual(a, b);
	});

	test("surrounding whitespace does not change the hash", () => {
		const a = CommonApi.computeTurnHashFromParts([text("  hello  ")]);
		const b = CommonApi.computeTurnHashFromParts([text("hello")]);
		assert.strictEqual(a, b);
	});

	test("whitespace-only / empty content → null (no hash)", () => {
		assert.strictEqual(CommonApi.computeTurnHashFromParts([]), null);
		assert.strictEqual(CommonApi.computeTurnHashFromParts([text("   ")]), null);
		assert.strictEqual(CommonApi.computeTurnHashFromParts([thinking("only thinking")]), null);
	});

	test("write at end of turn, read back by content hash", () => {
		const api = new CapturingApi("test-model");
		api.setConv([sys("You are helpful.\n- VSCODE_TARGET_SESSION_LOG: /x/aaaa-1111")]);
		const parts = [text("Let me check the file."), tool("read_file", { path: "a.ts" })];
		api.begin();
		api.addReasoning("deep reasoning trace");
		api.addParts(parts);
		api.end();

		const key = CommonApi.computeTurnHashFromParts(parts);
		assert.ok(key);
		assert.strictEqual(api.getCached(key), "deep reasoning trace");
	});

	test("surviving turn still matches after history compression", () => {
		const api = new CapturingApi("test-model");
		api.setConv([sys("You are helpful.\n- VSCODE_TARGET_SESSION_LOG: /x/aaaa-1111")]);
		const turn2Parts = [text("I will edit the file."), tool("write_file", { path: "a.ts", content: "x" })];
		api.begin();
		api.addReasoning("reasoning for turn 2");
		api.addParts(turn2Parts);
		api.end();

		// Full history: turn 2's content hashes to the cached key.
		const fullKey = CommonApi.computeTurnHashFromParts(turn2Parts);
		assert.ok(fullKey);
		assert.strictEqual(api.getCached(fullKey), "reasoning for turn 2");

		// Compressed history: earlier turns are summarized away, so turn 2 now
		// sits at an earlier index — the content hash is unaffected.
		const compressedKey = CommonApi.computeTurnHashFromParts(turn2Parts);
		assert.strictEqual(compressedKey, fullKey);
		assert.strictEqual(api.getCached(compressedKey), "reasoning for turn 2");

		// A different turn occupying that (compressed) index must NOT pick up
		// this turn's reasoning — no positional misattribution.
		const otherKey = CommonApi.computeTurnHashFromParts([text("a different answer")]);
		assert.notStrictEqual(otherKey, fullKey);
		assert.strictEqual(api.getCached(otherKey!), undefined);
	});

	test("identical turns: later write wins", () => {
		const api = new CapturingApi("test-model");
		api.setConv([sys("You are helpful.\n- VSCODE_TARGET_SESSION_LOG: /x/aaaa-1111")]);
		const parts = [text("same answer")];
		api.begin();
		api.addReasoning("first reasoning");
		api.addParts([...parts]);
		api.end();
		api.begin();
		api.addReasoning("second reasoning");
		api.addParts([...parts]);
		api.end();

		const key = CommonApi.computeTurnHashFromParts(parts);
		assert.ok(key);
		assert.strictEqual(api.getCached(key), "second reasoning");
	});

	test("pure-thinking turn (no text/tool calls) is not cached", () => {
		const api = new CapturingApi("test-model");
		api.setConv([sys("You are helpful.\n- VSCODE_TARGET_SESSION_LOG: /x/aaaa-1111")]);
		api.begin();
		api.addReasoning("only thinking, no content");
		api.end();

		const map = (CommonApi as unknown as { _reasoningByTurn: Map<string, string> })._reasoningByTurn;
		assert.strictEqual(map.size, 0);
	});
});
