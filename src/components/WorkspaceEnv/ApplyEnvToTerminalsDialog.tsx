import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { type LivePane, restartWorkspacePtys } from "../../lib/paneRestart";
import { useWorkspaceEnvStore } from "../../stores/workspaceEnvStore";

interface Props {
	workspaceId: string;
	panes: LivePane[];
	onClose: () => void;
}

/**
 * Confirm restarting a Workspace's running terminals so they pick up the new
 * injected Bundle.
 *
 * Not `ConfirmDialog`: that takes a single centred `message` at 320px wide,
 * which cannot show which panes are affected — and "two agents will lose their
 * session" is exactly the information that makes this decision safe.
 */
export function ApplyEnvToTerminalsDialog({
	workspaceId,
	panes,
	onClose,
}: Props) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const clearDirty = useWorkspaceEnvStore((s) => s.clearInjectedDirty);

	const agentCount = panes.filter((p) => p.agentId).length;

	const run = async () => {
		setBusy(true);
		setFailure(null);
		const { restarted, failed } = await restartWorkspacePtys(workspaceId);
		setBusy(false);

		if (failed > 0) {
			// Report it and stay open. Clearing the dirty flag here would remove
			// the only affordance for trying again, while telling the user
			// nothing went wrong.
			setFailure(
				restarted > 0
					? `Restarted ${restarted}, but ${failed} could not be restarted.`
					: `Could not restart ${failed === 1 ? "the terminal" : "any of the terminals"}.`,
			);
			return;
		}

		clearDirty(workspaceId);
		onClose();
	};

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[220] flex items-center justify-center"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
				onClick={busy ? undefined : onClose}
			>
				<motion.div
					role="dialog"
					aria-label="Apply environment to running terminals"
					className="rounded-2xl overflow-hidden flex flex-col outline-none"
					initial={{ opacity: 0, scale: 0.96, y: 12 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.96, y: 12 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 440,
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow: "0 40px 80px rgba(0,0,0,0.55)",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (e.key === "Escape" && !busy) {
							e.stopPropagation();
							onClose();
						}
					}}
				>
					<div
						className="flex flex-col items-center"
						style={{ padding: "24px 28px 8px", gap: 12 }}
					>
						<div
							className="flex items-center justify-center rounded-full"
							style={{
								width: 40,
								height: 40,
								backgroundColor:
									"color-mix(in srgb, var(--error) 16%, transparent)",
							}}
						>
							<AlertTriangle size={18} style={{ color: "var(--error)" }} />
						</div>
						<h3
							style={{
								color: "var(--fg-primary)",
								fontSize: 15,
								fontWeight: 600,
							}}
						>
							Restart {panes.length}{" "}
							{panes.length === 1 ? "terminal" : "terminals"}?
						</h3>
					</div>

					<div
						className="flex flex-col"
						style={{
							margin: "4px 28px 0",
							maxHeight: 200,
							overflowY: "auto",
							borderRadius: 8,
							border: "1px solid var(--border)",
							backgroundColor: "var(--bg-primary)",
						}}
					>
						{panes.map((pane) => (
							<div
								key={pane.paneId}
								className="flex items-center"
								style={{
									gap: 8,
									padding: "6px 10px",
									fontSize: 11.5,
									color: "var(--fg-secondary)",
								}}
							>
								<span
									className="truncate"
									style={{ color: "var(--fg-primary)", minWidth: 0 }}
								>
									{pane.tabName}
								</span>
								<span
									className="truncate"
									style={{
										fontFamily: "var(--font-mono, ui-monospace, monospace)",
										fontSize: 11,
										minWidth: 0,
										flex: 1,
									}}
								>
									{pane.title || (pane.agentId ?? "shell")}
								</span>
								{(pane.state === "active" || pane.state === "waiting") && (
									<span
										style={{
											color:
												pane.state === "active"
													? "var(--accent)"
													: "var(--warning, var(--accent))",
											fontSize: 10,
											fontWeight: 600,
											flexShrink: 0,
										}}
									>
										{pane.state === "active" ? "busy" : "waiting"}
									</span>
								)}
							</div>
						))}
					</div>

					<p
						style={{
							padding: "12px 28px 4px",
							fontSize: 11.5,
							lineHeight: 1.5,
							color: "var(--fg-secondary)",
						}}
					>
						{agentCount > 0 ? (
							<>
								{agentCount} running {agentCount === 1 ? "agent" : "agents"}{" "}
								will lose the current session and relaunch from scratch.
								Scrollback is preserved.
							</>
						) : (
							<>
								Each shell is replaced with a fresh one. Scrollback is
								preserved; anything running in these terminals is terminated.
							</>
						)}
					</p>

					{failure && (
						<p
							style={{
								padding: "0 28px",
								fontSize: 11.5,
								lineHeight: 1.5,
								color: "var(--error)",
							}}
						>
							{failure}
						</p>
					)}

					<div
						className="flex items-center"
						style={{ padding: "14px 28px 18px", gap: 10 }}
					>
						<button
							type="button"
							onClick={onClose}
							disabled={busy}
							style={{
								flex: 1,
								padding: "8px 0",
								borderRadius: 8,
								border: "1px solid var(--border)",
								backgroundColor: "transparent",
								color: "var(--fg-primary)",
								fontSize: 12,
								fontWeight: 500,
								cursor: busy ? "not-allowed" : "pointer",
							}}
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={run}
							disabled={busy}
							style={{
								flex: 1,
								padding: "8px 0",
								borderRadius: 8,
								border: "none",
								backgroundColor: "var(--error)",
								color: "#fff",
								fontSize: 12,
								fontWeight: 600,
								cursor: busy ? "not-allowed" : "pointer",
								opacity: busy ? 0.7 : 1,
							}}
						>
							{busy
								? "Restarting…"
								: failure
									? "Try again"
									: `Restart ${panes.length === 1 ? "terminal" : "all"}`}
						</button>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
