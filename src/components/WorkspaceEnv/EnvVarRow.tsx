import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, ChevronRight, Lock, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EnvVarMeta } from "../../lib/ipc";
import { formatValueSize } from "./formatValueSize";

interface Props {
	variable: EnvVarMeta;
	/** Plaintext, present only while THIS row is the expanded one. */
	revealedValue: string | null;
	expanded: boolean;
	/** True when the master key is unavailable — every row renders locked. */
	locked: boolean;
	/** Name of the Workspace an inherited value comes from, for the tooltip. */
	inheritedFrom?: string;
	onToggle: () => void;
	onSave: (value: string) => void;
	onDelete: () => void;
}

/**
 * One variable. Collapsed it shows only a name, a dot mask and a size — enough
 * to tell a token from a certificate without putting a secret on screen.
 * Expanding IS the reveal: it fetches the plaintext for this one variable.
 */
export function EnvVarRow({
	variable,
	revealedValue,
	expanded,
	locked,
	inheritedFrom,
	onToggle,
	onSave,
	onDelete,
}: Props) {
	const [draft, setDraft] = useState("");
	const [hoverDelete, setHoverDelete] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Resync when the reveal resolves, or when a different row takes the slot.
	useEffect(() => {
		setDraft(revealedValue ?? "");
	}, [revealedValue]);

	useEffect(() => {
		if (expanded && revealedValue !== null) {
			requestAnimationFrame(() => textareaRef.current?.focus());
		}
	}, [expanded, revealedValue]);

	const unreadable = locked || variable.undecryptable;
	const dirty = revealedValue !== null && draft !== revealedValue;

	return (
		<div
			className="flex flex-col group"
			style={{
				borderBottom: "1px solid var(--border)",
			}}
		>
			<div
				className="flex items-center"
				style={{ gap: 8, padding: "7px 10px", minHeight: 34 }}
			>
				<button
					type="button"
					onClick={unreadable ? undefined : onToggle}
					disabled={unreadable}
					aria-expanded={expanded}
					className="flex items-center"
					title={
						unreadable
							? "This value cannot be decrypted with the current key"
							: expanded
								? "Hide value"
								: "Show and edit value"
					}
					style={{
						gap: 8,
						flex: 1,
						minWidth: 0,
						background: "none",
						border: "none",
						padding: 0,
						cursor: unreadable ? "default" : "pointer",
						textAlign: "left",
						color: "inherit",
					}}
				>
					{unreadable ? (
						<Lock size={12} style={{ color: "var(--error)", flexShrink: 0 }} />
					) : (
						<ChevronRight
							size={13}
							style={{
								color: "var(--fg-secondary)",
								flexShrink: 0,
								transform: expanded ? "rotate(90deg)" : "none",
								transition: "transform 0.15s ease",
							}}
						/>
					)}

					<span
						className="truncate"
						style={{
							fontFamily: "var(--font-mono, ui-monospace, monospace)",
							fontSize: 12,
							color: variable.inherited
								? "var(--fg-secondary)"
								: "var(--fg-primary)",
							opacity: variable.inherited ? 0.85 : 1,
						}}
					>
						{variable.name}
					</span>

					{variable.inherited && (
						<span
							className="flex items-center"
							title={
								inheritedFrom
									? `Inherited from ${inheritedFrom} — editing creates an override here`
									: "Inherited from the main worktree"
							}
							style={{
								gap: 2,
								flexShrink: 0,
								padding: "1px 5px 1px 3px",
								borderRadius: 4,
								fontSize: 9.5,
								fontWeight: 600,
								letterSpacing: "0.04em",
								color: "var(--fg-secondary)",
								backgroundColor:
									"color-mix(in srgb, var(--fg-secondary) 14%, transparent)",
							}}
						>
							<ArrowUp size={9} />
							INHERITED
						</span>
					)}

					<span
						className="truncate"
						style={{
							marginLeft: "auto",
							fontSize: 11,
							color: "var(--fg-secondary)",
							letterSpacing: "0.06em",
							flexShrink: 0,
						}}
					>
						{unreadable
							? "unreadable"
							: `•••••••• · ${formatValueSize(variable.byteLen)}`}
					</span>
				</button>

				{/* No delete for an inherited row: the value lives on the main
				    worktree, so there is nothing here to remove — the DELETE would
				    silently match zero rows. Remove it where it is defined, or
				    override it. */}
				{!variable.inherited && (
					<button
						type="button"
						onClick={onDelete}
						// Deletion stays available on an unreadable OWN row — it is the
						// only way out of a database restored without its key.
						title={`Delete ${variable.name}`}
						aria-label={`Delete ${variable.name}`}
						className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
						onMouseEnter={() => setHoverDelete(true)}
						onMouseLeave={() => setHoverDelete(false)}
						style={{
							background: "none",
							border: "none",
							padding: 2,
							cursor: "pointer",
							flexShrink: 0,
							color: hoverDelete ? "var(--error)" : "var(--fg-secondary)",
						}}
					>
						<X size={13} />
					</button>
				)}
			</div>

			<AnimatePresence initial={false}>
				{expanded && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
						style={{ overflow: "hidden" }}
					>
						<div
							className="flex flex-col"
							style={{ gap: 8, padding: "0 10px 10px 29px" }}
						>
							<textarea
								ref={textareaRef}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								spellCheck={false}
								autoComplete="off"
								style={{
									width: "100%",
									minHeight: 96,
									maxHeight: 260,
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid var(--border)",
									backgroundColor: "var(--bg-primary)",
									color: "var(--fg-primary)",
									// `pre` rather than `pre-wrap`: a PEM's line breaks are
									// meaningful and soft-wrapping them hides where they are.
									whiteSpace: "pre",
									overflowWrap: "normal",
									overflowX: "auto",
									fontFamily: "var(--font-mono, ui-monospace, monospace)",
									fontSize: 12,
									lineHeight: 1.5,
									resize: "vertical",
									outline: "none",
								}}
							/>
							<div className="flex items-center" style={{ gap: 10 }}>
								{variable.inherited && (
									<span
										style={{ fontSize: 10.5, color: "var(--fg-secondary)" }}
									>
										Saving creates an override on this worktree.
									</span>
								)}
								<button
									type="button"
									onClick={() => onSave(draft)}
									disabled={!dirty}
									className="transition-opacity"
									style={{
										marginLeft: "auto",
										padding: "5px 12px",
										borderRadius: 6,
										border: "none",
										backgroundColor: dirty
											? "var(--accent)"
											: "var(--bg-tertiary)",
										color: dirty ? "#fff" : "var(--fg-secondary)",
										fontSize: 11,
										fontWeight: 600,
										cursor: dirty ? "pointer" : "not-allowed",
										opacity: dirty ? 1 : 0.6,
									}}
								>
									Save value
								</button>
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
