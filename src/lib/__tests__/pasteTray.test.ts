import { beforeEach, describe, expect, it, vi } from "vitest";

const peek = vi.fn();
const isImagePaste = vi.fn();
vi.mock("../ipc", async (orig) => ({
	...(await orig<typeof import("../ipc")>()),
	clipboardImage: {
		peek: () => peek(),
		isImagePaste: () => isImagePaste(),
		setFromPath: vi.fn(),
	},
}));

import { usePasteTrayStore } from "../../stores/pasteTrayStore";
import {
	__emitStatusChangeForTests,
	type StatusSnapshot,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
	CTRL_V,
	clearsTray,
	notePastedImage,
	noteTypedCtrlV,
	shouldSmartPaste,
	smartImagePaste,
	startPasteTray,
} from "../pasteTray";

startPasteTray();

const IMAGE = { thumb: "t", full: "f", width: 4, height: 2 };

function setMode(ptyId: string, detectionMode: "agent" | "shell") {
	usePtyActivityStore.setState((s) => ({
		activities: {
			...s.activities,
			[ptyId]: { ...(s.activities[ptyId] ?? {}), detectionMode } as never,
		},
	}));
}

const snap = (
	state: StatusSnapshot["state"],
	detectionMode: StatusSnapshot["detectionMode"] = "agent",
): StatusSnapshot => ({ state, detectionMode, hookDriven: true });

const tray = (ptyId: string) => usePasteTrayStore.getState().trays[ptyId];

beforeEach(() => {
	peek.mockReset();
	peek.mockResolvedValue(IMAGE);
	isImagePaste.mockReset();
	isImagePaste.mockResolvedValue(true);
	usePasteTrayStore.setState({ trays: {} });
	useSettingsStore.setState({ pasteTray: true, smartImageDrop: true });
	setMode("p1", "agent");
	setMode("s1", "shell");
});

describe("clearsTray", () => {
	it("clears when the Agent starts working", () => {
		expect(clearsTray(snap("waiting"), snap("active"))).toBe(true);
		expect(clearsTray(snap("ready"), snap("active"))).toBe(true);
	});
	it("does not clear on other changes, or while already working", () => {
		expect(clearsTray(snap("active"), snap("active"))).toBe(false);
		expect(clearsTray(snap("idle"), snap("ready"))).toBe(false);
	});
	it("clears when the pane leaves agent mode", () => {
		expect(clearsTray(snap("ready"), snap("idle", "shell"))).toBe(true);
	});
	it("is wired to status changes", async () => {
		await notePastedImage("p1");
		expect(tray("p1")).toHaveLength(1);
		__emitStatusChangeForTests({
			ptyId: "p1",
			prev: snap("ready"),
			next: snap("active"),
			cause: { kind: "scan" } as never,
		});
		expect(tray("p1")).toBeUndefined();
	});
});

describe("notePastedImage", () => {
	it("adds the clipboard image for an agent-mode PTY", async () => {
		await notePastedImage("p1");
		expect(tray("p1")?.[0]).toMatchObject(IMAGE);
	});
	it("adds nothing in a shell pane, without reading the clipboard", async () => {
		await notePastedImage("s1");
		expect(tray("s1")).toBeUndefined();
		expect(peek).not.toHaveBeenCalled();
	});
	it("adds nothing when the setting is off", async () => {
		useSettingsStore.setState({ pasteTray: false });
		await notePastedImage("p1");
		expect(tray("p1")).toBeUndefined();
	});
	it("adds nothing when the clipboard has no image alone", async () => {
		peek.mockResolvedValue(null);
		await notePastedImage("p1");
		expect(tray("p1")).toBeUndefined();
	});
	it("never throws when the clipboard read fails", async () => {
		peek.mockRejectedValue(new Error("locked"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(notePastedImage("p1")).resolves.toBeUndefined();
	});
});

describe("shouldSmartPaste", () => {
	it("needs agent mode, the setting and an image paste", () => {
		expect(shouldSmartPaste(true, true, true)).toBe(true);
		expect(shouldSmartPaste(false, true, true)).toBe(false);
		expect(shouldSmartPaste(true, false, true)).toBe(false);
		expect(shouldSmartPaste(true, true, false)).toBe(false);
	});
});

describe("smartImagePaste", () => {
	// What term.input does: the byte reaches onData, and so the typed path.
	const typed = vi.fn((data: string) => {
		if (data === CTRL_V) noteTypedCtrlV("p1");
	});
	beforeEach(() => typed.mockClear());

	it("sends Ctrl+V after the cheap check, and the typed path adds the image once", async () => {
		expect(await smartImagePaste("p1", typed)).toBe(true);
		expect(typed).toHaveBeenCalledWith(CTRL_V);
		await vi.waitFor(() => expect(tray("p1")).toHaveLength(1));
		expect(isImagePaste).toHaveBeenCalledTimes(1);
		expect(peek).toHaveBeenCalledTimes(1);
	});
	it("sends without waiting for the thumbnails", async () => {
		peek.mockReturnValue(new Promise(() => {}));
		expect(await smartImagePaste("p1", typed)).toBe(true);
		expect(typed).toHaveBeenCalledWith(CTRL_V);
	});
	it("does nothing in a shell pane", async () => {
		expect(await smartImagePaste("s1", typed)).toBe(false);
		expect(typed).not.toHaveBeenCalled();
	});
	it("does nothing when Smart image drop is off", async () => {
		useSettingsStore.setState({ smartImageDrop: false });
		expect(await smartImagePaste("p1", typed)).toBe(false);
		expect(typed).not.toHaveBeenCalled();
	});
	it("does nothing when the clipboard is not an image alone", async () => {
		isImagePaste.mockResolvedValue(false);
		expect(await smartImagePaste("p1", typed)).toBe(false);
		expect(typed).not.toHaveBeenCalled();
	});
	it("with the tray off, still sends but encodes no thumbnails", async () => {
		useSettingsStore.setState({ pasteTray: false });
		expect(await smartImagePaste("p1", typed)).toBe(true);
		await Promise.resolve();
		expect(peek).not.toHaveBeenCalled();
		expect(tray("p1")).toBeUndefined();
	});
});

describe("freeing trays", () => {
	it("drops a tray when its PTY is removed", async () => {
		await notePastedImage("p1");
		expect(tray("p1")).toHaveLength(1);
		usePtyActivityStore.getState().removePty("p1", { local: true });
		expect(tray("p1")).toBeUndefined();
	});
});
