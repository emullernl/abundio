import { create } from "zustand";
import type { PastedImage } from "../lib/ipc";

/** Most **Pasted images** one **Paste tray** holds; the oldest goes first. */
export const PASTE_TRAY_MAX = 9;

export interface TrayImage extends PastedImage {
	/** Unique within the Window, for React keys and removal. */
	id: string;
}

interface PasteTrayState {
	/** Per PTY id: what this Window has handed that PTY's Agent for the prompt
	 *  it has not sent yet. View state, in memory only (docs/plans/paste-tray.md). */
	trays: Record<string, TrayImage[]>;
	add: (ptyId: string, image: PastedImage) => void;
	remove: (ptyId: string, id: string) => void;
	clear: (ptyId: string) => void;
}

let nextId = 0;

export const usePasteTrayStore = create<PasteTrayState>((set) => ({
	trays: {},
	add: (ptyId, image) =>
		set((s) => {
			const tray = [
				...(s.trays[ptyId] ?? []),
				{ ...image, id: `pi-${++nextId}` },
			];
			return {
				trays: { ...s.trays, [ptyId]: tray.slice(-PASTE_TRAY_MAX) },
			};
		}),
	remove: (ptyId, id) =>
		set((s) => {
			const tray = s.trays[ptyId];
			if (!tray) return s;
			const left = tray.filter((i) => i.id !== id);
			if (left.length === tray.length) return s;
			const trays = { ...s.trays };
			if (left.length) trays[ptyId] = left;
			else delete trays[ptyId];
			return { trays };
		}),
	clear: (ptyId) =>
		set((s) => {
			if (!s.trays[ptyId]) return s;
			const trays = { ...s.trays };
			delete trays[ptyId];
			return { trays };
		}),
}));
