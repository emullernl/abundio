import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Download } from "lucide-react";
import { useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";

interface Props {
	bundle: string;
	/** Variables that would be written — own rows only. */
	count: number;
	/** How many of those come from the main worktree and are therefore left
	 *  out of the file. Shown so a zero-count export is not a mystery. */
	inheritedCount: number;
	workspaceFolder: string;
	/** Resolves to null on success, or the reason the export was refused.
	 *  The reason is shown HERE: the variables list that also carries it is
	 *  behind this modal, so "see the message in the list" was unreadable. */
	onExport: (path: string) => Promise<string | null>;
	onClose: () => void;
}

/**
 * Export one Bundle to a `.env` file.
 *
 * Deliberately shows no plaintext preview: the user asked to export, and the
 * one-value-at-a-time reveal invariant exists to keep secrets out of the
 * renderer. The confirmation names the bundle and the count instead, which is
 * what catches a wrong-bundle pick.
 */
export function EnvExportDialog({
	bundle,
	count,
	inheritedCount,
	workspaceFolder,
	onExport,
	onClose,
}: Props) {
	const [busy, setBusy] = useState(false);
	const [savedTo, setSavedTo] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	useEscapeKey(onClose);

	const pickAndExport = async () => {
		setFailed(null);
		let path: string | null = null;
		try {
			const { save } = await import("@tauri-apps/plugin-dialog");
			// `<folder>/<bundle>.env` rather than a bare `.env`: it is a file
			// people expect to see, and it will not silently replace the
			// project's own `.env` on a careless Enter.
			path = await save({
				defaultPath: `${workspaceFolder}/${bundle}.env`,
				title: `Export ${bundle} as .env`,
			});
		} catch {
			setFailed("The save dialog is unavailable.");
			return;
		}
		if (!path) return;

		setBusy(true);
		const refusal = await onExport(path);
		setBusy(false);
		if (refusal === null) setSavedTo(path);
		else setFailed(refusal);
	};

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				onClick={onClose}
				style={{
					position: "fixed",
					inset: 0,
					// Matches EnvImportDialog, its sibling in this section: the
					// two open from the same dialog and must stack alike.
					zIndex: 210,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: "rgba(0,0,0,0.45)",
				}}
			>
				<motion.div
					role="dialog"
					aria-label={`Export ${bundle} to a .env file`}
					initial={{ opacity: 0, scale: 0.97 }}
					animate={{ opacity: 1, scale: 1 }}
					exit={{ opacity: 0, scale: 0.97 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					style={{
						width: 460,
						maxWidth: "calc(100vw - 40px)",
						borderRadius: 12,
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
						padding: "18px 22px 22px",
						display: "flex",
						flexDirection: "column",
						gap: 12,
					}}
				>
					<div className="flex items-center" style={{ gap: 8 }}>
						<Download size={14} style={{ color: "var(--accent)" }} />
						<span style={{ fontSize: 13, fontWeight: 600 }}>
							Export {bundle} to a .env file
						</span>
					</div>

					{savedTo ? (
						<>
							<span
								style={{
									fontSize: 12,
									color: "var(--fg-secondary)",
									lineHeight: 1.5,
								}}
							>
								Written to{" "}
								<code style={{ wordBreak: "break-all" }}>{savedTo}</code>. It
								contains plaintext secrets — do not commit it.
							</span>
							<div className="flex justify-end" style={{ gap: 8 }}>
								<button
									type="button"
									className={primaryButtonClass}
									onClick={onClose}
								>
									Done
								</button>
							</div>
						</>
					) : (
						<>
							<span
								style={{
									fontSize: 12,
									color: "var(--fg-secondary)",
									lineHeight: 1.5,
								}}
							>
								{count === 0
									? `No variables of this workspace's own to export.`
									: `Writes ${count} ${count === 1 ? "variable" : "variables"} as NAME="value" lines, encrypted values decrypted on the way out.`}
							</span>
							{inheritedCount > 0 && (
								<span
									style={{
										fontSize: 11.5,
										color: "var(--fg-secondary)",
										lineHeight: 1.5,
									}}
								>
									{inheritedCount}{" "}
									{inheritedCount === 1
										? "variable is inherited from the main worktree and is not in the file"
										: "variables are inherited from the main worktree and are not in the file"}
									. Export there to include{" "}
									{inheritedCount === 1 ? "it" : "them"}.
								</span>
							)}
							{failed && (
								<div
									className="flex items-center"
									style={{
										gap: 8,
										padding: "8px 10px",
										borderRadius: 8,
										fontSize: 11.5,
										color: "var(--fg-primary)",
										backgroundColor:
											"color-mix(in srgb, var(--error) 12%, var(--bg-primary))",
										border:
											"1px solid color-mix(in srgb, var(--error) 35%, transparent)",
									}}
								>
									<AlertTriangle size={13} style={{ color: "var(--error)" }} />
									<span>{failed}</span>
								</div>
							)}
							<div className="flex justify-end" style={{ gap: 8 }}>
								<button
									type="button"
									className={secondaryButtonClass}
									onClick={onClose}
									disabled={busy}
								>
									Cancel
								</button>
								<button
									type="button"
									className={primaryButtonClass}
									onClick={pickAndExport}
									disabled={busy || count === 0}
								>
									{busy ? "Writing…" : "Choose file…"}
								</button>
							</div>
						</>
					)}
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
