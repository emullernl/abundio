import { beforeEach, describe, expect, it, vi } from "vitest";

const closes: [string, string, unknown][] = [];
const restarts: [string, string, string][] = [];
const provisions: unknown[] = [];

vi.mock("../ipc", async (importOriginal) => {
	const real = await importOriginal<typeof import("../ipc")>();
	return {
		...real,
		watchOfferApi: {
			onOffer: async () => () => {},
			onClosed: async () => () => {},
			close: async (paneId: string, agentId: string, opts: unknown) => {
				closes.push([paneId, agentId, opts]);
			},
		},
		agentHooks: {
			...real.agentHooks,
			provision: async (enabled: boolean, ids: string[]) => {
				provisions.push([enabled, ids]);
			},
		},
		agentSkill: {
			...real.agentSkill,
			provision: async () => {},
		},
	};
});
vi.mock("../paneRestart", () => ({
	restartPaneWithAgent: async (
		paneId: string,
		agentId: string,
		cmd: string,
	) => {
		restarts.push([paneId, agentId, cmd]);
	},
}));

import { useSettingsStore } from "../../stores/settingsStore";
import { useWatchOfferStore } from "../../stores/watchOfferStore";
import { BUILTIN_AGENTS } from "../agents";
import { answerWatchOffer } from "../watchOfferActions";

beforeEach(() => {
	closes.length = 0;
	restarts.length = 0;
	provisions.length = 0;
	useSettingsStore.setState({
		agents: BUILTIN_AGENTS.map((a) => ({ ...a, enabled: a.id === "claude" })),
		agentHooksEnabled: true,
		declinedWatchOffers: [],
	});
	useWatchOfferStore.setState({
		offers: { a: { agentId: "codex", kind: "watch" } },
	});
});

const watched = (id: string) =>
	useSettingsStore.getState().agents.find((a) => a.id === id)?.enabled;

describe("answerWatchOffer on this computer", () => {
	it("Enable Watches the Agent, writes hooks and turns the others into restarts", async () => {
		await answerWatchOffer("a", "enable");
		expect(watched("codex")).toBe(true);
		expect(provisions).toEqual([[true, ["claude", "codex"]]]);
		expect(closes).toEqual([["a", "codex", { watched: true }]]);
		expect(restarts).toEqual([]);
		expect(useWatchOfferStore.getState().offers).toEqual({});
	});

	it("Enable and restart starts the Agent afresh after its hooks", async () => {
		await answerWatchOffer("a", "enable-restart");
		expect(watched("codex")).toBe(true);
		expect(restarts).toEqual([["a", "codex", "codex"]]);
	});

	it("Not now snoozes and changes no setting", async () => {
		await answerWatchOffer("a", "later");
		expect(watched("codex")).toBe(false);
		expect(closes).toEqual([["a", "codex", { snooze: true }]]);
		expect(useSettingsStore.getState().declinedWatchOffers).toEqual([]);
	});

	it("Never is remembered and leaves the Agent un-Watched", async () => {
		await answerWatchOffer("a", "never");
		expect(watched("codex")).toBe(false);
		expect(useSettingsStore.getState().declinedWatchOffers).toEqual(["codex"]);
		expect(closes).toEqual([["a", "codex", {}]]);
	});

	it("a restart offer restarts only that pane", async () => {
		useWatchOfferStore.setState({
			offers: {
				a: { agentId: "claude", kind: "restart" },
				b: { agentId: "claude", kind: "restart" },
			},
		});
		await answerWatchOffer("a", "restart");
		expect(restarts).toEqual([["a", "claude", "claude"]]);
		expect(closes).toEqual([]);
		expect(Object.keys(useWatchOfferStore.getState().offers)).toEqual(["b"]);
	});

	it("does nothing for a pane with no offer", async () => {
		await answerWatchOffer("zz", "enable");
		expect(watched("codex")).toBe(false);
		expect(closes).toEqual([]);
	});
});

describe("matchAgentsToInstalled", () => {
	it("forgets every Never", async () => {
		useSettingsStore.setState({ declinedWatchOffers: ["codex"] });
		await useSettingsStore
			.getState()
			.matchAgentsToInstalled(new Set(["claude"]));
		expect(useSettingsStore.getState().declinedWatchOffers).toEqual([]);
	});
});
