import { describe, expect, it } from "vitest";
import { initialSettingsHost } from "../settingsHostStore";

describe("initialSettingsHost (ADR-0064)", () => {
	it("opens on the opening Window's Host, this computer for a local one", () => {
		expect(initialSettingsHost("?settings&host=abc-123")).toBe("abc-123");
		expect(
			initialSettingsHost("?settings&section=agents&host=local"),
		).toBeNull();
		expect(initialSettingsHost("?settings")).toBeNull();
	});
});
