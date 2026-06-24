import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretMeta } from "../../lib/types";

vi.mock("../../lib/ipc", () => ({
	secrets: {
		list: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	},
}));

import { secrets as secretsApi } from "../../lib/ipc";
import { useSecretsStore } from "../secretsStore";

const api = vi.mocked(secretsApi);

function meta(id: string, name: string): SecretMeta {
	return { id, name, description: "", createdAt: 0, updatedAt: 0 };
}

function resetStore() {
	useSecretsStore.setState({ secrets: [], loaded: false, loading: false });
}

beforeEach(() => {
	resetStore();
	vi.clearAllMocks();
	api.list.mockResolvedValue([]);
});

describe("secretsStore", () => {
	it("load fetches once and sets loaded", async () => {
		api.list.mockResolvedValue([meta("1", "API_KEY")]);
		await useSecretsStore.getState().load();
		expect(useSecretsStore.getState().secrets).toEqual([meta("1", "API_KEY")]);
		expect(useSecretsStore.getState().loaded).toBe(true);

		// Second load is a no-op (once-guard).
		await useSecretsStore.getState().load();
		expect(api.list).toHaveBeenCalledTimes(1);
	});

	it("reload re-fetches even after loaded", async () => {
		api.list.mockResolvedValue([]);
		await useSecretsStore.getState().load();
		api.list.mockResolvedValue([meta("2", "TOKEN")]);
		await useSecretsStore.getState().reload();
		expect(api.list).toHaveBeenCalledTimes(2);
		expect(useSecretsStore.getState().secrets).toEqual([meta("2", "TOKEN")]);
	});

	it("create calls the API then refreshes", async () => {
		api.create.mockResolvedValue(meta("3", "DB_PASS"));
		api.list.mockResolvedValue([meta("3", "DB_PASS")]);
		await useSecretsStore.getState().create("DB_PASS", "s3cr3t", "prod db");
		expect(api.create).toHaveBeenCalledWith("DB_PASS", "s3cr3t", "prod db");
		expect(useSecretsStore.getState().secrets).toEqual([meta("3", "DB_PASS")]);
	});

	it("update forwards only the provided fields", async () => {
		api.update.mockResolvedValue(meta("4", "RENAMED"));
		api.list.mockResolvedValue([meta("4", "RENAMED")]);
		await useSecretsStore.getState().update("4", { name: "RENAMED" });
		expect(api.update).toHaveBeenCalledWith("4", { name: "RENAMED" });
	});

	it("remove deletes then refreshes", async () => {
		api.delete.mockResolvedValue(undefined);
		api.list.mockResolvedValue([]);
		await useSecretsStore.getState().remove("5");
		expect(api.delete).toHaveBeenCalledWith("5");
		expect(useSecretsStore.getState().secrets).toEqual([]);
	});
});
