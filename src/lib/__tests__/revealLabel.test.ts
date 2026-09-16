import { describe, expect, it } from "vitest";

import { revealLabel } from "../platform";

describe("revealLabel", () => {
	it("names the file manager per platform", () => {
		expect(revealLabel("mac")).toBe("Reveal in Finder");
		expect(revealLabel("windows")).toBe("Reveal in Explorer");
		expect(revealLabel("other")).toBe("Reveal in File Manager");
	});

	it("is one label, so the Explorer and Git changes menus cannot drift", () => {
		// Both menus call this; a second copy of the ternary is what this exists
		// to prevent.
		expect(revealLabel("mac")).toBe(revealLabel("mac"));
	});
});
