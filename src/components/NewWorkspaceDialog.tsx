import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	FallbackAgentIcon,
	getAgentIconComponent,
	TerminalBrandIcon,
} from "../lib/agentIcons";
import type { CodingAgent } from "../lib/types";
import { useSettingsStore } from "../stores/settingsStore";
import type { LaunchChoice } from "./LaunchPicker";

interface NewWorkspaceDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (args: {
		name: string;
		folderPath: string;
		choice: LaunchChoice;
	}) => void;
}

interface Option {
	key: string;
	label: string;
	commandHint: string;
	choice: LaunchChoice;
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || "";
}

export function NewWorkspaceDialog({
	isOpen,
	onClose,
	onSubmit,
}: NewWorkspaceDialogProps) {
	const agents = useSettingsStore((s) => s.agents);
	const containerRef = useRef<HTMLDivElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);

	const [name, setName] = useState("");
	const [folderPath, setFolderPath] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const nameDirtyRef = useRef(false);

	const options: Option[] = useMemo(() => {
		const list: Option[] = [
			{
				key: "__terminal__",
				label: "New Terminal",
				commandHint: "shell",
				choice: { kind: "terminal" },
			},
		];
		for (const agent of agents.filter((a) => a.enabled)) {
			list.push({
				key: agent.id,
				label: agent.name,
				commandHint: [agent.command, ...(agent.args ?? [])].join(" "),
				choice: { kind: "agent", agent },
			});
		}
		return list;
	}, [agents]);

	// Reset state on open
	useEffect(() => {
		if (isOpen) {
			setName("");
			setFolderPath("");
			setSelectedIndex(0);
			nameDirtyRef.current = false;
			requestAnimationFrame(() => nameInputRef.current?.focus());
		}
	}, [isOpen]);

	const isValid =
		name.trim().length > 0 &&
		folderPath.length > 0 &&
		selectedIndex >= 0 &&
		selectedIndex < options.length;

	const submit = () => {
		if (!isValid) return;
		const opt = options[selectedIndex];
		onSubmit({
			name: name.trim(),
			folderPath,
			choice: opt.choice,
		});
		onClose();
	};

	const pickFolder = async () => {
		const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
		const folder = await openDialog({ directory: true, multiple: false });
		if (!folder) return;
		const path = typeof folder === "string" ? folder : folder[0];
		if (!path) return;
		setFolderPath(path);
		if (!nameDirtyRef.current && name.trim().length === 0) {
			const derived = basename(path);
			if (derived) setName(derived);
		}
	};

	const onContainerKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			onClose();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIndex((i) => (i + 1) % options.length);
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIndex((i) => (i - 1 + options.length) % options.length);
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			submit();
		}
	};

	return (
		<AnimatePresence>
			{isOpen && (
				<motion.div
					role="presentation"
					className="fixed inset-0 z-[200] flex items-center justify-center"
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
						ref={containerRef}
						role="dialog"
						aria-label="Create a workspace"
						tabIndex={-1}
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
						onKeyDown={onContainerKeyDown}
					>
						{/* Header */}
						<div
							className="flex flex-col"
							style={{ padding: "32px 36px 20px 36px" }}
						>
							<span
								style={{
									color: "var(--accent)",
									fontSize: 10,
									fontWeight: 600,
									letterSpacing: "0.14em",
									textTransform: "uppercase",
									marginBottom: 10,
								}}
							>
								New Workspace
							</span>
							<h2
								style={{
									color: "var(--fg-primary)",
									fontSize: 19,
									fontWeight: 600,
									letterSpacing: "-0.01em",
									lineHeight: 1.2,
								}}
							>
								Create a workspace
							</h2>
						</div>

						{/* Form body */}
						<div
							className="flex flex-col"
							style={{
								padding: "8px 36px 20px 36px",
								gap: 18,
								borderTop: "1px solid var(--border)",
								paddingTop: 22,
							}}
						>
							{/* Name */}
							<div className="flex flex-col" style={{ gap: 6 }}>
								<label htmlFor="nw-name" style={fieldLabelStyle}>
									Name
								</label>
								<input
									id="nw-name"
									ref={nameInputRef}
									type="text"
									value={name}
									placeholder="My workspace"
									onChange={(e) => {
										nameDirtyRef.current = true;
										setName(e.target.value);
									}}
									style={inputStyle}
								/>
							</div>

							{/* Folder */}
							<div className="flex flex-col" style={{ gap: 6 }}>
								<span style={fieldLabelStyle}>Folder</span>
								<button
									type="button"
									onClick={pickFolder}
									className="flex items-center text-left transition-colors"
									style={{
										...inputStyle,
										gap: 10,
										cursor: "pointer",
										color: folderPath
											? "var(--fg-primary)"
											: "var(--fg-secondary)",
									}}
								>
									<Folder
										size={15}
										style={{
											flexShrink: 0,
											color: folderPath
												? "var(--accent)"
												: "var(--fg-secondary)",
										}}
									/>
									<span
										className="truncate"
										style={{
											fontFamily: folderPath
												? "var(--font-mono, ui-monospace, SFMono-Regular, monospace)"
												: undefined,
											fontSize: folderPath ? 12 : 13,
										}}
									>
										{folderPath || "Choose folder…"}
									</span>
								</button>
							</div>

							{/* Agent */}
							<div className="flex flex-col" style={{ gap: 6 }}>
								<span style={fieldLabelStyle}>Launch with</span>
								<div
									className="flex flex-col"
									style={{
										gap: 2,
										maxHeight: 232,
										overflowY: "auto",
										paddingRight: 2,
									}}
								>
									{options.map((opt, idx) => {
										const isTerminal = opt.choice.kind === "terminal";
										const isSelected = idx === selectedIndex;
										const AgentBrand =
											opt.choice.kind === "agent"
												? getAgentIconComponent(
														(opt.choice.agent as CodingAgent).id,
													)
												: undefined;
										return (
											<button
												type="button"
												key={opt.key}
												onClick={() => setSelectedIndex(idx)}
												onDoubleClick={() => {
													setSelectedIndex(idx);
													submit();
												}}
												className="group relative flex items-center rounded-xl text-left cursor-pointer transition-all"
												style={{
													height: 48,
													padding: "0 14px 0 16px",
													gap: 12,
													backgroundColor: isSelected
														? "color-mix(in srgb, var(--accent) 16%, var(--bg-primary))"
														: "transparent",
													border: `1px solid ${
														isSelected
															? "color-mix(in srgb, var(--accent) 55%, var(--border))"
															: "transparent"
													}`,
													boxShadow: isSelected
														? "0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)"
														: "none",
													color: isSelected
														? "var(--fg-primary)"
														: "var(--fg-secondary)",
												}}
											>
												<span
													aria-hidden
													style={{
														position: "absolute",
														left: 5,
														top: 11,
														bottom: 11,
														width: 3,
														borderRadius: 3,
														backgroundColor: isSelected
															? "var(--accent)"
															: "transparent",
														transition: "background-color 120ms ease-out",
													}}
												/>
												<div
													className="flex items-center justify-center flex-shrink-0 overflow-hidden"
													style={{
														width: 32,
														height: 32,
														borderRadius: 8,
														backgroundColor: isSelected
															? "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))"
															: "var(--bg-primary)",
														border: `1px solid ${
															isSelected
																? "color-mix(in srgb, var(--accent) 35%, var(--border))"
																: "var(--border)"
														}`,
														boxShadow: isSelected
															? "0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)"
															: "inset 0 0 0 1px rgba(255,255,255,0.03)",
														transition: "all 140ms ease-out",
													}}
												>
													{isTerminal ? (
														<TerminalBrandIcon size={22} />
													) : AgentBrand ? (
														<AgentBrand size={20} />
													) : (
														<FallbackAgentIcon
															size={16}
															strokeWidth={1.8}
															style={{ color: "var(--fg-secondary)" }}
														/>
													)}
												</div>
												<div className="flex flex-col min-w-0 flex-1">
													<span
														className="truncate"
														style={{
															fontSize: 13,
															fontWeight: 550,
															letterSpacing: "-0.005em",
															color: "var(--fg-primary)",
														}}
													>
														{opt.label}
													</span>
													<span
														className="truncate"
														style={{
															fontSize: 11,
															marginTop: 1,
															color: "var(--fg-secondary)",
															fontFamily:
																"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
															opacity: 0.85,
														}}
													>
														{isTerminal ? "$ shell" : `$ ${opt.commandHint}`}
													</span>
												</div>
											</button>
										);
									})}
								</div>
							</div>
						</div>

						{/* Footer */}
						<div
							className="flex items-center"
							style={{
								padding: "12px 20px 12px 28px",
								gap: 22,
								borderTop: "1px solid var(--border)",
								backgroundColor:
									"color-mix(in srgb, var(--bg-primary) 55%, var(--bg-secondary))",
								color: "var(--fg-secondary)",
								fontSize: 11,
							}}
						>
							<span className="flex items-center" style={{ gap: 6 }}>
								<kbd style={kbdStyle}>Esc</kbd>
								<span style={{ marginLeft: 2 }}>Close</span>
							</span>
							<span className="flex items-center" style={{ gap: 6 }}>
								<kbd style={kbdStyle}>↑</kbd>
								<kbd style={kbdStyle}>↓</kbd>
								<span style={{ marginLeft: 2 }}>Agent</span>
							</span>
							<button
								type="button"
								onClick={submit}
								disabled={!isValid}
								className="flex items-center transition-opacity"
								style={{
									marginLeft: "auto",
									gap: 8,
									padding: "7px 14px",
									borderRadius: 6,
									backgroundColor: isValid
										? "var(--accent)"
										: "color-mix(in srgb, var(--accent) 30%, transparent)",
									color: "#fff",
									fontSize: 12,
									fontWeight: 600,
									letterSpacing: "0.01em",
									cursor: isValid ? "pointer" : "not-allowed",
									opacity: isValid ? 1 : 0.6,
									border: "none",
								}}
							>
								<span>Create</span>
								<CornerDownLeft size={13} />
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

const fieldLabelStyle: React.CSSProperties = {
	fontSize: 10.5,
	fontWeight: 600,
	letterSpacing: "0.1em",
	textTransform: "uppercase",
	color: "var(--fg-secondary)",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	height: 36,
	padding: "0 12px",
	borderRadius: 8,
	border: "1px solid var(--border)",
	backgroundColor: "var(--bg-primary)",
	color: "var(--fg-primary)",
	fontSize: 13,
	outline: "none",
};

const kbdStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	minWidth: 20,
	height: 20,
	padding: "0 6px",
	borderRadius: 5,
	border: "1px solid var(--border)",
	backgroundColor: "var(--bg-tertiary)",
	color: "var(--fg-primary)",
	fontSize: 10,
	fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
	boxShadow: "0 1px 0 rgba(0,0,0,0.35), inset 0 -1px 0 rgba(0,0,0,0.25)",
};
