import { describe, expect, it } from "vitest";
import {
	APP_ACTIONS,
	appOverrideId,
	defaultChord,
	effectiveBindings,
} from "../keybindings";

describe("actions with no default chord", () => {
	it("open-markdown-window is listed but unbound by default", () => {
		expect(APP_ACTIONS).toContain("open-markdown-window");
		expect(defaultChord("open-markdown-window")).toBeNull();
		expect(
			effectiveBindings({}).some((b) => b.action === "open-markdown-window"),
		).toBe(false);
	});

	it("fires once the user binds a chord", () => {
		const chord = { key: "o", meta: true, shift: true, ctrl: false };
		const bindings = effectiveBindings({
			[appOverrideId("open-markdown-window")]: chord,
		});
		expect(bindings).toContainEqual({
			...chord,
			action: "open-markdown-window",
		});
	});
});
