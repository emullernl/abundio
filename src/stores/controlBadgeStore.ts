import { create } from "zustand";

/** One pane's **Control badge**: who is driving it. Several calls can run on
 *  one pane at once (a wait plus a read); the badge stays until the last
 *  ends and names the most recent caller. */
export interface ControlBadge {
	/** The caller's Agent handle, or its Pane number (`p2`). */
	by: string;
	count: number;
}

interface ControlBadgeState {
	badges: Record<string, ControlBadge>;
	/** Show the badge on `paneId` for one call. Returns the function that
	 *  ends it; calling that more than once is harmless. */
	begin: (paneId: string, by: string) => () => void;
}

export const useControlBadgeStore = create<ControlBadgeState>((set) => ({
	badges: {},
	begin: (paneId, by) => {
		set((s) => ({
			badges: {
				...s.badges,
				[paneId]: { by, count: (s.badges[paneId]?.count ?? 0) + 1 },
			},
		}));
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			set((s) => {
				const cur = s.badges[paneId];
				if (!cur) return s;
				const { [paneId]: _gone, ...rest } = s.badges;
				return {
					badges:
						cur.count > 1
							? { ...rest, [paneId]: { ...cur, count: cur.count - 1 } }
							: rest,
				};
			});
		};
	},
}));
