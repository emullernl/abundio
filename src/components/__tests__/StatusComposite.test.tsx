import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { KindRollup, StatusCounts } from "../../stores/ptyActivityStore";
import { StatusComposite } from "../StatusComposite";

function counts(partial: Partial<StatusCounts>): StatusCounts {
	return { error: 0, waiting: 0, ready: 0, working: 0, idle: 0, ...partial };
}

const rollup = (
	status: KindRollup["status"],
	c: Partial<StatusCounts>,
): KindRollup => ({ status, counts: counts(c) });

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;

/** Mount into a detached container and hand it back, mirroring the other
 *  component suites — the repo renders with `createRoot`, not testing-library. */
function render(ui: React.ReactNode): { container: HTMLDivElement } {
	const el = document.createElement("div");
	document.body.appendChild(el);
	container = el;
	const root = createRoot(el);
	act(() => {
		root.render(ui);
	});
	return { container: el };
}

afterEach(() => {
	container?.remove();
	container = null;
});

describe("StatusComposite", () => {
	it("draws the Agent rollup as the primary with a terminal badge", () => {
		const { container } = render(
			<StatusComposite
				rollups={{
					agent: rollup("green", { idle: 1 }),
					terminal: rollup("red", { error: 1 }),
				}}
			/>,
		);
		expect(
			container
				.querySelector("[data-status-composite]")
				?.getAttribute("data-status-composite"),
		).toBe("green");
		expect(
			container
				.querySelector("[data-status-badge]")
				?.getAttribute("data-status-badge"),
		).toBe("red");
	});

	it("draws no badge for an idle terminal", () => {
		const { container } = render(
			<StatusComposite
				rollups={{
					agent: rollup("green", { idle: 1 }),
					terminal: rollup("green", { idle: 2 }),
				}}
			/>,
		);
		expect(container.querySelector("[data-status-badge]")).toBeNull();
	});

	it("renders nothing at all when there are no PTYs of either kind", () => {
		const { container } = render(
			<StatusComposite rollups={{ agent: null, terminal: null }} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("keeps the grey 'Not opened' icon for a never-opened Workspace", () => {
		const { container } = render(
			<StatusComposite
				rollups={{ agent: null, terminal: null, notOpened: true }}
			/>,
		);
		const el = container.querySelector("[data-status-composite]");
		expect(el?.getAttribute("data-status-composite")).toBe("grey");
		expect(el?.getAttribute("title")).toBe("Not opened");
	});

	it("carries both rollups in one tooltip", () => {
		const { container } = render(
			<StatusComposite
				rollups={{
					agent: rollup("skyblue", { waiting: 1 }),
					terminal: rollup("cyan", { working: 2 }),
				}}
			/>,
		);
		expect(
			container.querySelector("[data-status-composite]")?.getAttribute("title"),
		).toBe("Agents: 1 Waiting\nTerminals: 2 Working");
	});

	it("lets a caller swap the whole composite out, badge included", () => {
		// A Worktree set's Primary row hover-swaps its fold chevron in here.
		// ADR-0033 accepts that this covers the badge too.
		const { container } = render(
			<StatusComposite
				rollups={{
					agent: rollup("green", { idle: 1 }),
					terminal: rollup("red", { error: 1 }),
				}}
			>
				<span data-testid="chevron" />
			</StatusComposite>,
		);
		expect(container.querySelector("[data-testid='chevron']")).not.toBeNull();
		expect(container.querySelector("[data-status-badge]")).toBeNull();
	});
});
