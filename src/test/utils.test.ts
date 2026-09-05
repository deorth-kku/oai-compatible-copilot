import * as assert from "assert";
import * as vscode from "vscode";
import { normalizeUserModels, sanitizeMessages, stripReminderInstructions } from "../utils";
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

suite("stripReminderInstructions", () => {
	test("removes a well-formed multi-line block, preserving surrounding text", () => {
		const text = "before\n<reminderInstructions>\nline one\nline two\n</reminderInstructions>\nafter";
		assert.strictEqual(stripReminderInstructions(text), "before\n\nafter");
	});

	test("removes only the FIRST block when multiple exist", () => {
		const text =
			"A<reminderInstructions>1</reminderInstructions>B<reminderInstructions>2</reminderInstructions>C";
		assert.strictEqual(stripReminderInstructions(text), "AB<reminderInstructions>2</reminderInstructions>C");
	});

	test("is a no-op when the tag is absent", () => {
		const text = "hello <reminder>world</reminder>";
		assert.strictEqual(stripReminderInstructions(text), text);
	});

	test("is a no-op for an unclosed opening tag (strict match)", () => {
		const text = "A<reminderInstructions>never closed";
		assert.strictEqual(stripReminderInstructions(text), text);
	});

	test("is case-sensitive (different case is not removed)", () => {
		const text = "A<reminderinstructions>1</reminderinstructions>B";
		assert.strictEqual(stripReminderInstructions(text), text);
	});
});

suite("sanitizeMessages", () => {
	const userMsg = (value: string): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(value)],
	});
	const assistantMsg = (value: string): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.Assistant,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(value)],
	});
	// The shipped @types/vscode enum only defines User/Assistant; the runtime
	// System role is 3 (mapRole treats anything not User/Assistant as system).
	const SYSTEM_ROLE = 3 as unknown as vscode.LanguageModelChatMessageRole;
	const systemMsg = (value: string): vscode.LanguageModelChatRequestMessage => ({
		role: SYSTEM_ROLE,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(value)],
	});

	test("strips only user-role text parts (stripReminder)", () => {
		const user = userMsg("u<reminderInstructions>x</reminderInstructions>u");
		const assistant = assistantMsg("a<reminderInstructions>x</reminderInstructions>a");
		const out = sanitizeMessages([user, assistant], { stripReminder: true });
		assert.strictEqual((out[0].content[0] as vscode.LanguageModelTextPart).value, "uu");
		assert.strictEqual(
			(out[1].content[0] as vscode.LanguageModelTextPart).value,
			"a<reminderInstructions>x</reminderInstructions>a"
		);
	});

	test("returns the original array when nothing changes", () => {
		const msgs = [userMsg("plain"), assistantMsg("plain")];
		assert.strictEqual(sanitizeMessages(msgs, { stripReminder: true }), msgs);
	});

	test("returns the original array when both flags are false (no copy)", () => {
		const msgs = [
			userMsg("u<reminderInstructions>x</reminderInstructions>u"),
			systemMsg("stable</memoryInstructions>tail"),
		];
		assert.strictEqual(sanitizeMessages(msgs, {}), msgs);
	});

	test("does not mutate the input and replaces only the changed part", () => {
		const user = userMsg("u<reminderInstructions>x</reminderInstructions>u");
		const out = sanitizeMessages([user], { stripReminder: true });
		assert.strictEqual(
			(user.content[0] as vscode.LanguageModelTextPart).value,
			"u<reminderInstructions>x</reminderInstructions>u"
		);
		assert.notStrictEqual(out[0].content[0], user.content[0]);
	});

	test("passes non-text parts through by reference", () => {
		const dataPart = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const user = {
			role: vscode.LanguageModelChatMessageRole.User,
			name: undefined,
			content: [new vscode.LanguageModelTextPart("u<reminderInstructions>x</reminderInstructions>u"), dataPart],
		} as vscode.LanguageModelChatRequestMessage;
		const out = sanitizeMessages([user], { stripReminder: true });
		assert.strictEqual(out[0].content[1], dataPart);
	});

	test("splits the first system message at </memoryInstructions> into a system + user message", () => {
		const system = systemMsg("stable prefix</memoryInstructions>\n<instructions>\ntail section\n</instructions>");
		const out = sanitizeMessages([system], { splitSystemPrompt: true });
		assert.strictEqual(out.length, 2);
		assert.strictEqual((out[0].content[0] as vscode.LanguageModelTextPart).value, "stable prefix</memoryInstructions>");
		assert.strictEqual(
			(out[1].content[0] as vscode.LanguageModelTextPart).value,
			"<instructions>\ntail section\n</instructions>"
		);
		// The remainder becomes a user message (a second system message would be
		// merged back by llama.cpp's jinja template).
		assert.strictEqual(out[1].role, vscode.LanguageModelChatMessageRole.User);
	});

	test("splits at the FIRST marker occurrence only", () => {
		const system = systemMsg("A</memoryInstructions>B</memoryInstructions>C");
		const out = sanitizeMessages([system], { splitSystemPrompt: true });
		assert.strictEqual(out.length, 2);
		assert.strictEqual((out[0].content[0] as vscode.LanguageModelTextPart).value, "A</memoryInstructions>");
		assert.strictEqual((out[1].content[0] as vscode.LanguageModelTextPart).value, "B</memoryInstructions>C");
	});

	test("returns the original array when the system message has no marker", () => {
		const msgs = [systemMsg("no marker here")];
		assert.strictEqual(sanitizeMessages(msgs, { splitSystemPrompt: true }), msgs);
	});

	test("does not split when the remainder after the marker is empty", () => {
		const msgs = [systemMsg("stable prefix</memoryInstructions>  ")];
		assert.strictEqual(sanitizeMessages(msgs, { splitSystemPrompt: true }), msgs);
	});

	test("does not split a system message with multiple parts", () => {
		const multi = {
			role: SYSTEM_ROLE,
			name: undefined,
			content: [
				new vscode.LanguageModelTextPart("A</memoryInstructions>"),
				new vscode.LanguageModelTextPart("B"),
			],
		} as vscode.LanguageModelChatRequestMessage;
		const msgs = [multi];
		assert.strictEqual(sanitizeMessages(msgs, { splitSystemPrompt: true }), msgs);
	});

	test("only the FIRST system message is split (later system messages untouched)", () => {
		const first = systemMsg("A</memoryInstructions>B");
		const second = systemMsg("C</memoryInstructions>D");
		const out = sanitizeMessages([first, second], { splitSystemPrompt: true });
		assert.strictEqual(out.length, 3);
		assert.strictEqual((out[0].content[0] as vscode.LanguageModelTextPart).value, "A</memoryInstructions>");
		assert.strictEqual((out[1].content[0] as vscode.LanguageModelTextPart).value, "B");
		assert.strictEqual(out[2], second);
	});

	test("never splits user or assistant messages", () => {
		const msgs = [userMsg("u</memoryInstructions>u"), assistantMsg("a</memoryInstructions>a")];
		assert.strictEqual(sanitizeMessages(msgs, { splitSystemPrompt: true }), msgs);
	});

	test("applies stripReminder and splitSystemPrompt in one pass", () => {
		const system = systemMsg("A</memoryInstructions>B");
		const user = userMsg("u<reminderInstructions>x</reminderInstructions>u");
		const out = sanitizeMessages([system, user], { stripReminder: true, splitSystemPrompt: true });
		assert.strictEqual(out.length, 3);
		assert.strictEqual((out[0].content[0] as vscode.LanguageModelTextPart).value, "A</memoryInstructions>");
		assert.strictEqual((out[1].content[0] as vscode.LanguageModelTextPart).value, "B");
		assert.strictEqual((out[2].content[0] as vscode.LanguageModelTextPart).value, "uu");
	});

	test("stripReminder does not affect system messages (system reminder block untouched)", () => {
		const system = systemMsg("s<reminderInstructions>x</reminderInstructions>s");
		const out = sanitizeMessages([system], { stripReminder: true });
		assert.strictEqual(
			(out[0].content[0] as vscode.LanguageModelTextPart).value,
			"s<reminderInstructions>x</reminderInstructions>s"
		);
	});
});
