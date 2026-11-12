import { describe, expect, it } from "vitest";
import {
	agentsShareFromDrag,
	leftSidebarShares,
	MIN_AGENTS_SHARE,
} from "../leftSidebarLayout";

describe("leftSidebarShares", () => {
	it("splits by the stored share", () => {
		expect(
			leftSidebarShares({ agentsShare: 0.3, agentsCollapsed: false }),
		).toEqual({ workspaces: 0.7, agents: 0.3 });
	});
	it("gives everything to the Workspace list when collapsed", () => {
		expect(
			leftSidebarShares({ agentsShare: 0.3, agentsCollapsed: true }),
		).toEqual({ workspaces: 1, agents: 0 });
	});
	it("clamps a stored share outside the bounds", () => {
		expect(
			leftSidebarShares({ agentsShare: 0.99, agentsCollapsed: false }).agents,
		).toBe(1 - MIN_AGENTS_SHARE);
		expect(
			leftSidebarShares({ agentsShare: 0, agentsCollapsed: false }).agents,
		).toBe(MIN_AGENTS_SHARE);
	});
	it("falls back to the default for a non-finite share", () => {
		expect(
			leftSidebarShares({ agentsShare: Number.NaN, agentsCollapsed: false })
				.agents,
		).toBe(0.3);
	});
});

describe("agentsShareFromDrag", () => {
	it("gives the Agents list the space below the divider", () => {
		expect(agentsShareFromDrag(0.6)).toBeCloseTo(0.4);
	});
	it("keeps both sides above the minimum", () => {
		expect(agentsShareFromDrag(0)).toBe(1 - MIN_AGENTS_SHARE);
		expect(agentsShareFromDrag(1)).toBe(MIN_AGENTS_SHARE);
	});
});
