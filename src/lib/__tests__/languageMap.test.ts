import { describe, it, expect } from "vitest";
import { getLanguage } from "../languageMap";

describe("getLanguage", () => {
	it("returns typescript for ts/tsx", () => {
		expect(getLanguage("ts")).toBe("typescript");
		expect(getLanguage("tsx")).toBe("typescript");
	});

	it("returns javascript for js/jsx/mjs/cjs", () => {
		expect(getLanguage("js")).toBe("javascript");
		expect(getLanguage("jsx")).toBe("javascript");
		expect(getLanguage("mjs")).toBe("javascript");
		expect(getLanguage("cjs")).toBe("javascript");
	});

	it("returns correct languages for other known extensions", () => {
		expect(getLanguage("json")).toBe("json");
		expect(getLanguage("html")).toBe("html");
		expect(getLanguage("htm")).toBe("html");
		expect(getLanguage("css")).toBe("css");
		expect(getLanguage("scss")).toBe("css");
		expect(getLanguage("less")).toBe("css");
		expect(getLanguage("md")).toBe("markdown");
		expect(getLanguage("mdx")).toBe("markdown");
		expect(getLanguage("py")).toBe("python");
		expect(getLanguage("rs")).toBe("rust");
		expect(getLanguage("java")).toBe("java");
	});

	it("returns cpp for C/C++ extensions", () => {
		for (const ext of ["c", "cpp", "cc", "cxx", "h", "hpp", "hxx"]) {
			expect(getLanguage(ext)).toBe("cpp");
		}
	});

	it("handles case insensitivity", () => {
		expect(getLanguage("TS")).toBe("typescript");
		expect(getLanguage("Py")).toBe("python");
		expect(getLanguage("JSON")).toBe("json");
		expect(getLanguage("RS")).toBe("rust");
	});

	it("returns null for null input", () => {
		expect(getLanguage(null)).toBeNull();
	});

	it("returns null for unknown extensions", () => {
		expect(getLanguage("xyz")).toBeNull();
		expect(getLanguage("go")).toBeNull();
		expect(getLanguage("dart")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(getLanguage("")).toBeNull();
	});

	it("maps xml and svg to html", () => {
		expect(getLanguage("xml")).toBe("html");
		expect(getLanguage("svg")).toBe("html");
	});

	it("maps shell/config extensions to javascript", () => {
		for (const ext of ["yaml", "yml", "toml", "sh", "bash", "zsh", "sql"]) {
			expect(getLanguage(ext)).toBe("javascript");
		}
	});
});
