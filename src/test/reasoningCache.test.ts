import * as assert from "assert";
import * as vscode from "vscode";
import { CommonApi } from "../commonApi";

suite("reasoningCache migration", () => {
	// Clear the static memento between tests so state doesn't leak.
	// `teardown` is the tdd-ui equivalent of `afterEach` (the suite runs under
	// mocha's tdd interface, where `afterEach` is not defined).
	teardown(() => {
		(CommonApi as unknown as { _memento: vscode.Memento | null })._memento = null;
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

	test("rewrites old convId#modelId#index keys to convId#index on hydrate", async () => {
		const initial: Record<string, string> = {
			"abc123#deepseek-chat#4": "reasoning for turn 4",
			"abc123#gpt-4o#10": "reasoning for turn 10",
			// model id itself containing '#' -> convId#model#id#index (4 parts)
			"def456#my#weird#model#2": "reasoning with hash in model id",
		};
		const { memento, persisted } = recordingMemento(initial);
		CommonApi.setMemento(memento);

		CommonApi.hydrate();
		await CommonApi.flushNow();

		assert.strictEqual(persisted["abc123#4"], "reasoning for turn 4");
		assert.strictEqual(persisted["abc123#10"], "reasoning for turn 10");
		assert.strictEqual(persisted["def456#2"], "reasoning with hash in model id");
		// No leftover model-scoped keys should survive.
		assert.strictEqual(persisted["abc123#deepseek-chat#4"], undefined);
		assert.strictEqual(persisted["def456#my#weird#model#2"], undefined);
	});

	test("leaves already-migrated two-part keys untouched", async () => {
		const initial: Record<string, string> = {
			"abc123#4": "reasoning for turn 4",
			"ghi789#7": "already migrated key",
		};
		const { memento, persisted } = recordingMemento(initial);
		CommonApi.setMemento(memento);

		CommonApi.hydrate();
		await CommonApi.flushNow();

		assert.strictEqual(persisted["abc123#4"], "reasoning for turn 4");
		assert.strictEqual(persisted["ghi789#7"], "already migrated key");
	});
});
