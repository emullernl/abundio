import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import { useUpdateStore } from "../stores/updateStore";
import { ReleaseNotesMarkdown } from "./Settings/ReleaseNotesMarkdown";

/**
 * "You're now on Abundio X" — shown once, on the first launch after an upgrade.
 * See ADR-0036.
 *
 * Rust decides whether this appears at all: it compares the running version
 * against the app-global `last_seen_version`, fetches the notes, and emits
 * `whats-new` to a single Profile-bound Window. So by the time this renders,
 * the notes are already in hand — there is no loading state and no failure
 * state, because a failed fetch simply never emits and tries again next launch.
 *
 * Non-blocking and bottom-right, like the update prompt, for ADR-0014's reason:
 * nothing about an update interrupts live PTYs and mid-turn Agents. It shares
 * that corner with the update prompt and takes precedence while it is up — this
 * is a one-time moment, whereas the prompt will keep re-offering itself.
 */
export function WhatsNewCard() {
	const note = useUpdateStore((s) => s.whatsNew);
	const dismiss = useUpdateStore((s) => s.dismissWhatsNew);

	return (
		<AnimatePresence>
			{note && (
				<motion.div
					role="dialog"
					aria-label={`What's new in Abundio ${note.version}`}
					className="fixed z-[150] rounded-xl overflow-hidden flex flex-col"
					initial={{ opacity: 0, y: 16, scale: 0.98 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: 16, scale: 0.98 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					style={{
						right: 16,
						bottom: 16,
						width: 420,
						// The body is whatever the release notes happen to be, so the
						// card is capped and scrolls rather than growing off-screen.
						maxHeight: "50vh",
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 18px 48px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03) inset",
					}}
				>
					<div
						className="flex items-start gap-3 flex-shrink-0"
						style={{ padding: "14px 16px 10px" }}
					>
						<div
							className="flex items-center justify-center rounded-lg flex-shrink-0"
							style={{
								width: 32,
								height: 32,
								backgroundColor:
									"color-mix(in srgb, var(--accent) 14%, transparent)",
								color: "var(--accent)",
							}}
						>
							<Sparkles size={16} />
						</div>
						<div className="flex-1 min-w-0">
							<div
								className="font-semibold"
								style={{ fontSize: 13, color: "var(--fg-primary)" }}
							>
								You're now on Abundio {note.version}
							</div>
							<div
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									marginTop: 2,
								}}
							>
								Here's what changed.
							</div>
						</div>
						<button
							type="button"
							aria-label="Dismiss"
							onClick={dismiss}
							className="flex-shrink-0 rounded-md flex items-center justify-center transition-colors"
							style={{ width: 22, height: 22, color: "var(--fg-secondary)" }}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = "transparent";
							}}
						>
							<X size={13} />
						</button>
					</div>

					<div
						className="flex-1 min-h-0 overflow-y-auto"
						style={{ padding: "0 16px" }}
					>
						<ReleaseNotesMarkdown body={note.body} />
					</div>

					<div
						className="flex items-center gap-2 flex-shrink-0"
						style={{ padding: "10px 16px 14px" }}
					>
						<button
							type="button"
							onClick={() => {
								invoke("open_settings_window", {
									section: "updates",
								}).catch(() => {});
								dismiss();
							}}
							className="rounded-md transition-colors font-medium"
							style={{
								fontSize: 12,
								padding: "7px 10px",
								color: "var(--fg-primary)",
								backgroundColor: "var(--bg-tertiary)",
								border: "1px solid var(--border)",
							}}
						>
							Open in Settings
						</button>
						<button
							type="button"
							onClick={dismiss}
							className="rounded-md transition-colors"
							style={{
								fontSize: 12,
								padding: "7px 10px",
								color: "var(--fg-secondary)",
								backgroundColor: "transparent",
								marginLeft: "auto",
							}}
						>
							Dismiss
						</button>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
