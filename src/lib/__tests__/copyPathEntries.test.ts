import { describe, expect, it } from "vitest";

import { copyPathEntries } from "../copyPathEntries";

const ROOT = "/Users/me/work/abundio";

describe("copyPathEntries", () => {
	it("puts the relative path first — it is what a terminal in the workspace wants", () => {
		const entries = copyPathEntries(ROOT, `${ROOT}/src/lib/ipc.ts`);
		expect(entries.map((e) => e.id)).toEqual([
			"copy-relative-path",
			"copy-path",
		]);
	});

	it("copies the path relative to the workspace root", () => {
		const [relative, absolute] = copyPathEntries(
			ROOT,
			`${ROOT}/src/lib/ipc.ts`,
		);
		expect(relative.text).toBe("src/lib/ipc.ts");
		expect(absolute.text).toBe(`${ROOT}/src/lib/ipc.ts`);
	});

	it("handles a nested folder", () => {
		const [relative] = copyPathEntries(ROOT, `${ROOT}/src/components`);
		expect(relative.text).toBe("src/components");
	});

	it("tolerates a trailing separator on the root", () => {
		const [relative] = copyPathEntries(`${ROOT}/`, `${ROOT}/README.md`);
		expect(relative.text).toBe("README.md");
	});

	it("has no relative form for a path outside the workspace", () => {
		// Rendered disabled rather than dropped, so the menu keeps one shape.
		const [relative, absolute] = copyPathEntries(ROOT, "/etc/hosts");
		expect(relative.text).toBeNull();
		expect(absolute.text).toBe("/etc/hosts");
	});

	it("has no relative form for the workspace root itself", () => {
		expect(copyPathEntries(ROOT, ROOT)[0].text).toBeNull();
	});

	it("never yields an empty absolute path", () => {
		expect(copyPathEntries(ROOT, `${ROOT}/a.txt`)[1].text).toBeTruthy();
	});
});
