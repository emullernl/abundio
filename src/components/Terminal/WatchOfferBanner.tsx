import { Sparkles, X } from "lucide-react";
import { watchOfferCopy } from "../../lib/watchOffer";
import {
	answerWatchOffer,
	hooksEnabledForPane,
} from "../../lib/watchOfferActions";
import {
	useAgentsForPane,
	useHostAgentsStore,
} from "../../stores/hostAgentsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWatchOfferStore } from "../../stores/watchOfferStore";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";

/**
 * A pane's **Watch offer** (docs/plans/watch-offer.md): a slim bar between
 * the title bar and the terminal. It never takes focus, so typing into the
 * Agent carries on while it shows.
 */
export function WatchOfferBanner({ paneId }: { paneId: string }) {
	const offer = useWatchOfferStore((s) => s.offers[paneId]);
	const agents = useAgentsForPane(paneId);
	// Read so the wording follows the setting.
	useSettingsStore((s) => s.agentHooksEnabled);
	useHostAgentsStore((s) => s.settings);
	if (!offer) return null;
	const agent = agents.find((a) => a.id === offer.agentId);
	// Watched meanwhile (Settings, another Window): nothing left to offer.
	if (offer.kind === "watch" && agent?.enabled) return null;
	const copy = watchOfferCopy(
		offer.kind,
		agent?.name ?? offer.agentId,
		hooksEnabledForPane(paneId),
	);
	const dismiss = () => {
		if (offer.kind === "watch") void answerWatchOffer(paneId, "later");
		else useWatchOfferStore.getState().remove(paneId);
	};
	return (
		<div
			role="status"
			className="flex items-center gap-2 flex-wrap shrink-0"
			style={{
				padding: "5px 8px",
				margin: "0 8px 4px 0",
				fontSize: 12,
				color: "var(--fg-primary)",
				background:
					"color-mix(in srgb, var(--accent) 12%, var(--bg-secondary))",
				border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
				borderRadius: 6,
			}}
			// Clicks here are the banner's, not the terminal's focus handling.
			onMouseDown={(e) => e.preventDefault()}
		>
			<Sparkles size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
			<span className="flex-1 min-w-0" style={{ minWidth: 160 }}>
				{copy.message}
			</span>
			<div className="flex items-center gap-1.5 flex-wrap">
				{copy.actions.map((a) => (
					<button
						key={a.action}
						type="button"
						tabIndex={-1}
						className={
							a.primary
								? `${primaryButtonClass} bg-[var(--accent)] text-[var(--bg-primary)]`
								: secondaryButtonClass
						}
						style={{ padding: "2px 8px", fontSize: 11.5, borderRadius: 4 }}
						onClick={() => void answerWatchOffer(paneId, a.action)}
					>
						{a.label}
					</button>
				))}
				<button
					type="button"
					tabIndex={-1}
					aria-label="Dismiss"
					title={offer.kind === "watch" ? "Not now" : "Dismiss"}
					className="inline-flex items-center justify-center cursor-pointer text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
					style={{ padding: 2 }}
					onClick={dismiss}
				>
					<X size={13} />
				</button>
			</div>
		</div>
	);
}
