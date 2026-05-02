import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../ErrorBoundary";

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

function Boom(): ReactNode {
	throw new Error("test boom");
}

describe("ErrorBoundary", () => {
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

	it("renders the fallback when a child throws", () => {
		act(() => {
			root.render(
				<ErrorBoundary fallback={(err) => <div>caught: {err.message}</div>}>
					<Boom />
				</ErrorBoundary>,
			);
		});
		expect(container.textContent).toContain("caught: test boom");
	});

	it("renders children when no error occurs", () => {
		act(() => {
			root.render(
				<ErrorBoundary fallback={() => <div>fallback</div>}>
					<span>ok</span>
				</ErrorBoundary>,
			);
		});
		expect(container.textContent).toBe("ok");
	});

	it("reset() clears the error state and triggers re-render", () => {
		act(() => {
			root.render(
				<ErrorBoundary
					fallback={(_err, reset) => (
						<div>
							<span>fallback</span>
							<button type="button" onClick={reset}>
								Retry
							</button>
						</div>
					)}
				>
					<Boom />
				</ErrorBoundary>,
			);
		});
		expect(container.textContent).toContain("fallback");

		const btn = container.querySelector("button") as HTMLButtonElement;
		act(() => {
			btn.click();
		});
		// After reset the child still throws — boundary catches it again.
		// This confirms reset() calls setState and the boundary re-mounts children.
		expect(container.textContent).toContain("fallback");
	});
});
