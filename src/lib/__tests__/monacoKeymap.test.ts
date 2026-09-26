import type { Monaco } from "@monaco-editor/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonacoKeys } from "../chords";
import {
	applyMonacoOverrides,
	buildMonacoRules,
	catalogueFromEditor,
	registerMonacoForKeymap,
	resetMonacoKeymapForTests,
} from "../monacoKeymap";

const keys: MonacoKeys = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
	KeyCode: { KeyK: 41, Slash: 90 },
};

const cmdK = { key: "k", meta: true, shift: false, ctrl: false, alt: false };

describe("buildMonacoRules", () => {
	it("removes every default, then adds the new chord", () => {
		expect(
			buildMonacoRules(
				{ "editor:editor.action.commentLine": cmdK },
				keys,
				true,
			),
		).toEqual([
			{ keybinding: 0, command: "-editor.action.commentLine" },
			{ keybinding: 2048 | 41, command: "editor.action.commentLine" },
		]);
	});

	it("only removes when Unbound", () => {
		expect(buildMonacoRules({ "editor:x": null }, keys, true)).toEqual([
			{ keybinding: 0, command: "-x" },
		]);
	});

	it("ignores app Overrides", () => {
		expect(buildMonacoRules({ "app:new-tab": cmdK }, keys, true)).toEqual([]);
	});
});

describe("applyMonacoOverrides", () => {
	afterEach(() => resetMonacoKeymapForTests());

	function fakeMonaco() {
		const disposers: ReturnType<typeof vi.fn>[] = [];
		const addKeybindingRules = vi.fn(() => {
			const dispose = vi.fn();
			disposers.push(dispose);
			return { dispose };
		});
		const m = { ...keys, editor: { addKeybindingRules } } as unknown as Monaco;
		return { m, addKeybindingRules, disposers };
	}

	it("applies Overrides pushed before Monaco loaded, once it registers", () => {
		const { m, addKeybindingRules } = fakeMonaco();
		applyMonacoOverrides({ "editor:x": null });
		expect(addKeybindingRules).not.toHaveBeenCalled();
		registerMonacoForKeymap(m);
		expect(addKeybindingRules).toHaveBeenCalledWith([
			{ keybinding: 0, command: "-x" },
		]);
	});

	it("disposes the old rules when the Overrides change", () => {
		const { m, addKeybindingRules, disposers } = fakeMonaco();
		registerMonacoForKeymap(m);
		applyMonacoOverrides({ "editor:x": null });
		applyMonacoOverrides({ "editor:y": null });
		expect(addKeybindingRules).toHaveBeenCalledTimes(2);
		expect(disposers[0]).toHaveBeenCalledOnce();
		expect(disposers[1]).not.toHaveBeenCalled();
		// Back to all defaults: nothing left applied.
		applyMonacoOverrides({});
		expect(disposers[1]).toHaveBeenCalledOnce();
		expect(addKeybindingRules).toHaveBeenCalledTimes(2);
	});
});

describe("catalogueFromEditor", () => {
	it("lists labelled, rebindable actions with their default chord", () => {
		const resolved = (label: string, chords: number) => ({
			getLabel: () => label,
			getChords: () =>
				Array.from({ length: chords }, () => ({
					ctrlKey: false,
					shiftKey: false,
					altKey: false,
					metaKey: true,
					keyLabel: "/",
				})),
		});
		const ed = {
			getSupportedActions: () => [
				{ id: "editor.action.commentLine", label: "Toggle Line Comment" },
				{ id: "editor.fold", label: "Fold" },
				{ id: "abundio.toggleWordWrap", label: "Toggle Word Wrap" },
				{ id: "unlabelled", label: "" },
			],
			dispose: () => {},
			_standaloneKeybindingService: {
				lookupKeybinding: (id: string) =>
					id === "editor.action.commentLine"
						? resolved("⌘/", 1)
						: id === "editor.fold"
							? resolved("⌘K ⌘[", 2)
							: undefined,
			},
		};
		const list = catalogueFromEditor(ed);
		expect(list.map((a) => a.id)).toEqual([
			"editor.fold",
			"editor.action.commentLine",
		]);
		expect(list[1].defaultChord?.code).toBe("Slash");
		// A two-step default cannot be modelled, but its spelling is kept.
		expect(list[0]).toMatchObject({
			defaultChord: null,
			defaultLabel: "⌘K ⌘[",
		});
	});

	it("survives a keybinding service that is missing", () => {
		const list = catalogueFromEditor({
			getSupportedActions: () => [{ id: "a", label: "A" }],
			dispose: () => {},
		});
		expect(list).toEqual([
			{ id: "a", label: "A", defaultChord: null, defaultLabel: null },
		]);
	});
});
