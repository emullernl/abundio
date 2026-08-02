import { AnimatePresence, motion } from "framer-motion";
import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { type ParsedEnvEntry, parseDotenv } from "../../lib/dotenvParse";
import { fs } from "../../lib/ipc";

interface Props {
	bundle: string;
	/** Names already in the bundle, to show what an import would overwrite. */
	existingNames: string[];
	/** Where the file picker opens — almost always where the .env already is. */
	workspaceFolder: string;
	onImport: (entries: ParsedEnvEntry[]) => void;
	onClose: () => void;
}

/**
 * Bulk import of a pasted `.env`.
 *
 * The preview lists NAMES only, never values — the whole point of the feature is
 * to get these out of a file a scraper can read, so it would be perverse to
 * render them all on screen. The pasted text is unavoidably plaintext in the JS
 * heap while this dialog is open; it is dropped on close and never stored.
 */
export function EnvImportDialog({
	bundle,
	existingNames,
	workspaceFolder,
	onImport,
	onClose,
}: Props) {
	const [text, setText] = useState("");
	const [sourcePath, setSourcePath] = useState<string | null>(null);
	const [readError, setReadError] = useState<string | null>(null);

	const pickFile = async () => {
		const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
		// No extension filter: `.env` has no extension at all as far as the OS is
		// concerned, and `.env.production` would filter as "production" — any
		// filter here would hide the very files people are looking for.
		const picked = await openDialog({
			directory: false,
			multiple: false,
			defaultPath: workspaceFolder,
			title: "Choose a .env file",
		});
		const path = typeof picked === "string" ? picked : picked?.[0];
		if (!path) return;

		setReadError(null);
		try {
			const file = await fs.readFile(path);
			if (file.fileType !== "text" || file.content === null) {
				setReadError("That file isn't readable as text.");
				return;
			}
			setText(file.content);
			setSourcePath(path);
		} catch (e) {
			setReadError(typeof e === "string" ? e : "Could not read that file.");
		}
	};

	const parsed = useMemo(() => parseDotenv(text), [text]);
	const existing = useMemo(() => new Set(existingNames), [existingNames]);
	const overwriting = parsed.entries.filter((e) => existing.has(e.name)).length;
	const canImport = parsed.entries.length > 0;

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[210] flex items-center justify-center"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				style={{
					backgroundColor: "rgba(0,0,0,0.55)",
					backdropFilter: "blur(6px)",
					WebkitBackdropFilter: "blur(6px)",
				}}
				onClick={onClose}
			>
				<motion.div
					role="dialog"
					aria-label="Import environment variables"
					className="rounded-2xl overflow-hidden flex flex-col outline-none"
					initial={{ opacity: 0, scale: 0.96, y: 12 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.96, y: 12 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 520,
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 40px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.stopPropagation();
							onClose();
						}
					}}
				>
					<div className="flex flex-col" style={{ padding: "22px 28px 14px" }}>
						<span
							style={{
								color: "var(--accent)",
								fontSize: 10,
								fontWeight: 600,
								letterSpacing: "0.14em",
								textTransform: "uppercase",
								marginBottom: 8,
							}}
						>
							Import into {bundle}
						</span>
						<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
							Choose a <code>.env</code> file or paste its contents. Once
							imported you can delete the file — the values live encrypted in
							Abundio.
						</span>
					</div>

					<div
						className="flex items-center"
						style={{ padding: "0 28px 12px", gap: 10 }}
					>
						<button
							type="button"
							onClick={pickFile}
							className="flex items-center transition-colors"
							style={{
								gap: 6,
								padding: "6px 12px",
								borderRadius: 6,
								border: "1px solid var(--border)",
								backgroundColor: "var(--bg-primary)",
								color: "var(--fg-primary)",
								fontSize: 11.5,
								fontWeight: 500,
								cursor: "pointer",
								flexShrink: 0,
							}}
						>
							<FolderOpen size={13} />
							Choose file…
						</button>
						{sourcePath ? (
							<span
								className="truncate"
								title={sourcePath}
								style={{
									minWidth: 0,
									fontFamily: "var(--font-mono, ui-monospace, monospace)",
									fontSize: 11,
									color: "var(--fg-secondary)",
									direction: "rtl",
									textAlign: "left",
								}}
							>
								{sourcePath}
							</span>
						) : (
							<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
								Opens in the workspace folder. Press{" "}
								<kbd style={kbdStyle}>⌘⇧.</kbd> to show dotfiles.
							</span>
						)}
					</div>

					{readError && (
						<div
							style={{
								margin: "0 28px 12px",
								fontSize: 11,
								color: "var(--error)",
							}}
						>
							{readError}
						</div>
					)}

					<div style={{ padding: "0 28px 14px" }}>
						<textarea
							// biome-ignore lint/a11y/noAutofocus: this dialog exists solely to receive a paste
							autoFocus
							value={text}
							onChange={(e) => {
								setText(e.target.value);
								// Editing detaches from the chosen file — the path would
								// otherwise claim to describe text it no longer matches.
								setSourcePath(null);
							}}
							spellCheck={false}
							placeholder={
								"DATABASE_URL=postgres://…\nexport STRIPE_SECRET_KEY=sk_live_…\nAPI_PORT=8080"
							}
							style={{
								width: "100%",
								height: 180,
								padding: "10px 12px",
								borderRadius: 8,
								border: "1px solid var(--border)",
								backgroundColor: "var(--bg-primary)",
								color: "var(--fg-primary)",
								fontFamily: "var(--font-mono, ui-monospace, monospace)",
								fontSize: 12,
								lineHeight: 1.5,
								resize: "vertical",
								outline: "none",
							}}
						/>
					</div>

					{text.trim() !== "" && (
						<div
							className="flex flex-col"
							style={{
								margin: "0 28px 14px",
								padding: "10px 12px",
								borderRadius: 8,
								gap: 6,
								backgroundColor: "var(--bg-primary)",
								border: "1px solid var(--border)",
							}}
						>
							<span style={{ fontSize: 12, color: "var(--fg-primary)" }}>
								<strong>{parsed.entries.length}</strong>{" "}
								{parsed.entries.length === 1 ? "variable" : "variables"}
								{overwriting > 0 && (
									<>
										{" · "}
										<span style={{ color: "var(--warning, var(--accent))" }}>
											{overwriting} will overwrite
										</span>
									</>
								)}
							</span>

							{parsed.entries.length > 0 && (
								<span
									style={{
										fontFamily: "var(--font-mono, ui-monospace, monospace)",
										fontSize: 11,
										color: "var(--fg-secondary)",
										wordBreak: "break-word",
									}}
								>
									{parsed.entries.map((e) => e.name).join("  ")}
								</span>
							)}

							{parsed.unterminated.length > 0 && (
								<span style={{ fontSize: 11, color: "var(--error)" }}>
									{parsed.unterminated.join(", ")}{" "}
									{parsed.unterminated.length === 1 ? "opens" : "open"} a quote
									that is never closed — skipped rather than imported
									half-finished. Check the file is complete.
								</span>
							)}

							{parsed.invalidNames.length > 0 && (
								<span style={{ fontSize: 11, color: "var(--error)" }}>
									Skipped {parsed.invalidNames.length} invalid or reserved{" "}
									{parsed.invalidNames.length === 1 ? "name" : "names"}:{" "}
									{parsed.invalidNames.join(", ")}
								</span>
							)}

							{parsed.skippedLines > 0 && (
								<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
									Ignored {parsed.skippedLines}{" "}
									{parsed.skippedLines === 1 ? "line" : "lines"} with no{" "}
									<code>=</code>.
								</span>
							)}
						</div>
					)}

					<div
						className="flex items-center"
						style={{
							padding: "12px 28px",
							gap: 16,
							borderTop: "1px solid var(--border)",
							backgroundColor:
								"color-mix(in srgb, var(--bg-primary) 55%, var(--bg-secondary))",
							color: "var(--fg-secondary)",
							fontSize: 11,
						}}
					>
						<span>Esc to cancel</span>
						<button
							type="button"
							onClick={() => {
								onImport(parsed.entries);
								setText("");
							}}
							disabled={!canImport}
							className="transition-opacity"
							style={{
								marginLeft: "auto",
								padding: "7px 16px",
								borderRadius: 6,
								border: "none",
								backgroundColor: canImport
									? "var(--accent)"
									: "var(--bg-tertiary)",
								color: canImport ? "#fff" : "var(--fg-secondary)",
								fontSize: 12,
								fontWeight: 600,
								cursor: canImport ? "pointer" : "not-allowed",
								opacity: canImport ? 1 : 0.6,
							}}
						>
							{canImport
								? `Import ${parsed.entries.length}`
								: "Nothing to import"}
						</button>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}

const kbdStyle: React.CSSProperties = {
	fontFamily: "var(--font-mono, ui-monospace, monospace)",
	fontSize: 10,
	padding: "1px 4px",
	borderRadius: 4,
	backgroundColor: "var(--bg-tertiary)",
	border: "1px solid var(--border)",
};
