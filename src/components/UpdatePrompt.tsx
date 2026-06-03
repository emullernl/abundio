import { open } from "@tauri-apps/plugin-shell";
import { AnimatePresence, motion } from "framer-motion";
import { Download, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { releaseNotesUrl, useUpdateStore } from "../stores/updateStore";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Non-blocking "update available" card, bottom-right of a Profile-bound Window.
 * Surfaced by the Rust background check (focused Window only — see ADR-0014).
 * Offers Install (download → stage, applied on quit), Later, and Skip this
 * version. Once staged, shows "will install on quit" with a guarded Restart now.
 */
export function UpdatePrompt() {
	const status = useUpdateStore((s) => s.status);
	const info = useUpdateStore((s) => s.info);
	const dismissed = useUpdateStore((s) => s.dismissed);
	const downloaded = useUpdateStore((s) => s.downloaded);
	const total = useUpdateStore((s) => s.total);
	const download = useUpdateStore((s) => s.download);
	const installNow = useUpdateStore((s) => s.installNow);
	const dismissLater = useUpdateStore((s) => s.dismissLater);
	const skipVersion = useUpdateStore((s) => s.skipVersion);

	const [confirmRestart, setConfirmRestart] = useState(false);

	const visible =
		!dismissed &&
		info != null &&
		(status === "available" || status === "downloading" || status === "ready");

	const pct =
		total && total > 0
			? Math.min(100, Math.round((downloaded / total) * 100))
			: null;

	return (
		<>
			<AnimatePresence>
				{visible && info && (
					<motion.div
						role="dialog"
						aria-label="Software update available"
						className="fixed z-[150] rounded-xl overflow-hidden"
						initial={{ opacity: 0, y: 16, scale: 0.98 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 16, scale: 0.98 }}
						transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
						style={{
							right: 16,
							bottom: 16,
							width: 320,
							backgroundColor: "var(--bg-secondary)",
							border: "1px solid var(--border)",
							boxShadow:
								"0 18px 48px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03) inset",
						}}
					>
						<div className="flex flex-col" style={{ padding: "14px 16px" }}>
							<div className="flex items-start gap-3">
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
									{status === "ready" ? (
										<RefreshCw size={16} />
									) : (
										<Download size={16} />
									)}
								</div>
								<div className="flex-1 min-w-0">
									<div
										className="font-semibold"
										style={{ fontSize: 13, color: "var(--fg-primary)" }}
									>
										{status === "ready"
											? "Update ready"
											: `Abundio ${info.version} is available`}
									</div>
									<div
										style={{
											fontSize: 11,
											color: "var(--fg-secondary)",
											marginTop: 2,
											lineHeight: 1.4,
										}}
									>
										{status === "ready"
											? "Restart Abundio to get the new version."
											: status === "downloading"
												? `Downloading…${pct != null ? ` ${pct}%` : ""}`
												: `You're on ${info.currentVersion}.`}
									</div>
									<button
										type="button"
										onClick={() =>
											open(releaseNotesUrl(info.version)).catch(() => {})
										}
										className="text-left transition-colors"
										style={{
											fontSize: 11,
											color: "var(--accent)",
											marginTop: 4,
											background: "transparent",
											border: "none",
											padding: 0,
											cursor: "pointer",
										}}
									>
										View release notes ↗
									</button>
								</div>
								{status !== "downloading" && (
									<button
										type="button"
										aria-label="Dismiss"
										onClick={dismissLater}
										className="flex-shrink-0 rounded-md flex items-center justify-center transition-colors"
										style={{
											width: 22,
											height: 22,
											color: "var(--fg-secondary)",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.backgroundColor =
												"var(--bg-tertiary)";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.backgroundColor = "transparent";
										}}
									>
										<X size={13} />
									</button>
								)}
							</div>

							{status === "downloading" && (
								<div
									className="rounded-full overflow-hidden"
									style={{
										height: 4,
										marginTop: 12,
										backgroundColor: "var(--bg-tertiary)",
									}}
								>
									<motion.div
										style={{
											height: "100%",
											backgroundColor: "var(--accent)",
											borderRadius: 999,
										}}
										initial={false}
										animate={{ width: pct != null ? `${pct}%` : "40%" }}
										transition={{ duration: 0.2 }}
									/>
								</div>
							)}

							{status === "available" && (
								<div
									className="flex items-center gap-2"
									style={{ marginTop: 12 }}
								>
									<button
										type="button"
										onClick={() => download()}
										className="flex-1 rounded-md transition-colors font-medium"
										style={{
											fontSize: 12,
											padding: "7px 10px",
											color: "white",
											backgroundColor: "var(--accent)",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.opacity = "0.85";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.opacity = "1";
										}}
									>
										Install
									</button>
									<button
										type="button"
										onClick={dismissLater}
										className="rounded-md transition-colors"
										style={{
											fontSize: 12,
											padding: "7px 10px",
											color: "var(--fg-secondary)",
											backgroundColor: "var(--bg-tertiary)",
										}}
									>
										Later
									</button>
									<button
										type="button"
										onClick={skipVersion}
										className="rounded-md transition-colors"
										style={{
											fontSize: 12,
											padding: "7px 8px",
											color: "var(--fg-secondary)",
											backgroundColor: "transparent",
										}}
										title={`Skip ${info.version} and don't ask again`}
										onMouseEnter={(e) => {
											e.currentTarget.style.color = "var(--fg-primary)";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.color = "var(--fg-secondary)";
										}}
									>
										Skip
									</button>
								</div>
							)}

							{status === "ready" && (
								<div
									className="flex items-center gap-2"
									style={{ marginTop: 12 }}
								>
									<button
										type="button"
										onClick={() => setConfirmRestart(true)}
										className="flex-1 rounded-md transition-colors font-medium"
										style={{
											fontSize: 12,
											padding: "7px 10px",
											color: "var(--fg-primary)",
											backgroundColor: "var(--bg-tertiary)",
											border: "1px solid var(--border)",
										}}
									>
										Restart now
									</button>
									<button
										type="button"
										onClick={dismissLater}
										className="rounded-md transition-colors"
										style={{
											fontSize: 12,
											padding: "7px 10px",
											color: "var(--fg-secondary)",
											backgroundColor: "transparent",
										}}
									>
										Dismiss
									</button>
								</div>
							)}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{confirmRestart && (
				<ConfirmDialog
					title="Restart to install update?"
					message="Restarting will close all windows and terminate any running terminals and agents. Unsaved work in editors will prompt to save."
					confirmLabel="Restart now"
					confirmVariant="danger"
					onConfirm={() => {
						setConfirmRestart(false);
						installNow();
					}}
					onCancel={() => setConfirmRestart(false)}
				/>
			)}
		</>
	);
}
