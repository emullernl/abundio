import { create } from "zustand";
import { watchOfferApi } from "../lib/ipc";
import {
	addOffer,
	closeOffersFor,
	type PaneWatchOffer,
	paneOfPty,
	removeOffer,
	type WatchOffers,
} from "../lib/watchOffer";
import { usePtyActivityStore } from "./ptyActivityStore";

/**
 * The **Watch offers** this Window shows (docs/plans/watch-offer.md), one per
 * pane at most. View state: in memory, this Window's own. Rust raises them
 * (`watch-offer`) and says when one was answered anywhere
 * (`watch-offer-closed`).
 */
interface WatchOfferState {
	offers: WatchOffers;
	add: (paneId: string, offer: PaneWatchOffer) => void;
	remove: (paneId: string) => void;
	closeFor: (agentId: string, watched: boolean) => void;
}

export const useWatchOfferStore = create<WatchOfferState>((set) => ({
	offers: {},
	add: (paneId, offer) =>
		set((s) => ({ offers: addOffer(s.offers, paneId, offer) })),
	remove: (paneId) => set((s) => ({ offers: removeOffer(s.offers, paneId) })),
	closeFor: (agentId, watched) =>
		set((s) => ({ offers: closeOffersFor(s.offers, agentId, watched) })),
}));

/** Hear Rust's offers and answers. Profile windows only (`App.tsx`).
 *  Returns a stop function. */
export function startWatchOffers(): () => void {
	const stops: Promise<() => void>[] = [
		watchOfferApi.onOffer((e) => {
			const paneId = paneOfPty(
				usePtyActivityStore.getState().panePtyMap,
				e.ptyId,
			);
			if (!paneId) return;
			useWatchOfferStore
				.getState()
				.add(paneId, { agentId: e.agentId, kind: e.kind });
		}),
		watchOfferApi.onClosed((agentId, watched) =>
			useWatchOfferStore.getState().closeFor(agentId, watched),
		),
	];
	return () => {
		for (const p of stops) void p.then((stop) => stop()).catch(() => {});
	};
}
