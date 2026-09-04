/**
 * A single underlying provider (e.g., together, groq) for a model.
 */
export interface HFProvider {
	provider: string;
	status: string;
	supports_tools?: boolean;
	supports_structured_output?: boolean;
	context_length?: number;
}

/**
 * Configuration passed to message conversion that may affect how messages are
 * serialized for a given provider (e.g. whether to round-trip reasoning, or
 * whether the target model supports vision and thus can receive inline images).
 */
export interface ModelConversionConfig {
	includeReasoningInRequest: boolean;
	vision?: boolean;
}

/**
 * A model entry returned by the Hugging Face router models endpoint.
 */
export interface HFArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

/**
 * Optional metadata returned by some /v1/models implementations
 * (e.g. llama.cpp). `n_ctx` is the model's context length.
 */
export interface HFModelMeta {
	vocab_type?: number;
	n_vocab?: number;
	n_ctx?: number;
	n_ctx_train?: number;
	n_embd?: number;
	n_params?: number;
	size?: number;
	ftype?: string;
	[key: string]: unknown;
}

export interface HFModelItem {
	id: string;
	object?: string;
	created?: number;
	owned_by: string;
	configId?: string;
	displayName?: string;
	baseUrl?: string;
	providers?: HFProvider[];
	architecture?: HFArchitecture;
	context_length?: number;
	// llama.cpp /v1/models metadata (e.g. n_ctx context length)
	meta?: HFModelMeta;
	vision?: boolean;
	max_tokens?: number;
	// OpenAI new standard parameter
	max_completion_tokens?: number;
	reasoning_effort?: string;
	enable_thinking?: boolean;
	thinking_budget?: number;
	// New thinking configuration for Zai provider
	thinking?: ThinkingConfig;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	temperature?: number | null;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	top_p?: number | null;
	top_k?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	reasoning?: ReasoningConfig;
	/**
	 * Dedicated optimization type for the model backend.
	 * - "default": no backend-specific extensions
	 * - "openrouter": OpenRouter-specific reasoning params (effort/budget/exclude)
	 * - "llama.cpp": llama.cpp-specific flags (return_progress, timings_per_token)
	 */
	optimization?: "default" | "openrouter" | "llama.cpp";
	/**
	 * Standard reasoning effort values the model supports (drives VS Code picker enum).
	 * Only standard values: none, minimal, low, medium, high, xhigh, max.
	 */
	supported_efforts?: string[];
	/**
	 * Optional family specification for the model. This allows users to specify
	 * the model family (e.g., "gpt-4", "claude-3", "gemini") to enable family-specific
	 * optimizations and behaviors in the Copilot extension. If not specified,
	 * defaults to "oai-compatible".
	 */
	family?: string;

	/**
	 * Optional VS Code codicon id (kebab-case, e.g. "openai", "claude", "google-gemini",
	 * "lightbulb-sparkle") shown next to the model in the Copilot model picker via
	 * {@linkcode vscode.ThemeIcon}. Any valid codicon id is accepted; leave empty to
	 * use the default icon. Unknown ids fall back to a missing-glyph without crashing.
	 */
	statusIcon?: string;

	/**
	 * Extra configuration parameters that can be used for custom functionality.
	 * This allows users to add any additional parameters they might need
	 * without modifying the core interface.
	 */
	extra?: Record<string, unknown>;

	/**
	 * Custom HTTP headers to be sent with every request to this model's provider.
	 * These headers will be merged with the default headers (Authorization, Content-Type, User-Agent).
	 * Example: { "X-API-Version": "v1", "X-Custom-Header": "value" }
	 */
	headers?: Record<string, string>;

	/**
	 * Whether to include reasoning_content in assistant messages sent to the API.
	 * Support deepseek-v3.2 or others.
	 */
	include_reasoning_in_request?: boolean;

	/**
	 * Whether to strip the first `<reminderInstructions>` block that Copilot
	 * injects into every user turn before sending the request to the API.
	 * Default is false (the block is kept).
	 */
	strip_reminder_instructions?: boolean;

	/**
	 * API mode: "openai" for OpenAI Chat Completions, "openai-responses" for OpenAI Responses,
	 * "ollama" for Ollama native API, "anthropic" for Anthropic Messages, "gemini" for Gemini native API.
	 * Default is "openai".
	 */
	apiMode?: HFApiMode;

	/**
	 * Whether this model can be used for Git commit message generation.
	 * If true, this model will be available for generating commit messages.
	 * Default is false.
	 */
	useForCommitGeneration?: boolean;

	/**
	 * Model-specific delay in milliseconds between consecutive requests.
	 * If not specified, falls back to global `oaicopilot.delay` configuration.
	 */
	delay?: number;

	/**
	 * Enable Anthropic prompt caching breakpoints (only effective when `apiMode` is `"anthropic"`).
	 *
	 * When enabled, the provider will:
	 *   - Convert `system` into a structured array and mark it with `cache_control: { type: "ephemeral" }`.
	 *   - Mark the last entry of `tools` with `cache_control: { type: "ephemeral" }`.
	 *   - Honor in-message `cache_control` markers emitted by the host (Copilot) — i.e. a
	 *     `LanguageModelDataPart` with `mimeType === "cache_control"` is converted to a real
	 *     Anthropic `cache_control` field on the preceding content block.
	 *
	 * Defaults to `true`. Set to `false` for upstream providers that reject `cache_control`.
	 */
	cache_control?: boolean;
}

/**
 * OpenRouter reasoning configuration.
 * Only `exclude` is actively used going forward; `effort`/`max_tokens`/`enabled`
 * are kept for backward-compat / migration only.
 * `supported_efforts` and `default_effort` are OpenRouter-provided metadata
 * (auto-fill source for the user-facing config).
 */
export interface ReasoningConfig {
	effort?: string;
	exclude?: boolean;
	max_tokens?: number;
	enabled?: boolean;
	supported_efforts?: string[];
	default_effort?: string;
}

/**
 * Supplemental model info from the Hugging Face hub API.
 */
// Deprecated: extra model info was previously fetched from the hub API
export interface HFExtraModelInfo {
	id: string;
	pipeline_tag?: string;
}

/**
 * Response envelope for the router models listing.
 */
export interface HFModelsResponse {
	object: string;
	data: HFModelItem[];
}

/**
 * Thinking configuration for Zai provider
 */
export interface ThinkingConfig {
	type?: string;
}

/**
 * Retry configuration for rate limiting
 */
export interface RetryConfig {
	enabled?: boolean;
	max_attempts?: number;
	interval_ms?: number;
	status_codes?: number[];
}

/** Supports API mode. */
export type HFApiMode = "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini";

/**
 * Custom data part MIME types for vscode.LanguageModelDataPart
 */
export namespace CustomDataPartMimeTypes {
	export const CacheControl = "cache_control";
	export const StatefulMarker = "stateful_marker";
	export const ThinkingData = "thinking";
	export const ContextManagement = "context_management";
	export const PhaseData = "phase_data";
	export const Usage = "usage";
}

/**
 * Standard OpenAI token usage details.
 */
export interface TokenUsageDetails {
	cached_tokens: number;
}

/**
 * Standard OpenAI completion token usage details
 * (reasoning tokens vs. visible tokens).
 */
export interface CompletionTokenUsageDetails {
	reasoning_tokens?: number;
	visible_tokens?: number;
}

/**
 * llama.cpp timing and cache statistics. llama-server emits these in a
 * `timings` object that is a SIBLING of `usage` in the final streamed chunk
 * (only when the corresponding server log flags are enabled). The provider
 * attaches it to the captured usage object. `prompt_n`/`prompt_ms` cover
 * only the non-cached portion of the prompt (the cached prefix is served
 * from the cache).
 */
export interface LlamaTimings {
	prompt_n?: number;
	prompt_ms?: number;
	prompt_per_token_ms?: number;
	prompt_per_second?: number;
	predicted_n?: number;
	predicted_ms?: number;
	predicted_per_token_ms?: number;
	predicted_per_second?: number;
	cache_n?: number;
	cache_lcp_n?: number;
	cache_planned_n?: number;
	cache_reprocessed_n?: number;
	cache_source?: string;
	cache_reason?: string;
	// llama.cpp aliases for prompt/completion token counts
	input_tokens?: number;
	output_tokens?: number;
}

/**
 * Standard OpenAI token usage structure.
 *
 * When pointed at a llama.cpp llama-server, the final chunk carries a
 * `timings` object (sibling of `usage`) with llama.cpp-specific timing and
 * cache stats; the provider attaches it to the captured usage object
 * (absent on other backends).
 */
export interface TokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: TokenUsageDetails;
	completion_tokens_details?: CompletionTokenUsageDetails;
	// llama.cpp timing/cache stats, nested in a `timings` object
	timings?: LlamaTimings;
}
