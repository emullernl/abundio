import { describe, expect, it } from "vitest";
import { buildDropText, formatDroppedPath, isImagePath } from "../fileDrop";

describe("isImagePath", () => {
	it("detects common raster image extensions, case-insensitively", () => {
		for (const p of [
			"/a/b.png",
			"/a/b.PNG",
			"photo.jpg",
			"photo.jpeg",
			"anim.gif",
			"pic.webp",
			"scan.bmp",
			"scan.tif",
			"scan.tiff",
			"shot.heic",
			"shot.HEIF",
			"x.avif",
		]) {
			expect(isImagePath(p)).toBe(true);
		}
	});

	it("rejects non-images and extension-less paths", () => {
		for (const p of [
			"/a/b.txt",
			"notes.md",
			"icon.svg", // vector, excluded
			"archive.tar.gz",
			"/a/b/Makefile",
			"/a/.gitignore", // dotfile, no real extension
			"noext",
		]) {
			expect(isImagePath(p)).toBe(false);
		}
	});

	it("uses the basename, not a dot earlier in the path", () => {
		// A dot in a parent directory must not be mistaken for an extension.
		expect(isImagePath("/home/user.images/file")).toBe(false);
		expect(isImagePath("/home/user.images/file.png")).toBe(true);
	});
});

describe("formatDroppedPath", () => {
	it("agent mode is always raw", () => {
		expect(formatDroppedPath("/a/My File.png", "agent")).toBe("/a/My File.png");
		expect(formatDroppedPath("/a/b.png", "agent")).toBe("/a/b.png");
	});

	it("shell mode leaves safe paths bare", () => {
		expect(formatDroppedPath("/a/b.png", "shell")).toBe("/a/b.png");
		expect(formatDroppedPath("/Users/me/file-1_v2.png", "shell")).toBe(
			"/Users/me/file-1_v2.png",
		);
	});

	it("shell mode single-quotes paths with spaces or special chars", () => {
		expect(formatDroppedPath("/a/My File.png", "shell")).toBe(
			"'/a/My File.png'",
		);
		expect(formatDroppedPath("/a/b&c.png", "shell")).toBe("'/a/b&c.png'");
		expect(formatDroppedPath("/a/(x).png", "shell")).toBe("'/a/(x).png'");
	});

	it("shell mode escapes embedded single quotes the POSIX way", () => {
		expect(formatDroppedPath("/a/it's.png", "shell")).toBe("'/a/it'\\''s.png'");
	});
});

describe("buildDropText", () => {
	it("joins multiple paths with spaces and adds a trailing space", () => {
		expect(buildDropText(["/a/b.png", "/c/d.png"], "agent")).toBe(
			"/a/b.png /c/d.png ",
		);
	});

	it("formats each path per mode", () => {
		expect(buildDropText(["/a/My File.png", "/c/d.png"], "shell")).toBe(
			"'/a/My File.png' /c/d.png ",
		);
	});

	it("single path still gets a trailing space", () => {
		expect(buildDropText(["/a/b.png"], "agent")).toBe("/a/b.png ");
	});
});
