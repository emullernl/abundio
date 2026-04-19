import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
	devEnvironments: {
		list: vi.fn(),
		launch: vi.fn(),
	},
}));

import { devEnvironments as devEnvApi } from "../../lib/ipc";
import type { DetectedDevEnvironment } from "../../lib/types";
import { useDevEnvironmentsStore } from "../devEnvironmentsStore";

const mockDevEnvApi = vi.mocked(devEnvApi);

const makeEnv = (id: string): DetectedDevEnvironment => ({
	id,
	displayName: id,
	iconName: id,
});

describe("devEnvironmentsStore", () => {
	beforeEach(() => {
		useDevEnvironmentsStore.setState({
			installed: [],
			loaded: false,
			loading: false,
		});
		vi.clearAllMocks();
	});

	it("populates installed after successful load", async () => {
		mockDevEnvApi.list.mockResolvedValue([
			makeEnv("vscode"),
			makeEnv("cursor"),
		]);

		await useDevEnvironmentsStore.getState().load();

		const state = useDevEnvironmentsStore.getState();
		expect(state.loaded).toBe(true);
		expect(state.loading).toBe(false);
		expect(state.installed.map((e) => e.id)).toEqual(["vscode", "cursor"]);
	});

	it("load() is idempotent — a second call does not re-fetch", async () => {
		mockDevEnvApi.list.mockResolvedValue([makeEnv("vscode")]);

		await useDevEnvironmentsStore.getState().load();
		await useDevEnvironmentsStore.getState().load();

		expect(mockDevEnvApi.list).toHaveBeenCalledTimes(1);
	});

	it("on backend failure, marks loaded with empty installed", async () => {
		mockDevEnvApi.list.mockRejectedValue(new Error("boom"));

		await useDevEnvironmentsStore.getState().load();

		const state = useDevEnvironmentsStore.getState();
		expect(state.loaded).toBe(true);
		expect(state.installed).toEqual([]);
	});
});
