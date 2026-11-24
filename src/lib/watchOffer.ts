/**
 * **Watch offer** (docs/plans/watch-offer.md), the pure part: which panes
 * show a banner, how an answer changes them, and what each banner says.
 * Rust decides when to offer (`shell_integration::AgentCommands::offer_for`);
 * the Window only shows and answers.
 */

/** `"watch"`: the Agent typed here is not Watched. `"restart"`: it is now,
 *  but the running Agent has not read its hooks. */
export type WatchOfferKind = "watch" | "restart";

export interface PaneWatchOffer {
	agentId: string;
	kind: WatchOfferKind;
}

/** Pane id → its offer. */
export type WatchOffers = Readonly<Record<string, PaneWatchOffer>>;

/** The pane a PTY belongs to, by the Window's own map. */
export function paneOfPty(
	panePtyMap: Readonly<Record<string, string>>,
	ptyId: string,
): string | undefined {
	for (const [paneId, id] of Object.entries(panePtyMap)) {
		if (id === ptyId) return paneId;
	}
	return undefined;
}

/** An offer raised for a pane. One the pane already shows is kept as is, so
 *  typing the Agent again changes nothing; a restart offer never gives way
 *  to a watch offer for the same Agent (Rust raises those only for an Agent
 *  that is not Watched, so that is an answer still on its way). */
export function addOffer(
	offers: WatchOffers,
	paneId: string,
	offer: PaneWatchOffer,
): WatchOffers {
	const have = offers[paneId];
	if (have && have.agentId === offer.agentId) {
		if (have.kind === offer.kind || have.kind === "restart") return offers;
	}
	return { ...offers, [paneId]: offer };
}

export function removeOffer(offers: WatchOffers, paneId: string): WatchOffers {
	if (!(paneId in offers)) return offers;
	const { [paneId]: _gone, ...rest } = offers;
	return rest;
}

/** An Agent's offer was answered on one Host. Enable (`watched`) leaves
 *  every other pane of that Host running it with a restart offer, since none
 *  of them has read its hooks; any other answer closes them. Panes of other
 *  Hosts (`onHost` false) keep theirs: the Agent's switch there is its own.
 *  Restart offers are each pane's own and stay. */
export function closeOffersFor(
	offers: WatchOffers,
	agentId: string,
	watched: boolean,
	onHost: (paneId: string) => boolean = () => true,
): WatchOffers {
	let changed = false;
	const next: Record<string, PaneWatchOffer> = {};
	for (const [paneId, o] of Object.entries(offers)) {
		if (o.agentId !== agentId || o.kind !== "watch" || !onHost(paneId)) {
			next[paneId] = o;
			continue;
		}
		changed = true;
		if (watched) next[paneId] = { agentId, kind: "restart" };
	}
	return changed ? next : offers;
}

/** The buttons a banner can show, in order. */
export type WatchOfferAction =
	| "enable-restart"
	| "enable"
	| "later"
	| "never"
	| "restart";

export interface WatchOfferCopy {
	message: string;
	actions: { action: WatchOfferAction; label: string; primary?: boolean }[];
}

/** What a banner says. With the Status Hooks setting off, Watching adds the
 *  Agent to the menus and detection but tracks no status, so the banner
 *  says only that. A restart is always a new session: there is no session
 *  id to resume by. */
export function watchOfferCopy(
	kind: WatchOfferKind,
	agentName: string,
	hooksEnabled: boolean,
): WatchOfferCopy {
	if (kind === "restart" && !hooksEnabled) {
		return {
			message: `${agentName} is now one of Abundio's agents. Restart it so Abundio sees it?`,
			actions: [
				{
					action: "restart",
					label: "Restart now (new session)",
					primary: true,
				},
			],
		};
	}
	if (kind === "restart") {
		return {
			message: `Status tracking for ${agentName} is set up. It starts when ${agentName} next starts.`,
			actions: [
				{
					action: "restart",
					label: "Restart now (new session)",
					primary: true,
				},
			],
		};
	}
	if (!hooksEnabled) {
		return {
			message: `Abundio found ${agentName}. Add it to Abundio's agents?`,
			actions: [
				{
					action: "enable-restart",
					label: "Add and restart (new session)",
					primary: true,
				},
				{ action: "enable", label: "Add" },
				{ action: "later", label: "Not now" },
				{ action: "never", label: "Never" },
			],
		};
	}
	return {
		message: `Abundio found ${agentName}. Turn on status tracking for it?`,
		actions: [
			{
				action: "enable-restart",
				label: "Enable and restart (new session)",
				primary: true,
			},
			{ action: "enable", label: "Enable (next start)" },
			{ action: "later", label: "Not now" },
			{ action: "never", label: "Never" },
		],
	};
}
