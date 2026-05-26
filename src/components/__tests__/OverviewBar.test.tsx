import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverviewBar, type OverviewBarProps } from "../OverviewBar";

function baseProps(): OverviewBarProps {
	return {
		openedWorkspaces: 0,
		totalWorkspaces: 0,
		idleAgents: 0,
		workingAgents: 0,
		waitingAgents: 0,
		readyAgents: 0,
		errorAgents: 0,
		idleShells: 0,
		workingShells: 0,
		readyShells: 0,
		errorShells: 0,
		reviewRequestedPrs: 0,
		myOpenPrs: 0,
		showAgentWaiting: true,
		showShellActivityDetail: true,
	};
}

describe("OverviewBar", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("renders the workspace tile with only the opened count; total lives in the tooltip", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					openedWorkspaces={3}
					totalWorkspaces={8}
				/>,
			);
		});
		const tiles = Array.from(
			container.querySelectorAll("[title]"),
		) as HTMLElement[];
		const workspaceTile = tiles.find((el) =>
			el.getAttribute("title")?.includes("workspaces opened"),
		);
		expect(workspaceTile).toBeDefined();
		// Tile face shows only the opened count — the total is hidden in the tooltip.
		expect(workspaceTile?.textContent).toBe("3");
		expect(workspaceTile?.getAttribute("title")).toBe(
			"3 of 8 workspaces opened",
		);
	});

	it("renders all five agent counts and both PR counts", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					openedWorkspaces={1}
					totalWorkspaces={2}
					idleAgents={4}
					workingAgents={2}
					waitingAgents={1}
					readyAgents={5}
					errorAgents={3}
					reviewRequestedPrs={9}
					myOpenPrs={7}
				/>,
			);
		});
		// Count chips: title attributes reliably identify each chip kind.
		const tooltipTexts = Array.from(container.querySelectorAll("[title]")).map(
			(el) => el.getAttribute("title") ?? "",
		);
		expect(tooltipTexts.some((t) => t.startsWith("Idle agents"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Working agents"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Waiting agents"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Ready agents"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Error agents"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Review requested"))).toBe(
			true,
		);
		expect(tooltipTexts.some((t) => t.startsWith("My open PRs"))).toBe(true);
	});

	it("dims chips with a zero count", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					openedWorkspaces={2}
					totalWorkspaces={5}
					workingAgents={3}
				/>,
			);
		});
		const chips = Array.from(
			container.querySelectorAll("[title]"),
		) as HTMLElement[];
		const idleChip = chips.find((el) =>
			el.getAttribute("title")?.startsWith("Idle agents"),
		);
		const workingChip = chips.find((el) =>
			el.getAttribute("title")?.startsWith("Working agents"),
		);
		// Zero-count tiles drop to 0.4 — the "off" look. Active tiles render at
		// full opacity. The exact number matters because it's the contract for
		// the dimmed-zero treatment locked in design grilling.
		expect(idleChip?.style.opacity).toBe("0.4");
		expect(workingChip?.style.opacity).toBe("1");
	});

	it("mutes the workspace tile when no workspaces are opened, even if sidebar has some", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					openedWorkspaces={0}
					totalWorkspaces={8}
				/>,
			);
		});
		const tiles = Array.from(
			container.querySelectorAll("[title]"),
		) as HTMLElement[];
		const workspaceTile = tiles.find((el) =>
			el.getAttribute("title")?.includes("workspaces opened"),
		);
		// Tile is muted because opened === 0, but the tooltip still reports
		// the true sidebar total so the user knows workspaces exist.
		expect(workspaceTile?.style.opacity).toBe("0.4");
		expect(workspaceTile?.getAttribute("title")).toBe(
			"0 of 8 workspaces opened",
		);
	});

	it("collapses counts > 99 to '99+' on the tile face; tooltip keeps the real number", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					openedWorkspaces={150}
					totalWorkspaces={200}
					workingAgents={100}
					reviewRequestedPrs={42}
				/>,
			);
		});
		const tiles = Array.from(
			container.querySelectorAll("[title]"),
		) as HTMLElement[];
		const workspaceTile = tiles.find((el) =>
			el.getAttribute("title")?.includes("workspaces opened"),
		);
		const workingTile = tiles.find((el) =>
			el.getAttribute("title")?.startsWith("Working agents"),
		);
		const reviewTile = tiles.find((el) =>
			el.getAttribute("title")?.startsWith("Review requested"),
		);
		// Tile face: capped at 99+.
		expect(workspaceTile?.textContent).toBe("99+");
		expect(workingTile?.textContent).toBe("99+");
		// Under-100 counts render uncapped.
		expect(reviewTile?.textContent).toBe("42");
		// Tooltips keep the real numbers — capping is a display concern only.
		expect(workspaceTile?.getAttribute("title")).toBe(
			"150 of 200 workspaces opened",
		);
		expect(workingTile?.getAttribute("title")).toContain("(100)");
	});

	it("renders the four shell tiles and labels them as terminals", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					idleShells={2}
					workingShells={1}
					readyShells={3}
					errorShells={1}
				/>,
			);
		});
		const tooltipTexts = Array.from(container.querySelectorAll("[title]")).map(
			(el) => el.getAttribute("title") ?? "",
		);
		expect(tooltipTexts.some((t) => t.startsWith("Idle terminals"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Busy terminals"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Finished terminals"))).toBe(
			true,
		);
		expect(tooltipTexts.some((t) => t.startsWith("Error terminals"))).toBe(
			true,
		);
	});

	it("hides the Waiting agent tile when showAgentWaiting is false", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					showAgentWaiting={false}
					waitingAgents={3}
				/>,
			);
		});
		const tooltipTexts = Array.from(container.querySelectorAll("[title]")).map(
			(el) => el.getAttribute("title") ?? "",
		);
		// Idle agent tile still present, Waiting tile gone.
		expect(tooltipTexts.some((t) => t.startsWith("Idle agents"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Waiting agents"))).toBe(
			false,
		);
	});

	it("hides Busy and Finished shell tiles when showShellActivityDetail is false, keeps Idle and Error", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					showShellActivityDetail={false}
					idleShells={2}
					workingShells={1}
					readyShells={3}
					errorShells={1}
				/>,
			);
		});
		const tooltipTexts = Array.from(container.querySelectorAll("[title]")).map(
			(el) => el.getAttribute("title") ?? "",
		);
		expect(tooltipTexts.some((t) => t.startsWith("Idle terminals"))).toBe(true);
		expect(tooltipTexts.some((t) => t.startsWith("Error terminals"))).toBe(
			true,
		);
		expect(tooltipTexts.some((t) => t.startsWith("Busy terminals"))).toBe(
			false,
		);
		expect(tooltipTexts.some((t) => t.startsWith("Finished terminals"))).toBe(
			false,
		);
	});

	it("includes the count in each chip's tooltip", () => {
		act(() => {
			root.render(
				<OverviewBar
					{...baseProps()}
					workingAgents={2}
					reviewRequestedPrs={4}
				/>,
			);
		});
		const chips = Array.from(
			container.querySelectorAll("[title]"),
		) as HTMLElement[];
		const workingChip = chips.find((el) =>
			el.getAttribute("title")?.startsWith("Working agents"),
		);
		const reviewChip = chips.find((el) =>
			el.getAttribute("title")?.startsWith("Review requested"),
		);
		expect(workingChip?.getAttribute("title")).toContain("(2)");
		expect(reviewChip?.getAttribute("title")).toContain("(4)");
	});
});
