import { describe, expect, it } from "vitest";
import {
	buildDropText,
	formatDroppedPath,
	isImagePath,
	isMsysBashShell,
	toMsysPath,
} from "../fileDrop";

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

describe("control-char sanitization (security: filename → PTY injection)", () => {
	it("agent mode strips ESC, newline, and CR from the raw path", () => {
		const out = formatDroppedPath("/a/evil\x1b[201~\rrm -rf ~\n.png", "agent");
		expect(out).not.toContain("\x1b");
		expect(out).not.toContain("\n");
		expect(out).not.toContain("\r");
		// The ESC is gone, so the bracketed-paste terminator can no longer form.
		expect(out).toBe("/a/evil[201~rm -rf ~.png");
	});

	it("agent mode strips DEL and C1 control bytes", () => {
		expect(formatDroppedPath("/a/x\x7f\x9b.png", "agent")).toBe("/a/x.png");
	});

	it("shell mode strips control chars before quoting (no breakout survives)", () => {
		const out = formatDroppedPath("/a/x\x1b[201~ y\n.png", "shell");
		expect(out).not.toContain("\x1b");
		expect(out).not.toContain("\n");
		// Has a space after stripping → single-quoted as one token.
		expect(out).toBe("'/a/x[201~ y.png'");
	});

	it("buildDropText output never carries ESC/newline from a hostile filename", () => {
		const text = buildDropText(
			["/a/p\x1b[201~\rbad\n.png", "/b/q.png"],
			"agent",
		);
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\n");
		expect(text).not.toContain("\r");
	});

	it("leaves clean paths untouched", () => {
		expect(formatDroppedPath("/a/normal.png", "agent")).toBe("/a/normal.png");
	});
});

describe("toMsysPath (Windows → Git Bash path style)", () => {
	it("converts a backslash drive path to /c/… (drive lowercased)", () => {
		expect(toMsysPath("C:\\Users\\Me\\file.png")).toBe("/c/Users/Me/file.png");
		expect(toMsysPath("D:\\a\\b")).toBe("/d/a/b");
	});

	it("converts a forward-slash drive path too", () => {
		expect(toMsysPath("C:/Users/Me/file.png")).toBe("/c/Users/Me/file.png");
	});

	it("converts UNC paths", () => {
		expect(toMsysPath("\\\\server\\share\\x")).toBe("//server/share/x");
	});

	it("handles a bare drive", () => {
		expect(toMsysPath("C:")).toBe("/c");
	});

	it("leaves already-unix paths unchanged", () => {
		expect(toMsysPath("/c/Users/Me/file.png")).toBe("/c/Users/Me/file.png");
		expect(toMsysPath("/home/me/f.png")).toBe("/home/me/f.png");
	});
});

describe("isMsysBashShell", () => {
	it("is true for bash on Windows", () => {
		expect(isMsysBashShell("C:\\Program Files\\Git\\bin\\bash.exe", true)).toBe(
			true,
		);
		expect(isMsysBashShell("bash.exe", true)).toBe(true);
	});

	it("is false for cmd.exe / PowerShell on Windows", () => {
		expect(isMsysBashShell("C:\\Windows\\System32\\cmd.exe", true)).toBe(false);
		expect(isMsysBashShell("powershell.exe", true)).toBe(false);
		expect(isMsysBashShell("pwsh.exe", true)).toBe(false);
	});

	it("is false on non-Windows regardless of shell", () => {
		expect(isMsysBashShell("/bin/bash", false)).toBe(false);
	});
});

describe("formatDroppedPath / buildDropText with msys=true (Git Bash)", () => {
	it("agent mode emits the raw unix path", () => {
		expect(formatDroppedPath("C:\\Users\\Me\\f.png", "agent", true)).toBe(
			"/c/Users/Me/f.png",
		);
	});

	it("shell mode converts then single-quotes when there are spaces", () => {
		expect(formatDroppedPath("C:\\Users\\My Docs\\f.png", "shell", true)).toBe(
			"'/c/Users/My Docs/f.png'",
		);
	});

	it("shell mode leaves a clean converted path bare", () => {
		expect(formatDroppedPath("C:\\Users\\Me\\f.png", "shell", true)).toBe(
			"/c/Users/Me/f.png",
		);
	});

	it("buildDropText converts every path", () => {
		expect(buildDropText(["C:\\a\\b.png", "D:\\c\\d.png"], "agent", true)).toBe(
			"/c/a/b.png /d/c/d.png ",
		);
	});
});
