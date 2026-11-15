import { describe, expect, it } from "vitest";
import { folderVerdict } from "../workspaceFolder";

const check = (over = {}) => ({
	takenBy: null,
	orchestrator: false,
	otherProfiles: [],
	...over,
});

describe("folderVerdict", () => {
	it("says nothing before a check, or for a free folder", () => {
		expect(folderVerdict(null)).toEqual({
			blocked: false,
			message: null,
			open: null,
		});
		expect(folderVerdict(check()).message).toBeNull();
	});

	it("refuses a folder its Profile already has, offering that Workspace", () => {
		const v = folderVerdict(check({ takenBy: { id: "w1", name: "acme-web" } }));
		expect(v).toEqual({
			blocked: true,
			message: "acme-web already uses this folder.",
			open: { id: "w1", name: "acme-web" },
		});
	});

	it("refuses an Orchestrator folder, whatever else is true", () => {
		const v = folderVerdict(
			check({ orchestrator: true, takenBy: { id: "w1", name: "x" } }),
		);
		expect(v.blocked).toBe(true);
		expect(v.open).toBeNull();
		expect(v.message).toContain("Orchestrator's folder");
	});

	it("allows another Profile's folder, and says so", () => {
		const v = folderVerdict(check({ otherProfiles: ["Work", "Home"] }));
		expect(v.blocked).toBe(false);
		expect(v.message).toContain("Also a Workspace in Work, Home.");
	});
});
