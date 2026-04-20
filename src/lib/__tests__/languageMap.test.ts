import { describe, expect, it } from "vitest";
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
		expect(getLanguage("scss")).toBe("scss");
		expect(getLanguage("less")).toBe("less");
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
		expect(getLanguage("dart")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(getLanguage("")).toBeNull();
	});

	it("maps xml and svg to xml", () => {
		expect(getLanguage("xml")).toBe("xml");
		expect(getLanguage("svg")).toBe("xml");
	});

	it("maps shell extensions to shell", () => {
		for (const ext of ["sh", "bash", "zsh"]) {
			expect(getLanguage(ext)).toBe("shell");
		}
	});

	it("maps yaml extensions to yaml", () => {
		expect(getLanguage("yaml")).toBe("yaml");
		expect(getLanguage("yml")).toBe("yaml");
	});

	it("maps config and data extensions correctly", () => {
		expect(getLanguage("toml")).toBe("ini");
		expect(getLanguage("sql")).toBe("sql");
	});

	it("maps Visualforce page/component to html", () => {
		expect(getLanguage("page")).toBe("html");
		expect(getLanguage("component")).toBe("html");
	});

	it("supports additional Monaco languages", () => {
		expect(getLanguage("go")).toBe("go");
		expect(getLanguage("rb")).toBe("ruby");
		expect(getLanguage("php")).toBe("php");
		expect(getLanguage("swift")).toBe("swift");
		expect(getLanguage("kt")).toBe("kotlin");
		expect(getLanguage("lua")).toBe("lua");
		expect(getLanguage("r")).toBe("r");
		expect(getLanguage("dockerfile")).toBe("dockerfile");
	});
});
