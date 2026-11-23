import { describe, expect, it } from "vitest";
import { clashingJoinedPanes } from "../handleClash";

const ws = (panes: [string, string][], hostId?: string) => ({
	...(hostId ? { joined: { hostId } } : {}),
	tabs: [
		{
			id: "t",
			workspaceId: "w",
			name: "T",
			position: 0,
			createdAt: 0,
			updatedAt: 0,
			layoutJson: JSON.stringify(
				panes.length === 1
					? {
							type: "terminal",
							id: panes[0][0],
							ptyId: "",
							agentHandle: panes[0][1],
						}
					: {
							type: "split",
							id: "s",
							direction: "horizontal",
							ratio: 0.5,
							first: {
								type: "terminal",
								id: panes[0][0],
								ptyId: "",
								agentHandle: panes[0][1],
							},
							second: {
								type: "terminal",
								id: panes[1][0],
								ptyId: "",
								agentHandle: panes[1][1],
							},
						},
			),
		},
	],
});

describe("clashingJoinedPanes", () => {
	it("marks a joined Agent whose handle one on another backend has", () => {
		const out = clashingJoinedPanes([
			ws([["mine", "Agent Two"]]),
			ws(
				[
					["theirs", "agent two"],
					["other", "Reviewer"],
				],
				"box",
			),
		]);
		expect([...out]).toEqual(["theirs"]);
	});
	it("leaves handles alone that only one backend uses", () => {
		expect(
			clashingJoinedPanes([
				ws([["a", "Agent One"]]),
				ws([["b", "Agent Two"]], "box"),
			]).size,
		).toBe(0);
	});
	it("marks both joined Agents when two Hosts share a handle", () => {
		const out = clashingJoinedPanes([
			ws([["x", "Builder"]], "box"),
			ws([["y", "Builder"]], "lab"),
		]);
		expect([...out].sort()).toEqual(["x", "y"]);
	});
});
