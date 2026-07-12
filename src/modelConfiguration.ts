import type * as vscode from "vscode";
import type { HFModelItem } from "./types";

export type ReasoningEffortPickerValue = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES: readonly ReasoningEffortPickerValue[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const REASONING_EFFORT_CONFIGURATION_SCHEMA = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			enum: REASONING_EFFORT_VALUES,
			enumItemLabels: ["Minimal", "Low", "Medium", "High", "XHigh", "Max"],
			enumDescriptions: [
				"Smallest reasoning budget",
				"Low reasoning budget",
				"Balanced reasoning budget",
				"High reasoning budget",
				"Very high reasoning budget",
				"Maximum reasoning budget",
			],
			default: "medium",
			group: "navigation",
		},
	},
} as const;

export function createReasoningEffortConfigurationSchema(defaultValue: ReasoningEffortPickerValue) {
	return {
		properties: {
			reasoningEffort: {
				...REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort,
				default: defaultValue,
			},
		},
	} as const;
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable?: boolean;
	readonly detail?: string;
	readonly tooltip?: string;
	readonly configurationSchema?: ReturnType<typeof createReasoningEffortConfigurationSchema>;
};

/**
 * Resolve the default reasoning effort for a model from either the OpenAI-style
 * top-level `reasoning_effort` field or the OpenRouter-style nested
 * `reasoning.effort` field. Returns `undefined` when neither is a valid picker
 * value (i.e. the UI picker should not be offered for this model).
 */
export function getModelDefaultReasoningEffort(
	model: HFModelItem | undefined
): ReasoningEffortPickerValue | undefined {
	if (isReasoningEffortValue(model?.reasoning_effort)) {
		return model.reasoning_effort;
	}
	if (isReasoningEffortValue(model?.reasoning?.effort)) {
		return model.reasoning.effort;
	}
	return undefined;
}

export function isReasoningEffortPickerEnabled(model: HFModelItem | undefined): boolean {
	return getModelDefaultReasoningEffort(model) !== undefined;
}

export function getConfiguredReasoningEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined,
	fallback?: ReasoningEffortPickerValue
): ReasoningEffortPickerValue {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configuredEffort =
		modelOptions?.modelConfiguration?.reasoningEffort ?? modelOptions?.configuration?.reasoningEffort;

	if (isReasoningEffortValue(configuredEffort)) {
		return configuredEffort;
	}
	return fallback ?? "medium";
}

export function isReasoningEffortValue(value: unknown): value is ReasoningEffortPickerValue {
	return typeof value === "string" && REASONING_EFFORT_VALUES.includes(value as ReasoningEffortPickerValue);
}
