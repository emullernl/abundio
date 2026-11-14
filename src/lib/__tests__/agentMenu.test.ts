import { describe, expect, it } from "vitest";
import { agentMenuEntries } from "../agentMenu";

const ids = (opts: Parameters<typeof agentMenuEntries>[0]) =>
	agentMenuEntries(opts).map((e) => ("separator" in e ? "---" : e.id));

describe("agentMenuEntries", () => {
	it("offers everything for a named, flagged Agent", () => {
		expect(ids({ handle: "Agent Two", flagged: true })).toEqual([
			"switch-to",
			"open-in-fleet",
			"---",
			"rename",
			"copy-handle",
			"clear-flag",
			"---",
			"restart",
			"close",
		]);
	});

	it("hides Clear Attention Flag when no flag is set", () => {
		expect(ids({ handle: "Agent Two", flagged: false })).not.toContain(
			"clear-flag",
		);
	});

	it("hides Copy Handle and says Name for an Agent with no handle yet", () => {
		const entries = agentMenuEntries({ handle: undefined, flagged: false });
		expect(ids({ handle: undefined, flagged: false })).not.toContain(
			"copy-handle",
		);
		expect(entries).toContainEqual({ id: "rename", label: "Name Agent…" });
	});
});
