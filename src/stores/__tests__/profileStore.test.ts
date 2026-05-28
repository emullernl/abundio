import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
	profiles: {
		list: vi.fn(() =>
			Promise.resolve([
				{
					id: "p-default",
					name: "Default",
					position: 0,
					createdAt: 0,
					updatedAt: 0,
				},
				{
					id: "p-work",
					name: "Work",
					position: 1,
					createdAt: 0,
					updatedAt: 0,
				},
			]),
		),
		create: vi.fn((name: string) =>
			Promise.resolve({
				id: "p-new",
				name,
				position: 2,
				createdAt: 0,
				updatedAt: 0,
			}),
		),
		update: vi.fn(() => Promise.resolve()),
		delete: vi.fn(() => Promise.resolve()),
		reorder: vi.fn(() => Promise.resolve()),
		setActiveProfileId: vi.fn(() => Promise.resolve()),
		getActiveProfileForWindow: vi.fn(() => Promise.resolve(null)),
		getOwnershipMap: vi.fn(() => Promise.resolve({})),
	},
}));

import { profiles as profilesApi } from "../../lib/ipc";
import { useProfileStore } from "../profileStore";

beforeEach(() => {
	vi.clearAllMocks();
	useProfileStore.setState({
		profiles: [],
		activeProfileId: null,
		profilesLoaded: false,
		ownershipMap: {},
	});
	// Reset the mock for getActiveProfileForWindow before each test so its
	// per-test override (mockResolvedValueOnce) doesn't leak between tests.
	vi.mocked(profilesApi.getActiveProfileForWindow).mockResolvedValue(null);
	vi.mocked(profilesApi.getOwnershipMap).mockResolvedValue({});
});

describe("loadProfiles", () => {
	it("falls back to first profile when Rust has no entry for this window", async () => {
		await useProfileStore.getState().loadProfiles();
		const state = useProfileStore.getState();
		expect(state.profiles).toHaveLength(2);
		expect(state.profilesLoaded).toBe(true);
		expect(state.activeProfileId).toBe("p-default");
		expect(profilesApi.setActiveProfileId).toHaveBeenCalledWith("p-default");
	});

	it("uses the Rust-assigned profile id when present", async () => {
		vi.mocked(profilesApi.getActiveProfileForWindow).mockResolvedValueOnce(
			"p-work",
		);
		await useProfileStore.getState().loadProfiles();
		expect(useProfileStore.getState().activeProfileId).toBe("p-work");
	});

	it("falls back to first profile when Rust's id is stale (profile deleted)", async () => {
		vi.mocked(profilesApi.getActiveProfileForWindow).mockResolvedValueOnce(
			"p-deleted",
		);
		await useProfileStore.getState().loadProfiles();
		expect(useProfileStore.getState().activeProfileId).toBe("p-default");
	});

	it("populates ownershipMap from Rust", async () => {
		vi.mocked(profilesApi.getOwnershipMap).mockResolvedValueOnce({
			"p-work": "window-2",
		});
		await useProfileStore.getState().loadProfiles();
		expect(useProfileStore.getState().ownershipMap).toEqual({
			"p-work": "window-2",
		});
	});
});

describe("setActiveProfileIdLocal", () => {
	it("updates local state and pushes to Rust", async () => {
		useProfileStore.setState({ activeProfileId: "p-default" });
		await useProfileStore.getState().setActiveProfileIdLocal("p-work");
		expect(useProfileStore.getState().activeProfileId).toBe("p-work");
		expect(profilesApi.setActiveProfileId).toHaveBeenCalledWith("p-work");
	});

	it("no-ops when target id equals current id", async () => {
		useProfileStore.setState({ activeProfileId: "p-default" });
		await useProfileStore.getState().setActiveProfileIdLocal("p-default");
		expect(profilesApi.setActiveProfileId).not.toHaveBeenCalled();
	});
});

describe("refreshOwnershipMap", () => {
	it("fetches and stores the ownership map", async () => {
		vi.mocked(profilesApi.getOwnershipMap).mockResolvedValueOnce({
			"p-default": "main",
			"p-work": "window-xyz",
		});
		await useProfileStore.getState().refreshOwnershipMap();
		expect(useProfileStore.getState().ownershipMap).toEqual({
			"p-default": "main",
			"p-work": "window-xyz",
		});
	});
});

describe("createProfile", () => {
	it("appends the created profile to the store list", async () => {
		useProfileStore.setState({
			profiles: [
				{
					id: "p-default",
					name: "Default",
					position: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			],
		});
		await useProfileStore.getState().createProfile("Personal");
		const list = useProfileStore.getState().profiles;
		expect(list).toHaveLength(2);
		expect(list[1].name).toBe("Personal");
	});
});

describe("refreshProfiles", () => {
	it("pulls the latest list from Rust and stores it", async () => {
		useProfileStore.setState({
			profiles: [
				{
					id: "p-default",
					name: "Default",
					position: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			],
			activeProfileId: "p-default",
		});
		vi.mocked(profilesApi.list).mockResolvedValueOnce([
			{
				id: "p-default",
				name: "Renamed",
				position: 0,
				createdAt: 0,
				updatedAt: 1,
			},
			{ id: "p-work", name: "Work", position: 1, createdAt: 0, updatedAt: 0 },
		]);
		await useProfileStore.getState().refreshProfiles();
		const list = useProfileStore.getState().profiles;
		expect(list).toHaveLength(2);
		expect(list[0].name).toBe("Renamed");
	});

	it("is a no-op when the IPC list call rejects", async () => {
		const initial = [
			{
				id: "p-default",
				name: "Default",
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		];
		useProfileStore.setState({
			profiles: initial,
			activeProfileId: "p-default",
		});
		vi.mocked(profilesApi.list).mockRejectedValueOnce(new Error("boom"));
		await useProfileStore.getState().refreshProfiles();
		expect(useProfileStore.getState().profiles).toEqual(initial);
	});
});

describe("deleteProfile", () => {
	it("removes the profile from the store list", async () => {
		useProfileStore.setState({
			profiles: [
				{
					id: "p-default",
					name: "Default",
					position: 0,
					createdAt: 0,
					updatedAt: 0,
				},
				{
					id: "p-work",
					name: "Work",
					position: 1,
					createdAt: 0,
					updatedAt: 0,
				},
			],
		});
		await useProfileStore.getState().deleteProfile("p-work");
		const list = useProfileStore.getState().profiles;
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("p-default");
	});
});
