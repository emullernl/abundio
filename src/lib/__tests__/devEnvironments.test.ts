import { describe, expect, it } from "vitest";
import { pickActiveDevEnvId } from "../devEnvironments";
import type { DetectedDevEnvironment } from "../types";

const env = (id: string): DetectedDevEnvironment => ({
	id,
	displayName: id,
	iconName: id,
});

describe("pickActiveDevEnvId", () => {
	it("prefers last-opened when it is still installed", () => {
		const installed = [env("vscode"), env("cursor")];
		expect(pickActiveDevEnvId(installed, "cursor")).toBe("cursor");
	});

	it("falls back to vscode when last-opened is not installed", () => {
		const installed = [env("vscode"), env("zed")];
		expect(pickActiveDevEnvId(installed, "cursor")).toBe("vscode");
	});

	it("falls back to vscode when last-opened is null", () => {
		const installed = [env("vscode"), env("zed")];
		expect(pickActiveDevEnvId(installed, null)).toBe("vscode");
	});

	it("uses first installed when vscode is absent and no last-opened", () => {
		const installed = [env("cursor"), env("zed")];
		expect(pickActiveDevEnvId(installed, null)).toBe("cursor");
	});

	it("returns null when nothing is installed", () => {
		expect(pickActiveDevEnvId([], null)).toBeNull();
		expect(pickActiveDevEnvId([], "vscode")).toBeNull();
	});
});
