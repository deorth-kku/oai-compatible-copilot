const vscode = acquireVsCodeApi();
const state = {
	baseUrl: "",
	apiKey: "",
	delay: 0,
	retry: { enabled: true, max_attempts: 3, interval_ms: 1000, status_codes: [429, 500, 502, 503, 504] },
	commitModel: "",
	models: [],
	providerKeys: {},
	providerInfo: {},
};

// Store the action to be performed after confirmation
const pendingConfirmations = new Map();

// Global Configuration elements
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const delayInput = document.getElementById("delay");
const readFileLinesInput = document.getElementById("readFileLines");
const retryEnabledInput = document.getElementById("retryEnabled");
const maxAttemptsInput = document.getElementById("maxAttempts");
const intervalMsInput = document.getElementById("intervalMs");
const statusCodesInput = document.getElementById("statusCodes");

// Provider management elements
const providerTableBody = document.getElementById("providerTableBody");

// Model management elements
const modelTableBody = document.getElementById("modelTableBody");
const modelFormSection = document.getElementById("modelFormSection");
const modelFormTitle = document.getElementById("modelFormTitle");
const modelIdInput = document.getElementById("modelIdInput");
const modelIdDropdown = document.getElementById("modelIdDropdown");
const modelProviderInput = document.getElementById("modelProvider");
const modelDisplayNameInput = document.getElementById("modelDisplayName");
const modelConfigIdInput = document.getElementById("modelConfigId");
const modelBaseUrlInput = document.getElementById("modelBaseUrl");
const modelFamilyInput = document.getElementById("modelFamily");
const modelStatusIconInput = document.getElementById("modelStatusIcon");
const modelContextLengthInput = document.getElementById("modelContextLength");
const modelMaxTokensInput = document.getElementById("modelMaxTokens");
const modelVisionInput = document.getElementById("modelVision");
const modelApiModeInput = document.getElementById("modelApiMode");
const modelTemperatureInput = document.getElementById("modelTemperature");
const modelTopPInput = document.getElementById("modelTopP");
const modelDelayInput = document.getElementById("modelDelay");
const modelTopKInput = document.getElementById("modelTopK");
const modelMinPInput = document.getElementById("modelMinP");
const modelFrequencyPenaltyInput = document.getElementById("modelFrequencyPenalty");
const modelPresencePenaltyInput = document.getElementById("modelPresencePenalty");
const modelRepetitionPenaltyInput = document.getElementById("modelRepetitionPenalty");
const modelReasoningEffortInput = document.getElementById("modelReasoningEffort");
const modelEnableThinkingInput = document.getElementById("modelEnableThinking");
const modelThinkingBudgetInput = document.getElementById("modelThinkingBudget");
const modelIncludeReasoningInput = document.getElementById("modelIncludeReasoning");
const modelStripReminderInstructionsInput = document.getElementById("modelStripReminderInstructions");
const modelMaxCompletionTokensInput = document.getElementById("modelMaxCompletionTokens");
const modelOptimizationInput = document.getElementById("modelOptimization");
const modelReasoningExcludeInput = document.getElementById("modelReasoningExclude");
const modelReasoningExcludeField = document.getElementById("modelReasoningExcludeField");
const modelDiskKvCacheInput = document.getElementById("modelDiskKvCache");
const modelDiskKvCacheField = document.getElementById("modelDiskKvCacheField");
const modelLlamaSlotTimeoutInput = document.getElementById("modelLlamaSlotTimeout");
const modelLlamaSlotTimeoutField = document.getElementById("modelLlamaSlotTimeoutField");
const modelSplitSystemPromptInput = document.getElementById("modelSplitSystemPrompt");
const modelSplitSystemPromptField = document.getElementById("modelSplitSystemPromptField");
const supportedEffortsGroup = document.getElementById("modelSupportedEfforts");
const modelThinkingTypeInput = document.getElementById("modelThinkingType");
const modelHeadersInput = document.getElementById("modelHeaders");
const modelExtraInput = document.getElementById("modelExtra");
const saveModelBtn = document.getElementById("saveModel");
const cancelModelBtn = document.getElementById("cancelModel");
const toggleAdvancedSettingsBtn = document.getElementById("toggleAdvancedSettings");
const commitModelInput = document.getElementById("commitModel");
const commitLanguageInput = document.getElementById("commitLanguage");
const advancedSettingsContent = document.getElementById("advancedSettingsContent");

// Error message element
const modelErrorElement = document.getElementById("modelError");

// Dropdown elements
const dropdownContent = modelIdDropdown.querySelector(".dropdown-content");
const dropdownHeader = modelIdDropdown.querySelector(".dropdown-header");

// Global Configuration save button event listener
document.getElementById("saveBase").addEventListener("click", () => {
	const retry = {
		enabled: retryEnabledInput.checked,
		max_attempts: parseInt(maxAttemptsInput.value) || 3,
		interval_ms: parseInt(intervalMsInput.value) || 1000,
		status_codes: statusCodesInput.value
			? statusCodesInput.value
					.split(",")
					.map((s) => parseInt(s.trim()))
					.filter((n) => !isNaN(n))
			: [],
	};

	vscode.postMessage({
		type: "saveGlobalConfig",
		baseUrl: baseUrlInput.value,
		apiKey: apiKeyInput.value,
		delay: parseInt(delayInput.value) || 0,
		readFileLines: parseInt(readFileLinesInput.value) || 0,
		retry: retry,
		commitModel: commitModelInput.value,
		commitLanguage: commitLanguageInput.value,
	});
});

const handleRefresh = () => {
	// Hide the model form if it's visible
	if (modelFormSection.style.display !== "none") {
		modelFormSection.style.display = "none";
		resetModelForm();
	}
	vscode.postMessage({ type: "requestInit" });
};

// Export and Import buttons event listeners
document.getElementById("exportConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "exportConfig" });
});

document.getElementById("importConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "importConfig" });
});

// Refresh buttons event listeners
document.getElementById("refreshGlobalConfig").addEventListener("click", handleRefresh);
document.getElementById("refreshProviders").addEventListener("click", handleRefresh);
document.getElementById("refreshModels").addEventListener("click", handleRefresh);

// Add Provider button event listener
document.getElementById("addProvider").addEventListener("click", () => {
	// Add new provider row to the table
	const newRow = document.createElement("tr");
	newRow.innerHTML = `
		<td><input type="text" class="provider-input" data-field="provider" placeholder="Provider ID" /></td>
		<td><input type="text" class="provider-input" data-field="baseUrl" placeholder="Base URL" /></td>
		<td><input type="password" class="provider-input" data-field="apiKey" placeholder="API Key" /></td>
		<td>
			<select class="provider-input" data-field="apiMode">
				<option value="openai">OpenAI</option>
				<option value="openai-responses">OpenAI Responses</option>
				<option value="ollama">Ollama</option>
				<option value="anthropic">Anthropic</option>
				<option value="gemini">Gemini</option>
			</select>
		</td>
		<td><textarea class="provider-input" data-field="headers" rows="2" placeholder='{"X-API-Version": "v1"}' style="width: 100%; font-family: monospace; font-size: 12px;"></textarea></td>
		<td>
			<button class="save-provider-btn secondary">Save</button>
			<button class="cancel-provider-btn secondary">Cancel</button>
		</td>
	`;
	providerTableBody.appendChild(newRow);

	// Add event listeners for the new row
	const saveBtn = newRow.querySelector(".save-provider-btn");
	const cancelBtn = newRow.querySelector(".cancel-provider-btn");

	saveBtn.addEventListener("click", () => {
		const inputs = newRow.querySelectorAll(".provider-input");
		const providerData = {};
		inputs.forEach((input) => {
			const field = input.getAttribute("data-field");
			providerData[field] = input.value;
		});

		let headers = undefined;
		if (providerData.headers && providerData.headers.trim()) {
			try {
				headers = JSON.parse(providerData.headers);
			} catch (e) {
				// ignore invalid JSON
			}
		}

		vscode.postMessage({
			type: "addProvider",
			provider: providerData.provider,
			baseUrl: providerData.baseUrl || undefined,
			apiKey: providerData.apiKey || undefined,
			apiMode: providerData.apiMode || undefined,
			headers: headers,
		});

		newRow.remove();
	});

	cancelBtn.addEventListener("click", () => {
		newRow.remove();
	});
});

// Add Model button event listeners
document.getElementById("addModel").addEventListener("click", () => {
	// Show the model form
	modelFormSection.style.display = "block";
	modelFormTitle.textContent = "Add New Model";
	// Reset form
	resetModelForm();
});

// Provider dropdown change event listener for auto-fill
modelProviderInput.addEventListener("change", () => {
	const selectedProvider = modelProviderInput.value;
	if (selectedProvider && state.providerInfo[selectedProvider]) {
		// Auto-fill BaseURL and apiMode from provider info
		modelBaseUrlInput.value = state.providerInfo[selectedProvider].baseUrl;
		modelApiModeInput.value = state.providerInfo[selectedProvider].apiMode;

		// Use headers from provider info
		const headers = state.providerInfo[selectedProvider].headers;
		modelHeadersInput.value = headers ? JSON.stringify(headers, null, 2) : "";

		// Request to fetch remote models for the selected provider
		vscode.postMessage({
			type: "fetchModels",
			baseUrl: state.providerInfo[selectedProvider].baseUrl || state.baseUrl,
			apiKey: state.providerKeys[selectedProvider] || state.apiKey,
			apiMode: state.providerInfo[selectedProvider].apiMode || modelApiModeInput.value || "openai",
			headers,
		});
	}
});

// Toggle advanced settings
toggleAdvancedSettingsBtn.addEventListener("click", () => {
	const isCurrentlyVisible = advancedSettingsContent.style.display !== "none";
	advancedSettingsContent.style.display = isCurrentlyVisible ? "none" : "block";
	toggleAdvancedSettingsBtn.textContent = isCurrentlyVisible ? "Show Advanced Settings" : "Hide Advanced Settings";
});

// Save Model button event listener
saveModelBtn.addEventListener("click", () => {
	const modelData = collectModelFormData();
	if (!validateModelData(modelData)) {
		return;
	}

	// For updates, ensure the model ID remains unchanged
	const isEditing = modelIdInput.hasAttribute("data-editing");
	if (isEditing) {
		// Remove helper attributes from the model data before sending
		let originalModelId = modelData.originalModelId;
		let originalConfigId = modelData.originalConfigId;
		delete modelData.originalModelId;
		delete modelData.originalConfigId;

		vscode.postMessage({
			type: "updateModel",
			model: modelData,
			originalModelId: originalModelId,
			originalConfigId: originalConfigId,
		});
	} else {
		vscode.postMessage({
			type: "addModel",
			model: modelData,
		});
	}

	// Hide the form and reset it
	modelFormSection.style.display = "none";
	resetModelForm();
});

// Cancel Model button event listener
cancelModelBtn.addEventListener("click", () => {
	// Hide the form and reset it
	modelFormSection.style.display = "none";
	resetModelForm();
});

window.addEventListener("message", (event) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			const { baseUrl, apiKey, delay, readFileLines, retry, commitModel, models, providerKeys, commitLanguage } =
				message.payload;
			state.baseUrl = baseUrl;
			state.apiKey = apiKey;
			state.delay = delay || 0;
			state.readFileLines = readFileLines || 0;
			state.retry = retry || {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
				status_codes: [],
			};
			state.models = models || [];
			state.commitModel = commitModel || "";
			state.providerKeys = providerKeys || {};

			// Update base configuration
			baseUrlInput.value = baseUrl || "";
			apiKeyInput.value = apiKey || "";
			delayInput.value = state.delay;
			readFileLinesInput.value = message.payload.readFileLines || 0;
			retryEnabledInput.checked = state.retry.enabled !== false;
			maxAttemptsInput.value = state.retry.max_attempts || 3;
			intervalMsInput.value = state.retry.interval_ms || 1000;
			statusCodesInput.value = state.retry.status_codes ? state.retry.status_codes.join(",") : "";

			// Populate commit model dropdown and select current commit model
			populateCommitModelDropdown();
			commitModelInput.value = state.commitModel || "";
			commitLanguageInput.value = commitLanguage;

			// Render provider and model management
			renderProviders();
			renderModels();
			break;
		case "modelsFetched":
			// Handle the response from fetchModels
			populateModelIdDropdown(message.models);
			break;
		case "modelsFetchError":
			// Handle error from fetchModels
			dropdownHeader.textContent = "Error fetching models";
			dropdownContent.innerHTML = `<div class="dropdown-option error">Failed to fetch models. Check the Developer Console for details.</div>`;
			console.error("[oaicopilot] Failed to fetch models:", message.error);
			break;
		case "confirmResponse":
			// Handle confirmation responses
			const pendingAction = pendingConfirmations.get(message.id);
			if (pendingAction && message.confirmed) {
				if (pendingAction.action) {
					pendingAction.action();
				}
				// Clean up the pending confirmation
				pendingConfirmations.delete(message.id);
			} else if (pendingAction) {
				// Clean up the pending confirmation even if not confirmed
				pendingConfirmations.delete(message.id);
			}
			break;
	}
});

function renderProviders() {
	// Get all unique providers
	const providers = Array.from(new Set(state.models.map((m) => m.owned_by).filter(Boolean))).sort((a, b) =>
		a.localeCompare(b)
	);

	if (!providers.length) {
		providerTableBody.innerHTML = '<tr><td colspan="6" class="no-data">No providers</td></tr>';
		// Clear the provider dropdown as well
		modelProviderInput.innerHTML = '<option value="">Select Provider</option>';
		return;
	}

	const rows = providers
		.map((provider) => {
			// Get the provider's configuration information
			const providerModels = state.models.filter((m) => m.owned_by === provider);
			const firstModel = providerModels[0];
			const headersJson = firstModel.headers ? JSON.stringify(firstModel.headers, null, 2) : "";

			return `
			<tr data-provider="${provider}">
				<td>${provider}</td>
				<td><input type="text" class="provider-input" data-field="baseUrl" value="${firstModel.baseUrl || ""}" placeholder="Base URL" /></td>
				<td><input type="password" class="provider-input" data-field="apiKey" value="${state.providerKeys[provider] || ""}" placeholder="API Key" /></td>
				<td>
					<select class="provider-input" data-field="apiMode">
						<option value="openai" ${firstModel.apiMode === "openai" ? "selected" : ""}>OpenAI</option>
						<option value="openai-responses" ${firstModel.apiMode === "openai-responses" ? "selected" : ""}>OpenAI Responses</option>
						<option value="ollama" ${firstModel.apiMode === "ollama" ? "selected" : ""}>Ollama</option>
						<option value="anthropic" ${firstModel.apiMode === "anthropic" ? "selected" : ""}>Anthropic</option>
						<option value="gemini" ${firstModel.apiMode === "gemini" ? "selected" : ""}>Gemini</option>
					</select>
				</td>
				<td><textarea class="provider-input" data-field="headers" rows="2" placeholder='{"X-API-Version": "v1"}' style="width: 100%; font-family: monospace; font-size: 12px;">${headersJson}</textarea></td>
				<td class="action-buttons">
					<button class="update-provider-btn" data-provider="${provider}">Save</button>
					<button class="delete-provider-btn danger" data-provider="${provider}">Delete</button>
				</td>
			</tr>`;
		})
		.join("");

	providerTableBody.innerHTML = rows;

	// Populate the provider dropdown in the model form and provider info
	state.providerInfo = {}; // Reset provider info
	const providerOptions = providers
		.map((provider) => {
			// Get the provider's configuration information
			const providerModels = state.models.filter((m) => m.owned_by === provider);
			const firstModel = providerModels[0];

			// Store provider info for auto-fill
			state.providerInfo[provider] = {
				baseUrl: firstModel.baseUrl || state.baseUrl,
				apiMode: firstModel.apiMode || "openai",
				apiKey: state.providerKeys[provider] || state.apiKey,
				headers: firstModel.headers,
			};

			return `<option value="${provider}">${provider}</option>`;
		})
		.join("");
	modelProviderInput.innerHTML = '<option value="">Select Provider</option>' + providerOptions;

	// Add event listeners for provider rows
	document.querySelectorAll(".update-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const provider = event.target.getAttribute("data-provider");
			const row = event.target.closest("tr");
			const inputs = row.querySelectorAll(".provider-input");
			const providerData = {};
			inputs.forEach((input) => {
				const field = input.getAttribute("data-field");
				providerData[field] = input.value;
			});

			let headers = undefined;
			if (providerData.headers && providerData.headers.trim()) {
				try {
					headers = JSON.parse(providerData.headers);
				} catch (e) {
					// ignore invalid JSON
				}
			}

			vscode.postMessage({
				type: "updateProvider",
				provider: provider,
				baseUrl: providerData.baseUrl || undefined,
				apiKey: providerData.apiKey || undefined,
				apiMode: providerData.apiMode || undefined,
				headers: headers,
			});
		});
	});

	document.querySelectorAll(".delete-provider-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const provider = event.target.getAttribute("data-provider");
			const confirmId = "deleteProvider_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteProvider", provider: provider }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Are you sure you want to delete provider ${provider} and all its models?`,
				action: "deleteProvider",
			});
		});
	});
}

function renderModels() {
	const models = state.models.filter((m) => !m.id.startsWith("__provider__")).sort((a, b) => a.id.localeCompare(b.id));
	if (!models.length) {
		modelTableBody.innerHTML = '<tr><td colspan="11" class="no-data">No models</td></tr>';
		return;
	}

	const rows = models
		.map((model) => {
			return `
			<tr data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">
				<td>${model.id}</td>
				<td>${model.owned_by}</td>
				<td>${model.displayName || ""}</td>
				<td>${model.configId || ""}</td>
				<td>${model.context_length || ""}</td>
				<td>${model.max_tokens || model.max_completion_tokens || ""}</td>
				<td>${model.vision ? "True" : ""}</td>
				<td>${model.temperature !== undefined && model.temperature !== null ? model.temperature : ""}</td>
				<td>${model.top_p !== undefined && model.top_p !== null ? model.top_p : ""}</td>
				<td>${model.delay || ""}</td>
				<td class="action-buttons">
					<button class="update-model-btn" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">Edit</button>
					<button class="delete-model-btn danger" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">Delete</button>
				</td>
			</tr>`;
		})
		.join("");

	modelTableBody.innerHTML = rows;

	// Add event listeners for model rows
	document.querySelectorAll(".update-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			// Find the model in state
			const parsedModelId = modelId.includes("::")
				? { baseId: modelId.split("::")[0], configId: modelId.split("::")[1] }
				: { baseId: modelId, configId: null };

			const model = state.models.find(
				(m) =>
					m.id === parsedModelId.baseId &&
					((parsedModelId.configId && m.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !m.configId))
			);

			if (model) {
				// Show the model form in edit mode
				modelFormSection.style.display = "block";
				modelFormTitle.textContent = `Edit Model: ${modelId}`;
				populateModelForm(model);
			}
		});
	});

	document.querySelectorAll(".delete-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const confirmId = "deleteModel_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteModel", modelId: modelId }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `Are you sure you want to delete model ${modelId}?`,
				action: "deleteModel",
			});
		});
	});
}

// Reset model form
function resetModelForm() {
	// Clear any error message
	showModelError("");

	modelIdInput.value = "";
	modelProviderInput.value = "";
	modelDisplayNameInput.value = "";
	modelConfigIdInput.value = "";
	modelBaseUrlInput.value = "";
	modelFamilyInput.value = "";
	modelStatusIconInput.value = "";
	modelContextLengthInput.value = 128000;
	modelMaxTokensInput.value = 4096;
	modelVisionInput.value = "";
	modelStripReminderInstructionsInput.value = "";
	modelApiModeInput.value = "openai";
	modelTemperatureInput.value = "";
	modelTopPInput.value = "";
	modelDelayInput.value = "";
	modelTopKInput.value = "";
	modelMinPInput.value = "";
	modelFrequencyPenaltyInput.value = "";
	modelPresencePenaltyInput.value = "";
	modelRepetitionPenaltyInput.value = "";
	modelReasoningEffortInput.value = "";
	modelEnableThinkingInput.value = "";
	modelThinkingBudgetInput.value = "";
	modelIncludeReasoningInput.value = "";
	modelMaxCompletionTokensInput.value = "";
	modelOptimizationInput.value = "";
	modelReasoningExcludeInput.value = "";
	modelDiskKvCacheInput.value = "";
	modelLlamaSlotTimeoutInput.value = "";
	modelSplitSystemPromptInput.value = "";
	uncheckSupportedEfforts();
	syncReasoningEffortOptions();
	updateOptimizationVisibility();
	modelThinkingTypeInput.value = "";
	modelHeadersInput.value = "";
	modelExtraInput.value = "";
	advancedSettingsContent.style.display = "none";
	toggleAdvancedSettingsBtn.textContent = "Show Advanced Settings";
	// Remove editing attribute
	modelIdInput.removeAttribute("data-editing");
	modelIdInput.removeAttribute("data-original-id");
	modelIdInput.removeAttribute("data-original-configId");
	// disbale fields when form is reset
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
	// Clear dropdown options
	dropdownContent.innerHTML = "";
}

// Collect model form data
function collectModelFormData() {
	const isEditing = modelIdInput.hasAttribute("data-editing");

	return {
		id: modelIdInput.value.trim(),
		owned_by: modelProviderInput.value.trim(),
		displayName: modelDisplayNameInput.value.trim() || undefined,
		configId: modelConfigIdInput.value.trim() || undefined,
		baseUrl: modelBaseUrlInput.value.trim() || undefined,
		family: modelFamilyInput.value.trim() || undefined,
		statusIcon: modelStatusIconInput.value.trim() || undefined,
		context_length: modelContextLengthInput.value ? parseInt(modelContextLengthInput.value) : undefined,
		max_tokens: modelMaxTokensInput.value ? parseInt(modelMaxTokensInput.value) : undefined,
		vision: modelVisionInput.value ? modelVisionInput.value === "true" : undefined,
		apiMode: modelApiModeInput.value || undefined,
		temperature: modelTemperatureInput.value !== "" ? parseFloat(modelTemperatureInput.value) : undefined,
		top_p: modelTopPInput.value !== "" ? parseFloat(modelTopPInput.value) : undefined,
		delay: modelDelayInput.value ? parseInt(modelDelayInput.value) : undefined,
		top_k: modelTopKInput.value ? parseInt(modelTopKInput.value) : undefined,
		min_p: modelMinPInput.value !== "" ? parseFloat(modelMinPInput.value) : undefined,
		frequency_penalty:
			modelFrequencyPenaltyInput.value !== "" ? parseFloat(modelFrequencyPenaltyInput.value) : undefined,
		presence_penalty: modelPresencePenaltyInput.value !== "" ? parseFloat(modelPresencePenaltyInput.value) : undefined,
		repetition_penalty:
			modelRepetitionPenaltyInput.value !== "" ? parseFloat(modelRepetitionPenaltyInput.value) : undefined,
		reasoning_effort: modelReasoningEffortInput.value || undefined,
		optimization: modelOptimizationInput.value || undefined,
		supported_efforts: getSupportedEfforts(),
		enable_thinking: modelEnableThinkingInput.value ? modelEnableThinkingInput.value === "true" : undefined,
		thinking_budget: modelThinkingBudgetInput.value ? parseInt(modelThinkingBudgetInput.value) : undefined,
		include_reasoning_in_request: modelIncludeReasoningInput.value
			? modelIncludeReasoningInput.value === "true"
			: undefined,
		strip_reminder_instructions: modelStripReminderInstructionsInput.value
			? modelStripReminderInstructionsInput.value === "true"
			: undefined,
		disk_kv_cache: modelDiskKvCacheInput.value ? modelDiskKvCacheInput.value === "true" : undefined,
		llama_slot_timeout: modelLlamaSlotTimeoutInput.value
			? parseInt(modelLlamaSlotTimeoutInput.value)
			: undefined,
		split_system_prompt: modelSplitSystemPromptInput.value
			? modelSplitSystemPromptInput.value === "true"
			: undefined,
		max_completion_tokens: modelMaxCompletionTokensInput.value
			? parseInt(modelMaxCompletionTokensInput.value)
			: undefined,
		// Build reasoning configuration object
		reasoning: buildReasoningConfig(),
		// Build thinking configuration object
		thinking: buildThinkingConfig(),
		// Parse headers and extra JSON
		headers: parseJsonField(modelHeadersInput.value),
		extra: parseJsonField(modelExtraInput.value),
		// Include original modelId and configId for update operations
		originalModelId: isEditing ? modelIdInput.getAttribute("data-original-id") : undefined,
		originalConfigId: isEditing ? modelIdInput.getAttribute("data-original-configId") : undefined,
	};
}

// Build reasoning configuration object from form fields.
// Only `exclude` is actively used (the sole OpenRouter-unique parameter);
// effort/budget are reused from the basic settings (reasoning_effort / thinking_budget).
function buildReasoningConfig() {
	const exclude = modelReasoningExcludeInput.value ? modelReasoningExcludeInput.value === "true" : undefined;
	return exclude !== undefined ? { exclude } : undefined;
}

// Read the checked values of the supported_efforts checkbox group (only the 7
// standard values have checkboxes, so unknown values are dropped automatically).
function getSupportedEfforts() {
	const checked = Array.from(supportedEffortsGroup.querySelectorAll("input[type='checkbox']:checked")).map(
		(cb) => cb.value
	);
	return checked.length > 0 ? checked : undefined;
}

// Uncheck every supported_efforts checkbox.
function uncheckSupportedEfforts() {
	supportedEffortsGroup.querySelectorAll("input[type='checkbox']").forEach((cb) => {
		cb.checked = false;
	});
}

// Set the supported_efforts checkboxes from an array of values. Only the 7
// standard values have checkboxes, so unknown values are dropped automatically.
function setSupportedEfforts(values) {
	const set = Array.isArray(values) ? values : [];
	supportedEffortsGroup.querySelectorAll("input[type='checkbox']").forEach((cb) => {
		cb.checked = set.includes(cb.value);
	});
}

// Standard effort values in display order (matches the original dropdown order).
const STANDARD_EFFORT_VALUES = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];
const STANDARD_EFFORT_LABELS = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

// Rebuild the Reasoning Effort dropdown options from the checked
// supported_efforts checkboxes: blank + checked values. When no checkbox is
// checked, fall back to blank + all 7 standard values.
function syncReasoningEffortOptions() {
	const checked = Array.from(supportedEffortsGroup.querySelectorAll("input[type='checkbox']:checked")).map(
		(cb) => cb.value
	);
	const values = checked.length > 0 ? checked : STANDARD_EFFORT_VALUES;
	const current = modelReasoningEffortInput.value;
	modelReasoningEffortInput.innerHTML = "";
	const blank = document.createElement("option");
	blank.value = "";
	modelReasoningEffortInput.appendChild(blank);
	values.forEach((v) => {
		const opt = document.createElement("option");
		opt.value = v;
		opt.textContent = STANDARD_EFFORT_LABELS[v] || v;
		modelReasoningEffortInput.appendChild(opt);
	});
	// Preserve the current selection only if it is still a valid option
	modelReasoningEffortInput.value = values.includes(current) ? current : "";
}

// Show/hide the backend-specific fields based on the selected optimization
// type: "Reasoning Exclude" is OpenRouter-only, "Disk KV Cache" and
// "Slot Request Timeout" are llama.cpp-only.
function updateOptimizationVisibility() {
	const isOpenRouter = modelOptimizationInput.value === "openrouter";
	modelReasoningExcludeField.style.display = isOpenRouter ? "" : "none";
	const isLlamaCpp = modelOptimizationInput.value === "llama.cpp";
	modelDiskKvCacheField.style.display = isLlamaCpp ? "" : "none";
	modelLlamaSlotTimeoutField.style.display = isLlamaCpp ? "" : "none";
	modelSplitSystemPromptField.style.display = isLlamaCpp ? "" : "none";
}

// Build thinking configuration object from form fields
function buildThinkingConfig() {
	const type = modelThinkingTypeInput.value || undefined;

	if (type !== undefined) {
		return { type };
	}
	return undefined;
}

// Parse JSON field, return undefined if empty or invalid
function parseJsonField(value) {
	if (!value || value.trim() === "") {
		return undefined;
	}
	try {
		return JSON.parse(value.trim());
	} catch (error) {
		// ignore invalid JSON
		return undefined;
	}
}

// Show error message in the UI
function showModelError(message) {
	if (modelErrorElement) {
		modelErrorElement.textContent = message;
		modelErrorElement.style.display = message ? "block" : "none";

		// Scroll to error message if it's visible
		if (message) {
			modelErrorElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}
}

// Validate model data
function validateModelData(modelData) {
	// Clear any previous error
	showModelError("");

	if (!modelData.id) {
		showModelError("Model ID is required.");
		return false;
	}
	if (!modelData.owned_by) {
		showModelError("Provider ID is required.");
		return false;
	}

	// Validate modelId and configId Uniqueness
	const isEditing = modelIdInput.hasAttribute("data-editing");
	const hasDuplicate = state.models
		.filter((m) => {
			if (isEditing) {
				const isOrigin =
					m.id === modelData.originalModelId &&
					((modelData.originalConfigId && m.configId === modelData.originalConfigId) ||
						(!modelData.originalConfigId && !m.configId));
				return !isOrigin;
			}
			return true;
		})
		.some((m) => {
			return (
				m.id === modelData.id &&
				((modelData.configId && m.configId === modelData.configId) || (!modelData.configId && !m.configId))
			);
		});

	if (hasDuplicate) {
		showModelError(
			`A model with ID="${modelData.id}"${
				modelData.configId ? ` and Config ID="${modelData.configId}"` : ""
			} already exists. Model ID and Config ID combination must be unique.`
		);
		return false;
	}

	// Validate numeric fields if provided
	if (modelData.context_length !== undefined && (isNaN(modelData.context_length) || modelData.context_length <= 0)) {
		showModelError("Context Length must be a positive number.");
		return false;
	}
	if (modelData.max_tokens !== undefined && (isNaN(modelData.max_tokens) || modelData.max_tokens <= 0)) {
		showModelError("Max Tokens must be a positive number.");
		return false;
	}
	if (
		modelData.max_completion_tokens !== undefined &&
		(isNaN(modelData.max_completion_tokens) || modelData.max_completion_tokens <= 0)
	) {
		showModelError("Max Completion Tokens must be a positive number.");
		return false;
	}
	// Prevent both max_tokens and max_completion_tokens from being set simultaneously
	if (modelData.max_tokens !== undefined && modelData.max_completion_tokens !== undefined) {
		showModelError("Cannot set both 'max_tokens' and 'max_completion_tokens'. Use 'max_completion_tokens' only.");
		return false;
	}
	if (
		modelData.temperature !== undefined &&
		(isNaN(modelData.temperature) || modelData.temperature < 0 || modelData.temperature > 2)
	) {
		showModelError("Temperature must be between 0 and 2.");
		return false;
	}
	if (modelData.top_p !== undefined && (isNaN(modelData.top_p) || modelData.top_p < 0 || modelData.top_p > 1)) {
		showModelError("Top P must be between 0 and 1.");
		return false;
	}
	if (modelData.delay !== undefined && (isNaN(modelData.delay) || modelData.delay < 0)) {
		showModelError("Delay must be a non-negative number.");
		return false;
	}

	// Validate JSON fields
	if (modelData.headers && typeof modelData.headers !== "object") {
		showModelError("Custom Headers must be a valid JSON object.");
		return false;
	}
	if (modelData.extra && typeof modelData.extra !== "object") {
		showModelError("Extra Parameters must be a valid JSON object.");
		return false;
	}

	return true;
}

// Heuristically infer the VS Code Copilot "family" string from a model id.
// Order matters: more specific patterns first, then fall back to broad vendor names.
// Only fills in when the family field is currently empty, so the user's manual
// edits are preserved.
function inferModelFamily(modelId) {
	if (!modelId || typeof modelId !== "string") {
		return undefined;
	}
	const id = modelId.toLowerCase();

	// --- Anthropic Claude (specific models first, then broad family) ---
	if (id.includes("claude")) {
		// Specific Claude 4.x / 3.x variants that Copilot recognises individually
		const claudeSpecificMatch = id.match(/claude-(sonnet|haiku|opus)-(\d+-\d+)/);
		if (claudeSpecificMatch) {
			return `claude-${claudeSpecificMatch[1]}-${claudeSpecificMatch[2]}`;
		}
		// Match Claude 4 / 3 / 3.5 / 3.7 short tags (e.g. claude-4-sonnet, claude-3-5-haiku)
		const claudeShortMatch = id.match(/claude-(\d+(?:-\d+)?)-(sonnet|haiku|opus)/);
		if (claudeShortMatch) {
			return `claude-${claudeShortMatch[1]}-${claudeShortMatch[2]}`;
		}
		return "claude";
	}

	// --- Google Gemini (specific then broad) ---
	if (id.includes("gemini")) {
		const geminiSpecificMatch = id.match(/gemini-(\d+(?:\.\d+)?)-(pro|flash|ultra|nano)/);
		if (geminiSpecificMatch) {
			return `gemini-${geminiSpecificMatch[1]}-${geminiSpecificMatch[2]}`;
		}
		return "gemini";
	}

	// --- xAI Grok ---
	// Copilot recognises 'grok-code' specifically
	if (id.includes("grok")) {
		return "grok-code";
	}

	// --- OpenAI (GPT family + o-series) ---
	const openaiVariant = inferOpenAIVariant(id);
	if (openaiVariant) {
		return openaiVariant;
	}

	return undefined;
}

// Internal helper: return the OpenAI GPT/o-series variant string (e.g. "gpt-5",
// "gpt-5-codex", "o3-mini") if `id` matches, else undefined. Shared by
// `inferModelFamily` (for the `family` field) and `inferStatusIcon` (for the
// `statusIcon` field, where any OpenAI model collapses to "openai").
function inferOpenAIVariant(id) {
	if (!id) {
		return undefined;
	}
	// OpenAI o-series (o1, o1-preview, o3-mini, o4-mini, o5, ...)
	const oSeriesMatch = id.match(/\b(o\d+(?:-(?:mini|preview))?)\b/);
	if (oSeriesMatch) {
		return oSeriesMatch[1];
	}

	// OpenAI GPT family (specific variants first, then broad 'gpt')
	// gpt-N-codex variants (Copilot recognises gpt-N-codex via startsWith('gpt-') && includes('-codex'))
	if (/gpt-\d.*codex/.test(id)) {
		const codexMatch = id.match(/gpt-(\d+)-codex/);
		if (codexMatch) {
			return `gpt-${codexMatch[1]}-codex`;
		}
		return "gpt-5-codex";
	}
	// Pattern A: gpt-N(.M) + up to 3 hyphenated suffix segments (gpt-3.5-turbo-instruct, gpt-5-mini-preview...)
	// Stop before a YYYY-MM-DD date suffix so gpt-4o-2024-08-06 -> gpt-4o.
	const gptHyphenMatch = id.match(/\b(gpt-\d+(?:\.\d+)?(?:[-][a-z0-9]+){0,3})(?=-20\d{2}(?:-\d{2}){0,2}\b|\b)/);
	if (gptHyphenMatch && gptHyphenMatch[1] !== "gpt") {
		return gptHyphenMatch[1];
	}
	// Pattern B: gpt-N(.M) followed by a single alpha letter (gpt-4o, gpt-4oi) + up to 2 [-suffix] segments
	const gptAlphaMatch = id.match(/\b(gpt-\d+(?:\.\d+)?[a-z](?:[-][a-z0-9]+){0,2})(?=-20\d{2}(?:-\d{2}){0,2}\b|\b)/);
	if (gptAlphaMatch) {
		return gptAlphaMatch[1];
	}
	// Pattern C: plain gpt-N(.M)
	const gptBaseMatch = id.match(/\bgpt-\d+(?:\.\d+)?/);
	if (gptBaseMatch && id.includes("gpt")) {
		return gptBaseMatch[0];
	}

	return undefined;
}

// Heuristically infer a VS Code codicon id ("statusIcon") from a model id.
// Mirrors `inferModelFamily`: only recognised vendors map to a codicon; unknown
// vendors return undefined so the field stays empty (no `robot` fallback).
function inferStatusIcon(modelId) {
	if (!modelId || typeof modelId !== "string") {
		return undefined;
	}
	const id = modelId.toLowerCase();

	// --- Anthropic Claude (the codicon library only has a single "claude" id) ---
	if (id.includes("claude")) {
		return "claude";
	}

	// --- Google Gemini ---
	if (id.includes("gemini")) {
		return "google-gemini";
	}

	// --- OpenAI (GPT family + o-series) — share the helper with `inferModelFamily` ---
	if (inferOpenAIVariant(id)) {
		return "openai";
	}

	// --- xAI Grok ---
	if (id.includes("grok")) {
		return "xai";
	}

	// --- Moonshot Kimi ---
	if (id.includes("kimi") || id.includes("moonshot")) {
		return "kimi";
	}

	// Unrecognised vendors stay empty — matches `family`'s behavior (no
	// forced fallback, no `robot` default).
	return undefined;
}

// Auto-fill the family input from a model id.
//   force=false (default): respect user's manual edits — only fill when the
//     field is empty. Used while the user is typing in the model id box.
//   force=true: unconditionally overwrite the family. Used when the user
//     selects a model from the autocomplete dropdown, since picking an entry
//     from the suggestion list is a deliberate confirmation rather than a
//     free-form edit (e.g. typing "gpt5" auto-fills "gpt", then choosing
//     "gpt-5.5-pro" from the dropdown should refresh to "gpt-5.5-pro").
function autoFillFamilyFromModelId(modelId, force) {
	if (!force && modelFamilyInput.value && modelFamilyInput.value.trim() !== "") {
		return; // respect user's manual input
	}
	const family = inferModelFamily(modelId);
	if (family) {
		modelFamilyInput.value = family;
	}
}

// Auto-fill the statusIcon input from a model id. Same contract as
// `autoFillFamilyFromModelId`:
//   force=false: respect user's manual edits, only fill when empty.
//   force=true: unconditionally overwrite (used for dropdown selections).
function autoFillStatusIconFromModelId(modelId, force) {
	if (!force && modelStatusIconInput.value.trim() !== "") {
		return; // respect user's manual input
	}
	const statusIcon = inferStatusIcon(modelId);
	if (statusIcon) {
		modelStatusIconInput.value = statusIcon;
	}
}

// Dispatcher: re-run both auto-fill helpers against the same model id with the
// same `force` flag. Keeps the two heuristics in lockstep (one call site per
// trigger — model id input vs. dropdown selection) and avoids the two fields
// drifting apart.
function autoFillDerivedFieldsFromModelId(modelId, force) {
	autoFillFamilyFromModelId(modelId, force);
	autoFillStatusIconFromModelId(modelId, force);
}

// Function to populate the model ID datalist
function populateModelIdDropdown(models) {
	const modelsArray = Array.from(models || []);

	// Clear existing options
	dropdownContent.innerHTML = "";

	if (!modelsArray.length) {
		dropdownHeader.textContent = "No models available";
		return;
	}

	dropdownHeader.textContent = `Select Model (${modelsArray.length} available)`;

	// Create option elements
	modelsArray.forEach((model) => {
		const option = document.createElement("div");
		option.className = "dropdown-option";
		option.textContent = model.id;
		option.dataset.modelId = model.id;

		// Add click event
		option.addEventListener("click", () => {
			modelIdInput.value = model.id;
			// Auto-fill Context Length from llama.cpp meta.n_ctx or OpenRouter context_length (no-op if absent)
			const nCtx = model.meta && model.meta.n_ctx;
			const ctxLen = model.context_length;
			// llama.cpp exposes context length via meta.n_ctx
			if (typeof nCtx === "number" && Number.isFinite(nCtx) && nCtx > 0) {
				modelContextLengthInput.value = String(nCtx);
			} else if (typeof ctxLen === "number" && Number.isFinite(ctxLen) && ctxLen > 0) {
				// OpenRouter exposes context length via the top-level context_length field
				modelContextLengthInput.value = String(ctxLen);
			}
			// Auto-fill Friendly Name from OpenRouter model name (Feature 1)
			if (typeof model.name === "string" && model.name) {
				modelDisplayNameInput.value = model.name;
			}
			// Auto-fill optimization type from backend signals:
			//   meta.n_ctx present -> llama.cpp ; supported_parameters (array) -> OpenRouter
			// Reset first so a model with neither signal doesn't keep the previously
			// selected model's optimization type.
			modelOptimizationInput.value = "";
			if (typeof nCtx === "number" && Number.isFinite(nCtx) && nCtx > 0) {
				modelOptimizationInput.value = "llama.cpp";
			} else if (Array.isArray(model.supported_parameters)) {
				modelOptimizationInput.value = "openrouter";
			}
			// Auto-fill supported_efforts from OpenRouter reasoning metadata (Feature 2)
			setSupportedEfforts(model.reasoning && model.reasoning.supported_efforts);
			// Auto-fill default reasoning effort from OpenRouter reasoning.default_effort (Feature 3)
			if (model.reasoning && typeof model.reasoning.default_effort === "string") {
				modelReasoningEffortInput.value = model.reasoning.default_effort;
			}
			syncReasoningEffortOptions();
			updateOptimizationVisibility();
			// Auto-fill Supports Vision from architecture.input_modalities (llama.cpp & OpenRouter)
			const inputModalities = model.architecture && model.architecture.input_modalities;
			if (Array.isArray(inputModalities)) {
				modelVisionInput.value = inputModalities.includes("image") ? "true" : "false";
			}
			// Heuristic auto-fill for Model Family based on the model id
			// Force overwrite on dropdown selection: picking a suggestion from the
			// autocomplete list is an explicit confirmation, not a free-form edit,
			// so it should refresh a value that may have been filled from a
			// partial earlier match (e.g. user typed "gpt5" -> auto-filled "gpt",
			// then picks "gpt-5.5-pro" -> should refresh to "gpt-5.5-pro").
			// The same `force=true` is forwarded to both auto-fill helpers (family
			// and statusIcon) so the two fields stay in sync.
			autoFillDerivedFieldsFromModelId(model.id, true);
			hideDropdown();

			// Remove selection from all options
			dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
				opt.classList.remove("selected");
			});

			// Add selection to clicked option
			option.classList.add("selected");
		});

		dropdownContent.appendChild(option);
	});
}

// Function to populate the commit model dropdown
function populateCommitModelDropdown() {
	// Clear existing options except the first "None" option
	while (commitModelInput.children.length > 1) {
		commitModelInput.removeChild(commitModelInput.lastChild);
	}

	// Filter models that support commit generation (openai, openai-responses, anthropic, ollama apiMode)
	const commitCompatibleModels = state.models
		.filter((model) => {
			const apiMode = model.apiMode || "openai";
			return apiMode !== "gemini" && !model.id.startsWith("__provider__");
		})
		.sort((a, b) => a.id.localeCompare(b.id));

	// Add options for compatible models
	commitCompatibleModels.forEach((model) => {
		const option = document.createElement("option");
		const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
		option.value = fullModelId;
		option.textContent = model.displayName || fullModelId;
		commitModelInput.appendChild(option);
	});
}

// Dropdown visibility functions
function showDropdown() {
	if (dropdownContent.children.length > 0) {
		modelIdDropdown.classList.add("show");
	}
}

function hideDropdown() {
	modelIdDropdown.classList.remove("show");
}

function toggleDropdown() {
	if (modelIdDropdown.classList.contains("show")) {
		hideDropdown();
	} else {
		showDropdown();
	}
}

// Populate model form with existing data
function populateModelForm(model) {
	// Clear any error message
	showModelError("");

	// Store the original modelId and configId for update operations
	modelIdInput.setAttribute("data-original-id", model.id || "");
	modelIdInput.setAttribute("data-original-configId", model.configId || "");

	modelIdInput.value = model.id || "";

	// Ensure the provider is in the dropdown options
	const currentProvider = model.owned_by || "";
	const providerExists = Array.from(modelProviderInput.options).some((option) => option.value === currentProvider);

	if (!providerExists && currentProvider) {
		// Add the provider to the dropdown if it doesn't exist
		const newOption = document.createElement("option");
		newOption.value = currentProvider;
		newOption.textContent = currentProvider;
		modelProviderInput.appendChild(newOption);
	}

	const providerInfo = state.providerInfo[currentProvider];
	const fetchBaseUrl = model.baseUrl || state.baseUrl;
	const fetchApiKey = state.providerKeys[currentProvider] || state.apiKey;
	const fetchApiMode = providerInfo?.apiMode || model.apiMode || modelApiModeInput.value || "openai";

	// Request to fetch remote models for the selected provider
	vscode.postMessage({
		type: "fetchModels",
		baseUrl: fetchBaseUrl,
		apiKey: fetchApiKey,
		apiMode: fetchApiMode,
		headers: model.headers,
	});

	modelProviderInput.value = currentProvider;
	modelDisplayNameInput.value = model.displayName || "";
	modelConfigIdInput.value = model.configId || "";
	modelBaseUrlInput.value = model.baseUrl || "";
	modelFamilyInput.value = model.family || "";
	modelStatusIconInput.value = model.statusIcon || "";
	modelContextLengthInput.value = model.context_length || "";
	modelMaxTokensInput.value = model.max_tokens || "";
	modelVisionInput.value = model.vision !== undefined ? String(model.vision) : "";
	modelApiModeInput.value = model.apiMode || "openai";
	modelTemperatureInput.value = model.temperature !== undefined && model.temperature !== null ? model.temperature : "";
	modelTopPInput.value = model.top_p !== undefined && model.top_p !== null ? model.top_p : "";
	modelDelayInput.value = model.delay || "";
	modelTopKInput.value = model.top_k || "";
	modelMinPInput.value = model.min_p || "";
	modelFrequencyPenaltyInput.value = model.frequency_penalty || "";
	modelPresencePenaltyInput.value = model.presence_penalty || "";
	modelRepetitionPenaltyInput.value = model.repetition_penalty || "";
	modelReasoningEffortInput.value = model.reasoning_effort || "";
	modelEnableThinkingInput.value = model.enable_thinking !== undefined ? String(model.enable_thinking) : "";
	modelThinkingBudgetInput.value = model.thinking_budget || "";
	modelIncludeReasoningInput.value =
		model.include_reasoning_in_request !== undefined ? String(model.include_reasoning_in_request) : "";
	modelStripReminderInstructionsInput.value =
		model.strip_reminder_instructions !== undefined ? String(model.strip_reminder_instructions) : "";
	modelMaxCompletionTokensInput.value = model.max_completion_tokens || "";
	// Populate dedicated optimization + supported efforts
	modelOptimizationInput.value = model.optimization || "";
	modelDiskKvCacheInput.value = model.disk_kv_cache !== undefined ? String(model.disk_kv_cache) : "";
	modelLlamaSlotTimeoutInput.value = model.llama_slot_timeout || "";
	modelSplitSystemPromptInput.value = model.split_system_prompt !== undefined ? String(model.split_system_prompt) : "";
	setSupportedEfforts(model.supported_efforts);
	syncReasoningEffortOptions();
	// Populate reasoning configuration (only `exclude` is actively used)
	if (model.reasoning) {
		modelReasoningExcludeInput.value = model.reasoning.exclude !== undefined ? String(model.reasoning.exclude) : "";
	}
	updateOptimizationVisibility();
	// Populate thinking configuration
	if (model.thinking) {
		modelThinkingTypeInput.value = model.thinking.type || "";
	}
	// Populate headers and extra
	modelHeadersInput.value = model.headers ? JSON.stringify(model.headers, null, 2) : "";
	modelExtraInput.value = model.extra ? JSON.stringify(model.extra, null, 2) : "";
	// Mark that we're in editing mode by setting an attribute
	modelIdInput.setAttribute("data-editing", "true");
	// Disable BaseURL and apiMode fields when editing
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
}

// Initialize dropdown event listeners
function initDropdownEvents() {
	// Show dropdown on focus
	modelIdInput.addEventListener("focus", () => {
		if (dropdownContent.children.length > 0) {
			showDropdown();
		}
	});

	// Hide dropdown when clicking outside
	document.addEventListener("click", (event) => {
		if (!modelIdDropdown.contains(event.target) && event.target !== modelIdInput) {
			hideDropdown();
		}
	});

	// Handle keyboard navigation
	modelIdInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			hideDropdown();
		} else if (event.key === "ArrowDown" && modelIdDropdown.classList.contains("show")) {
			event.preventDefault();
			const options = dropdownContent.querySelectorAll(".dropdown-option");
			if (options.length > 0) {
				const firstOption = options[0];
				firstOption.focus();
				firstOption.classList.add("selected");
			}
		}
	});

	// Allow user to type freely
	modelIdInput.addEventListener("input", () => {
		// Clear selection when user types
		dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
			opt.classList.remove("selected");
		});

		// Filter options based on input
		const searchTerm = modelIdInput.value.toLowerCase();
		const options = dropdownContent.querySelectorAll(".dropdown-option");

		options.forEach((option) => {
			const modelId = option.dataset.modelId.toLowerCase();
			if (modelId.includes(searchTerm)) {
				option.style.display = "block";
			} else {
				option.style.display = "none";
			}
		});

		// Update header with filtered count
		const visibleCount = Array.from(options).filter((opt) => opt.style.display !== "none").length;
		dropdownHeader.textContent = `Select Model (${visibleCount} matching)`;

		// Heuristic auto-fill for derived fields (Model Family + Status Icon)
		// from the typed model id. No-op when the user has already typed a
		// value into either field.
		autoFillDerivedFieldsFromModelId(modelIdInput.value, false);
	});
}

// Show/hide OpenRouter-only fields when the optimization type changes
modelOptimizationInput.addEventListener("change", updateOptimizationVisibility);
supportedEffortsGroup.addEventListener("change", syncReasoningEffortOptions);
// Initialize dropdown events
initDropdownEvents();

vscode.postMessage({ type: "requestInit" });
