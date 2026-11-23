import { create } from "zustand";

/**
 * A remote Window's link to its Host (docs/plans/remote-hosts.md phase 7d):
 * on it, off it (Rust retries in the background unless the Host needs the
 * user to sign in), or back on it but not yet caught up, because reloading
 * would lose unsaved edits. While off it, the Window's panes are frozen:
 * keystrokes are dropped, never queued (`isHostOffline`).
 *
 * A local Window is always `online`. No imports beyond zustand: `ipc.ts`
 * reads it.
 */
export type HostLink =
	| { state: "online" }
	| {
			state: "offline";
			/** The Host needs a password, passphrase, 2FA or a host key. */
			signIn: boolean;
			reason: string | null;
			/** When Rust tries again (ms since the epoch), if it will. */
			retryAt: number | null;
	  }
	| { state: "back" };

export type HostLinkEvent =
	| { kind: "lost"; reason: string | null }
	| {
			kind: "retrying";
			reason: string;
			signIn: boolean;
			retryInMs: number | null;
			now: number;
	  }
	| { kind: "failed"; reason: string; signIn: boolean }
	| { kind: "connected"; caughtUp: boolean };

/** The link after `event`. `connected` with `caughtUp` false is a Window
 *  that cannot reload yet (unsaved edits). */
export function nextLink(link: HostLink, event: HostLinkEvent): HostLink {
	switch (event.kind) {
		case "lost":
			return {
				state: "offline",
				signIn: false,
				reason: event.reason,
				retryAt: null,
			};
		case "retrying":
			return {
				state: "offline",
				signIn: event.signIn,
				reason: event.reason,
				retryAt:
					event.signIn || event.retryInMs === null
						? null
						: event.now + event.retryInMs,
			};
		case "failed":
			return {
				state: "offline",
				signIn: event.signIn || (link.state === "offline" && link.signIn),
				reason: event.reason,
				retryAt: link.state === "offline" ? link.retryAt : null,
			};
		case "connected":
			return event.caughtUp ? { state: "online" } : { state: "back" };
	}
}

/** Whether Rust's error says the Window's Host is not connected
 *  (`host_commands::remote_error`). */
export function isNotConnectedError(e: unknown): boolean {
	return /not connected to /.test(String(e));
}

export const useHostLinkStore = create<{
	link: HostLink;
	apply: (event: HostLinkEvent) => void;
}>((set) => ({
	link: { state: "online" },
	apply: (event) => set((s) => ({ link: nextLink(s.link, event) })),
}));

/** True while the Window's panes are frozen: what the user types into them
 *  is dropped. Back on the Host but not caught up still counts. */
export function isHostOffline(): boolean {
	return useHostLinkStore.getState().link.state !== "online";
}
