import { describe, expect, it } from "vitest";
import { resolveMarkdownImageSrc } from "../resolveMarkdownImageSrc";

const BASE = "/Users/me/project/docs";

describe("resolveMarkdownImageSrc", () => {
	it("returns null for empty/whitespace src", () => {
		expect(resolveMarkdownImageSrc(BASE, undefined)).toBeNull();
		expect(resolveMarkdownImageSrc(BASE, "")).toBeNull();
		expect(resolveMarkdownImageSrc(BASE, "   ")).toBeNull();
	});

	it("passes through remote protocols unchanged", () => {
		for (const url of [
			"http://example.com/a.png",
			"https://example.com/a.png",
			"data:image/png;base64,AAAA",
			"blob:abc",
		]) {
			expect(resolveMarkdownImageSrc(BASE, url)).toEqual({
				kind: "remote",
				url,
			});
		}
	});

	it("is case-insensitive about remote protocols", () => {
		expect(resolveMarkdownImageSrc(BASE, "HTTPS://example.com/a.png")).toEqual({
			kind: "remote",
			url: "HTTPS://example.com/a.png",
		});
	});

	it("resolves a relative path against the base directory", () => {
		expect(resolveMarkdownImageSrc(BASE, "img/a.png")).toEqual({
			kind: "local",
			path: "/Users/me/project/docs/img/a.png",
		});
	});

	it("resolves ./ and ../ segments", () => {
		expect(resolveMarkdownImageSrc(BASE, "./a.png")).toEqual({
			kind: "local",
			path: "/Users/me/project/docs/a.png",
		});
		expect(resolveMarkdownImageSrc(BASE, "../assets/a.png")).toEqual({
			kind: "local",
			path: "/Users/me/project/assets/a.png",
		});
		expect(resolveMarkdownImageSrc(BASE, "../../a.png")).toEqual({
			kind: "local",
			path: "/Users/me/a.png",
		});
	});

	it("keeps absolute filesystem paths absolute", () => {
		expect(resolveMarkdownImageSrc(BASE, "/etc/img/a.png")).toEqual({
			kind: "local",
			path: "/etc/img/a.png",
		});
	});

	it("strips query and fragment", () => {
		expect(resolveMarkdownImageSrc(BASE, "a.png?v=2#frag")).toEqual({
			kind: "local",
			path: "/Users/me/project/docs/a.png",
		});
	});

	it("decodes percent-encoded paths", () => {
		expect(resolveMarkdownImageSrc(BASE, "my%20image.png")).toEqual({
			kind: "local",
			path: "/Users/me/project/docs/my image.png",
		});
	});

	it("does not climb above the filesystem root", () => {
		expect(resolveMarkdownImageSrc("/", "../../a.png")).toEqual({
			kind: "local",
			path: "/a.png",
		});
	});
});
