import type * as vscode from "vscode";
import type { HFModelItem } from "./types";

export type ReasoningEffortPickerValue = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES: readonly ReasoningEffortPickerValue[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const REASONING_EFFORT_LABELS: Record<ReasoningEffortPickerValue, string> = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffortPickerValue, string> = {
	none: "Disable reasoning / thinking",
	minimal: "Smallest reasoning budget",
	low: "Low reasoning budget",
	medium: "Balanced reasoning budget",
	high: "High reasoning budget",
	xhigh: "Very high reasoning budget",
	max: "Maximum reasoning budget",
};

export const REASONING_EFFORT_CONFIGURATION_SCHEMA = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			enum: REASONING_EFFORT_VALUES,
			enumItemLabels: ["None", "Minimal", "Low", "Medium", "High", "XHigh", "Max"],
			enumDescriptions: [
				"Disable reasoning / thinking",
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

export function createReasoningEffortConfigurationSchema(
	defaultValue: ReasoningEffortPickerValue,
	supportedEfforts?: readonly string[]
) {
	// Restrict the picker to the model's declared efforts (standard values only,
	// canonical order); fall back to the full standard set when none are valid.
	const values =
		supportedEfforts && supportedEfforts.length > 0
			? REASONING_EFFORT_VALUES.filter((v) => supportedEfforts.includes(v))
			: [...REASONING_EFFORT_VALUES];
	const finalValues = values.length > 0 ? values : [...REASONING_EFFORT_VALUES];
	return {
		properties: {
			reasoningEffort: {
				type: "string" as const,
				title: "Reasoning Effort",
				enum: finalValues,
				enumItemLabels: finalValues.map((v) => REASONING_EFFORT_LABELS[v]),
				enumDescriptions: finalValues.map((v) => REASONING_EFFORT_DESCRIPTIONS[v]),
				default: defaultValue,
				group: "navigation" as const,
			},
		},
	} as const;
}

/**
 * Build the "Context Window" configuration schema that drives the VS Code
 * model picker's context-size segmented control.
 *
 * The picker always offers the same five tiers — `auto` plus 25% / 50% / 75% /
 * 100% of the model's configured context length — so the enum values are
 * derived from `contextLength` (in tokens) rather than read from user config.
 * The `auto` tier is the string `"auto"`; the percentage tiers are numeric
 * token counts.
 *
 * The value the user selects is intentionally IGNORED by this extension — the
 * picker only exists to let the user control when VS Code auto-compacts the
 * conversation. See `provideModel.ts`.
 */
export function createContextSizeConfigurationSchema(contextLength: number): ModelConfigurationSchema {
	const base = Math.max(0, Math.floor(contextLength));
	const tier = (fraction: number) => Math.floor(base * fraction);
	return {
		properties: {
			contextSize: {
				type: ["string", "number"],
				title: "Context Window",
				enum: ["auto", tier(0.25), tier(0.5), tier(0.75), base],
				enumItemLabels: ["Auto", "25%", "50%", "75%", "100%"],
				default: "auto",
				group: "tokens",
			},
		},
	};
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

/**
 * A VS Code model-picker configuration schema. A single schema object may carry
 * multiple `properties` (e.g. both `reasoningEffort` and `contextSize`), each
 * tagged with a `group` so the picker can route it to the right UI section.
 */
export type ModelConfigurationSchema = {
	readonly properties: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable?: boolean;
	readonly detail?: string;
	readonly tooltip?: string;
	readonly configurationSchema?: ModelConfigurationSchema;
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
	if (getModelDefaultReasoningEffort(model) !== undefined) {
		return true;
	}
	// Also enable the picker when the model declares supported efforts.
	const supported = (model?.supported_efforts ?? []).filter((v) =>
		REASONING_EFFORT_VALUES.includes(v as ReasoningEffortPickerValue)
	);
	return supported.length > 0;
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
