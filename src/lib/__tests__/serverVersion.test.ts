import { describe, expect, it } from "vitest";
import { serverUpdateTitle, serverVersionMismatch } from "../serverVersion";

describe("serverVersionMismatch", () => {
	it("reads both versions from the explained refusal", () => {
		const reason =
			"The Host runs another version of the server: Settings ▸ Hosts ▸ Check, then Update. (this Abundio server is version 0.3.0 (protocol 3); the app is 0.4.0 (protocol 3))";
		const v = serverVersionMismatch(reason);
		expect(v).toEqual({ server: "0.3.0", app: "0.4.0" });
		expect(v && serverUpdateTitle("build-box", v)).toBe(
			"build-box runs server 0.3.0; this app needs 0.4.0.",
		);
	});

	it("is null for any other failure", () => {
		expect(serverVersionMismatch("no Abundio server is running")).toBeNull();
		expect(serverVersionMismatch("Permission denied (publickey)")).toBeNull();
	});
});
