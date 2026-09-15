import { describe, expect, it } from "vitest";
import { shortenPath } from "../shortenPath";

describe("shortenPath", () => {
	it.each([
		// macOS
		["/Users/emil/dev/acme", "~/dev/acme"],
		["/Users/emil", "~"],
		["/Users/emil/", "~/"],
		// Linux
		["/home/emil/dev/acme", "~/dev/acme"],
		["/home/emil", "~"],
		// Windows, either slash, any drive
		["C:\\Users\\emil\\dev\\acme", "~\\dev\\acme"],
		["D:/Users/emil/dev", "~/dev"],
		["c:\\Users\\emil", "~"],
	])("abbreviates the home directory in %s", (input, expected) => {
		expect(shortenPath(input)).toBe(expected);
	});

	it.each([
		// No user name after the home root: not a home directory.
		"/Users/",
		"/home/",
		"C:\\Users\\",
		// Outside any home directory.
		"/opt/projects/acme",
		"/var/home/emil",
		"C:\\Projects\\acme",
		// A look-alike prefix.
		"/Usersx/emil/dev",
		"",
	])("leaves %j unchanged", (input) => {
		expect(shortenPath(input)).toBe(input);
	});
});
