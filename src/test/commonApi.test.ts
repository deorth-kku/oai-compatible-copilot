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

/**
 * Minimal concrete subclass of CommonApi that exposes the protected `_convId`
 * so `computeConvId` can be exercised directly. All API-specific methods are
 * no-ops.
 */
class TestApi extends CommonApi<unknown, unknown> {
	get convId(): string {
		return this._convId;
	}

	convertMessages(
		_messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean },
		_startIndex?: number
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

suite("CommonApi.computeConvId", () => {
	// The shipped @types/vscode enum only defines User/Assistant; the runtime
	// System role is 3 (mapRole treats anything not User/Assistant as system).
	const SYSTEM_ROLE = 3 as unknown as vscode.LanguageModelChatMessageRole;
	const sys = (value: string): vscode.LanguageModelChatRequestMessage => ({
		role: SYSTEM_ROLE,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(value)],
	});
	const user = (value: string): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(value)],
	});

	function convIdOf(messages: vscode.LanguageModelChatRequestMessage[]): string {
		const api = new TestApi("test-model");
		api.setConvIdFromMessages(messages);
		return api.convId;
	}

	test("same system prompt (different user turns) → same convId", () => {
		const sysPrompt = "You are a helpful assistant.\n- VSCODE_TARGET_SESSION_LOG: /x/aaaa-1111";
		const a = convIdOf([sys(sysPrompt), user("first prompt")]);
		const b = convIdOf([sys(sysPrompt), user("second prompt")]);
		assert.strictEqual(a, b);
	});

	test("different UUID in system prompt → different convId", () => {
		const a = convIdOf([sys("You are helpful.\n- VSCODE_TARGET_SESSION_LOG: /x/aaaa-1111"), user("same prompt")]);
		const b = convIdOf([sys("You are helpful.\n- VSCODE_TARGET_SESSION_LOG: /x/bbbb-2222"), user("same prompt")]);
		assert.notStrictEqual(a, b);
	});

	test("system prompt hash takes priority over the second user turn", () => {
		// Two histories share the same first two user turns but differ in the
		// system prompt → must differ (system prompt wins).
		const a = convIdOf([sys("system A"), user("u1"), user("u2")]);
		const b = convIdOf([sys("system B"), user("u1"), user("u2")]);
		assert.notStrictEqual(a, b);
	});

	test("no system message → falls back to the second user turn (unchanged behavior)", () => {
		const a = convIdOf([user("u1"), user("u2")]);
		const b = convIdOf([user("u1"), user("u2")]);
		assert.strictEqual(a, b);
		// Same second user turn, different first user turn → still the same.
		const c = convIdOf([user("different-u1"), user("u2")]);
		assert.strictEqual(a, c);
		// Different second user turn → different.
		const d = convIdOf([user("u1"), user("u3")]);
		assert.notStrictEqual(a, d);
	});

	test("only one user message, no system → falls back to the first user message", () => {
		const a = convIdOf([user("only")]);
		const b = convIdOf([user("only")]);
		assert.strictEqual(a, b);
		const c = convIdOf([user("other")]);
		assert.notStrictEqual(a, c);
	});
});
