import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	createReasoningEffortConfigurationSchema,
	getConfiguredReasoningEffort,
	isReasoningEffortPickerEnabled,
	type ModelPickerChatInformation,
	REASONING_EFFORT_CONFIGURATION_SCHEMA,
} from "../modelConfiguration";
import { OllamaApi } from "../ollama/ollamaApi";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { prepareLanguageModelChatInformation } from "../provideModel";
import type { HFModelItem } from "../types";

suite("modelConfiguration", () => {
	const deepSeekModel: HFModelItem = {
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		owned_by: "deepseek",
		baseUrl: "https://api.deepseek.com",
		apiMode: "openai",
		context_length: 1_000_000,
		max_tokens: 384_000,
		reasoning_effort: "medium",
	};

	test("only enables the picker when the model has a reasoning effort default", () => {
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "custom" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "high" }), true);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "none" }), true);
	});

	test("defines reasoning effort choices for provider configuration", () => {
		const schema = REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort;
		assert.strictEqual(schema.title, "Reasoning Effort");
		assert.strictEqual(schema.default, "medium");
		assert.deepStrictEqual(schema.enum, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.strictEqual(createReasoningEffortConfigurationSchema("high").properties.reasoningEffort.default, "high");
	});

	test("builds the reasoning effort enum from supported_efforts (standard values only)", () => {
		// Custom subset, canonical order preserved
		const schema = createReasoningEffortConfigurationSchema("high", ["high", "low", "none"]);
		const prop = schema.properties.reasoningEffort;
		assert.deepStrictEqual(prop.enum, ["none", "low", "high"]);
		assert.deepStrictEqual(prop.enumItemLabels, ["None", "Low", "High"]);
		assert.strictEqual(prop.default, "high");

		// Unknown values are dropped; falls back to the full standard set when none are valid
		const fallback = createReasoningEffortConfigurationSchema("medium", ["bogus", "weird"]);
		assert.deepStrictEqual(fallback.properties.reasoningEffort.enum, [
			"none",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);

		// No supported_efforts -> full standard set
		const full = createReasoningEffortConfigurationSchema("medium");
		assert.strictEqual(full.properties.reasoningEffort.enum.length, 7);
	});

	test("enables the picker when supported_efforts declares standard values", () => {
		assert.strictEqual(
			isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", supported_efforts: ["high", "low"] }),
			true
		);
		// Only non-standard values -> disabled
		assert.strictEqual(
			isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", supported_efforts: ["bogus"] }),
			false
		);
	});

	test("reads the selected reasoning effort from VS Code model configuration", () => {
		assert.strictEqual(getConfiguredReasoningEffort(undefined), "medium");
		assert.strictEqual(getConfiguredReasoningEffort(undefined, "low"), "low");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "high" } } as never),
			"high"
		);
		assert.strictEqual(getConfiguredReasoningEffort({ configuration: { reasoningEffort: "max" } } as never), "max");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "invalid" } } as never, "xhigh"),
			"xhigh"
		);
	});

	test("registers deepseek-v4-flash with reasoning effort metadata", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = { ...deepSeekModel, id: "deepseek-v4-flash", displayName: undefined };

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.name, "deepseek-v4-flash");
			assert.strictEqual(info.detail, "deepseek (OAICopilot)");
			assert.strictEqual(info.isUserSelectable, true);
			assert.strictEqual(info.isBYOK, true);
			assert.deepStrictEqual(info.configurationSchema, createReasoningEffortConfigurationSchema("medium"));
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("does not register reasoning effort metadata when the default is empty", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			...deepSeekModel,
			id: "deepseek-v4-flash",
			displayName: undefined,
			reasoning_effort: undefined,
		};

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.configurationSchema, undefined);
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("applies selected reasoning effort to OpenAI-compatible chat requests", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			deepSeekModel,
			{ modelConfiguration: { reasoningEffort: "high" } } as never
		);

		assert.strictEqual(requestBody.reasoning_effort, "high");
	});

	test("falls back to the configured default reasoning effort when Copilot has no temporary override", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			{ ...deepSeekModel, reasoning_effort: "low" },
			undefined
		);

		assert.strictEqual(requestBody.reasoning_effort, "low");
	});

	test("applies selected reasoning effort to OpenAI Responses requests", () => {
		const requestBody = new OpenaiResponsesApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", input: [], stream: true },
			{ ...deepSeekModel, apiMode: "openai-responses" },
			{ modelConfiguration: { reasoningEffort: "max" } } as never
		);

		assert.deepStrictEqual(requestBody.reasoning, { effort: "max" });
	});

	test("applies output_config.effort to Anthropic requests when configured", () => {
		const anthropicBody = new AnthropicApi("claude").prepareRequestBody(
			{ model: "claude", messages: [], max_tokens: 1024, stream: true },
			{ ...deepSeekModel, apiMode: "anthropic", reasoning_effort: "high" },
			undefined
		) as unknown as Record<string, unknown>;

		assert.deepStrictEqual(anthropicBody.output_config, { effort: "high" });
		assert.deepStrictEqual(anthropicBody.thinking, { type: "adaptive" });
	});

	test("uses manual extended thinking when enable_thinking + thinking_budget are set", () => {
		const anthropicBody = new AnthropicApi("claude").prepareRequestBody(
			{ model: "claude", messages: [], max_tokens: 1024, stream: true },
			{ ...deepSeekModel, apiMode: "anthropic", enable_thinking: true, thinking_budget: 16000 },
			undefined
		) as unknown as Record<string, unknown>;

		assert.deepStrictEqual(anthropicBody.thinking, { type: "enabled", budget_tokens: 16000 });
	});

	test("keeps the picker out of unsupported native API request bodies", () => {
		const options = { modelConfiguration: { reasoningEffort: "high" } } as never;
		const anthropicBody = new AnthropicApi("claude").prepareRequestBody(
			{ model: "claude", messages: [], max_tokens: 1024, stream: true },
			{ ...deepSeekModel, apiMode: "anthropic" },
			options
		) as unknown as Record<string, unknown>;
		const ollamaBody = new OllamaApi("qwen3").prepareRequestBody(
			{ model: "qwen3", messages: [], stream: true },
			{ ...deepSeekModel, apiMode: "ollama" },
			options
		) as unknown as Record<string, unknown>;
		const geminiBody = new GeminiApi("gemini").prepareRequestBody(
			{ contents: [] },
			{ ...deepSeekModel, apiMode: "gemini" },
			options
		) as Record<string, unknown>;

		assert.strictEqual(anthropicBody.reasoning_effort, undefined);
		assert.strictEqual(anthropicBody.thinking, undefined);
		assert.strictEqual(ollamaBody.reasoning_effort, undefined);
		assert.strictEqual(ollamaBody.think, undefined);
		assert.strictEqual(geminiBody.reasoning_effort, undefined);
		assert.strictEqual(geminiBody.thinkingConfig, undefined);
	});
});
