import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/ipc", () => ({
	env: {
		list: vi.fn(),
		createBundle: vi.fn(),
		renameBundle: vi.fn(),
		setInjected: vi.fn(),
		deleteBundle: vi.fn(),
		upsert: vi.fn(),
		upsertMany: vi.fn(),
		remove: vi.fn(),
		reveal: vi.fn(),
		reorder: vi.fn(),
		retryKey: vi.fn(),
	},
}));

import { env } from "../../lib/ipc";
import { useWorkspaceEnvStore } from "../workspaceEnvStore";

const WS = "ws-1";

const bundle = (name: string, injected = false) => ({
	id: `b-${name}`,
	workspaceId: WS,
	name,
	injected,
	position: 0,
	varCount: 0,
	inherited: false,
});

const variable = (name: string, overrides = {}) => ({
	id: `v-${name}`,
	bundleId: "b-default",
	name,
	byteLen: 8,
	position: 0,
	inherited: false,
	undecryptable: false,
	updatedAt: 0,
	...overrides,
});

function listResult(overrides = {}) {
	return {
		bundles: [bundle("default", true)],
		selectedBundle: "default",
		vars: [variable("TOKEN")],
		keyError: null,
		bytesUsed: 13,
		bytesBudget: 65536,
		...overrides,
	};
}

describe("workspaceEnvStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceEnvStore.setState({
			bundles: [],
			vars: [],
			selectedBundle: "default",
			keyError: null,
			bytesUsed: 0,
			bytesBudget: 0,
			loading: false,
			error: null,
			revealed: null,
			dirtyInjected: new Set<string>(),
		});
		// Explicit defaults, not just clearAllMocks: that clears recorded calls
		// but NOT implementations, so a mockRejectedValue set by one test would
		// otherwise leak into every test after it.
		vi.mocked(env.list).mockResolvedValue(listResult());
		vi.mocked(env.upsert).mockResolvedValue(variable("A"));
		vi.mocked(env.upsertMany).mockResolvedValue([variable("A")]);
		vi.mocked(env.remove).mockResolvedValue(undefined);
		vi.mocked(env.reveal).mockResolvedValue("");
		vi.mocked(env.createBundle).mockResolvedValue(bundle("production"));
		vi.mocked(env.renameBundle).mockResolvedValue(undefined);
		vi.mocked(env.setInjected).mockResolvedValue(undefined);
		vi.mocked(env.deleteBundle).mockResolvedValue(undefined);
		vi.mocked(env.reorder).mockResolvedValue(undefined);
		vi.mocked(env.retryKey).mockResolvedValue(true);
	});

	describe("load", () => {
		it("populates bundles, vars and budget", async () => {
			await useWorkspaceEnvStore.getState().load(WS, null);
			const s = useWorkspaceEnvStore.getState();
			expect(s.bundles).toHaveLength(1);
			expect(s.vars[0].name).toBe("TOKEN");
			expect(s.bytesBudget).toBe(65536);
			expect(s.keyError).toBeNull();
			expect(s.loading).toBe(false);
		});

		it("surfaces a key error without throwing", async () => {
			vi.mocked(env.list).mockResolvedValue(
				listResult({ keyError: "credential store unavailable" }),
			);
			await useWorkspaceEnvStore.getState().load(WS, null);
			expect(useWorkspaceEnvStore.getState().keyError).toBe(
				"credential store unavailable",
			);
		});

		it("records an IPC failure as an error and stops loading", async () => {
			vi.mocked(env.list).mockRejectedValue("boom");
			await useWorkspaceEnvStore.getState().load(WS, null);
			const s = useWorkspaceEnvStore.getState();
			expect(s.error).toBe("boom");
			expect(s.loading).toBe(false);
		});

		it("passes the inherit-from workspace through", async () => {
			await useWorkspaceEnvStore.getState().load(WS, "ws-main");
			expect(env.list).toHaveBeenCalledWith(WS, "ws-main", null);
		});
	});

	describe("reveal", () => {
		it("fills the single slot", async () => {
			vi.mocked(env.reveal).mockResolvedValue("secret-value");
			await useWorkspaceEnvStore
				.getState()
				.reveal(WS, null, "default", "TOKEN");
			expect(useWorkspaceEnvStore.getState().revealed).toEqual({
				workspaceId: WS,
				bundle: "default",
				name: "TOKEN",
				value: "secret-value",
			});
		});

		// The invariant: at most one plaintext value is ever held.
		it("revealing a second variable replaces the first", async () => {
			vi.mocked(env.reveal).mockResolvedValueOnce("first");
			await useWorkspaceEnvStore.getState().reveal(WS, null, "default", "A");
			vi.mocked(env.reveal).mockResolvedValueOnce("second");
			await useWorkspaceEnvStore.getState().reveal(WS, null, "default", "B");

			const revealed = useWorkspaceEnvStore.getState().revealed;
			expect(revealed?.name).toBe("B");
			expect(revealed?.value).toBe("second");
		});

		it("clearRevealed empties the slot", async () => {
			vi.mocked(env.reveal).mockResolvedValue("x");
			await useWorkspaceEnvStore.getState().reveal(WS, null, "default", "A");
			useWorkspaceEnvStore.getState().clearRevealed();
			expect(useWorkspaceEnvStore.getState().revealed).toBeNull();
		});

		it("records a failure instead of leaving a stale value", async () => {
			vi.mocked(env.reveal).mockRejectedValue("denied");
			await useWorkspaceEnvStore.getState().reveal(WS, null, "default", "A");
			const s = useWorkspaceEnvStore.getState();
			expect(s.revealed).toBeNull();
			expect(s.error).toBe("denied");
		});
	});

	describe("mutations", () => {
		it("upsert writes, reloads and reports success", async () => {
			const ok = await useWorkspaceEnvStore
				.getState()
				.upsert(WS, null, "default", "A", "1");
			expect(ok).toBe(true);
			expect(env.upsert).toHaveBeenCalledWith(WS, "default", "A", "1");
			expect(env.list).toHaveBeenCalled();
		});

		it("upsert reports a rejected name without throwing", async () => {
			vi.mocked(env.upsert).mockRejectedValue("'1BAD' is not a valid name");
			const ok = await useWorkspaceEnvStore
				.getState()
				.upsert(WS, null, "default", "1BAD", "1");
			expect(ok).toBe(false);
			expect(useWorkspaceEnvStore.getState().error).toContain("not a valid");
		});

		it("importMany forwards every entry", async () => {
			const entries = [
				{ name: "A", value: "1" },
				{ name: "B", value: "2" },
			];
			await useWorkspaceEnvStore
				.getState()
				.importMany(WS, null, "default", entries);
			expect(env.upsertMany).toHaveBeenCalledWith(WS, "default", entries);
		});

		it("remove drops the revealed value", async () => {
			vi.mocked(env.reveal).mockResolvedValue("x");
			await useWorkspaceEnvStore
				.getState()
				.reveal(WS, null, "default", "TOKEN");
			await useWorkspaceEnvStore
				.getState()
				.remove(WS, null, "default", "TOKEN");
			expect(useWorkspaceEnvStore.getState().revealed).toBeNull();
		});
	});

	describe("dirty tracking", () => {
		// Only the injected bundle changes what a running terminal would see.
		it("marks the workspace dirty when the injected bundle changes", async () => {
			await useWorkspaceEnvStore.getState().load(WS, null);
			await useWorkspaceEnvStore
				.getState()
				.upsert(WS, null, "default", "A", "1");
			expect(useWorkspaceEnvStore.getState().dirtyInjected.has(WS)).toBe(true);
		});

		it("does not mark dirty for an on-demand bundle", async () => {
			vi.mocked(env.list).mockResolvedValue(
				listResult({
					bundles: [bundle("default", true), bundle("production")],
					selectedBundle: "production",
				}),
			);
			await useWorkspaceEnvStore.getState().load(WS, null, "production");
			await useWorkspaceEnvStore
				.getState()
				.upsert(WS, null, "production", "A", "1");
			expect(useWorkspaceEnvStore.getState().dirtyInjected.has(WS)).toBe(false);
		});

		it("switching the injected bundle marks dirty", async () => {
			await useWorkspaceEnvStore.getState().load(WS, null);
			await useWorkspaceEnvStore.getState().setInjected(WS, null, "production");
			expect(useWorkspaceEnvStore.getState().dirtyInjected.has(WS)).toBe(true);
		});

		it("clearInjectedDirty removes only that workspace", async () => {
			const store = useWorkspaceEnvStore.getState();
			store.markInjectedDirty(WS);
			store.markInjectedDirty("ws-2");
			store.clearInjectedDirty(WS);
			const dirty = useWorkspaceEnvStore.getState().dirtyInjected;
			expect(dirty.has(WS)).toBe(false);
			expect(dirty.has("ws-2")).toBe(true);
		});
	});

	describe("retryKey", () => {
		it("re-reads the credential store and reloads", async () => {
			vi.mocked(env.list).mockResolvedValue(listResult({ keyError: "locked" }));
			await useWorkspaceEnvStore.getState().load(WS, null);
			expect(useWorkspaceEnvStore.getState().keyError).toBe("locked");

			vi.mocked(env.retryKey).mockResolvedValue(true);
			vi.mocked(env.list).mockResolvedValue(listResult());
			await useWorkspaceEnvStore.getState().retryKey(WS, null);

			expect(env.retryKey).toHaveBeenCalled();
			expect(useWorkspaceEnvStore.getState().keyError).toBeNull();
		});
	});

	describe("selectBundle", () => {
		it("drops the revealed value when switching bundle", async () => {
			vi.mocked(env.reveal).mockResolvedValue("x");
			await useWorkspaceEnvStore.getState().reveal(WS, null, "default", "A");
			await useWorkspaceEnvStore
				.getState()
				.selectBundle(WS, null, "production");
			expect(useWorkspaceEnvStore.getState().revealed).toBeNull();
		});
	});
});
