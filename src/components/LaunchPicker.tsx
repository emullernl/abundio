import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	FallbackAgentIcon,
	getAgentIconComponent,
	TerminalBrandIcon,
} from "../lib/agentIcons";
import type { CodingAgent } from "../lib/types";
import { useSettingsStore } from "../stores/settingsStore";

export type LaunchChoice =
	| { kind: "terminal" }
	| { kind: "agent"; agent: CodingAgent };

interface LaunchPickerProps {
	isOpen: boolean;
	title?: string;
	subtitle?: string;
	onClose: () => void;
	onSelect: (choice: LaunchChoice) => void;
}

interface Option {
	key: string;
	label: string;
	commandHint: string;
	choice: LaunchChoice;
}

export function LaunchPicker({
	isOpen,
	title = "Start a new session",
	subtitle,
	onClose,
	onSelect,
}: LaunchPickerProps) {
	const agents = useSettingsStore((s) => s.agents);
	const containerRef = useRef<HTMLDivElement>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);

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

	useEffect(() => {
		if (isOpen) {
			setSelectedIndex(0);
			requestAnimationFrame(() => containerRef.current?.focus());
		}
	}, [isOpen]);

	const activate = (choice: LaunchChoice) => {
		onSelect(choice);
		onClose();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
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
			const opt = options[selectedIndex];
			if (opt) activate(opt.choice);
			return;
		}
		if (/^[1-9]$/.test(e.key)) {
			const idx = Number(e.key) - 1;
			if (idx < options.length) {
				e.preventDefault();
				setSelectedIndex(idx);
				activate(options[idx].choice);
			}
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
						aria-label={title}
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
						onKeyDown={onKeyDown}
					>
						{/* Header */}
						<div
							className="flex flex-col"
							style={{ padding: "32px 36px 24px 36px" }}
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
								Launch
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
								{title}
							</h2>
							{subtitle && (
								<p
									style={{
										color: "var(--fg-secondary)",
										fontSize: 13,
										lineHeight: 1.5,
										marginTop: 8,
										maxWidth: 420,
									}}
								>
									{subtitle}
								</p>
							)}
						</div>

						{/* Options list */}
						<div
							className="flex flex-col"
							style={{
								padding: "12px 16px 20px 16px",
								gap: 4,
								borderTop: "1px solid var(--border)",
							}}
						>
							{options.map((opt, idx) => {
								const isTerminal = opt.choice.kind === "terminal";
								const isSelected = idx === selectedIndex;
								const AgentBrand =
									opt.choice.kind === "agent"
										? getAgentIconComponent(opt.choice.agent.id)
										: undefined;
								return (
									<button
										type="button"
										key={opt.key}
										onMouseEnter={() => setSelectedIndex(idx)}
										onClick={() => activate(opt.choice)}
										className="group relative flex items-center rounded-xl text-left cursor-pointer transition-colors"
										style={{
											height: 62,
											padding: "0 16px 0 18px",
											gap: 14,
											backgroundColor: isSelected
												? "var(--bg-tertiary)"
												: "transparent",
											color: isSelected
												? "var(--fg-primary)"
												: "var(--fg-secondary)",
										}}
									>
										{/* Left accent bar on selection */}
										<span
											aria-hidden
											style={{
												position: "absolute",
												left: 6,
												top: 14,
												bottom: 14,
												width: 3,
												borderRadius: 3,
												backgroundColor: isSelected
													? "var(--accent)"
													: "transparent",
												transition: "background-color 120ms ease-out",
											}}
										/>

										{/* Icon tile */}
										<div
											className="flex items-center justify-center flex-shrink-0 overflow-hidden"
											style={{
												width: 40,
												height: 40,
												borderRadius: 10,
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
												<TerminalBrandIcon size={28} />
											) : AgentBrand ? (
												<AgentBrand size={26} />
											) : (
												<FallbackAgentIcon
													size={18}
													strokeWidth={1.8}
													style={{ color: "var(--fg-secondary)" }}
												/>
											)}
										</div>

										{/* Label + command */}
										<div className="flex flex-col min-w-0 flex-1">
											<span
												className="truncate"
												style={{
													fontSize: 14,
													fontWeight: 550,
													letterSpacing: "-0.005em",
													color: isSelected
														? "var(--fg-primary)"
														: "var(--fg-primary)",
												}}
											>
												{opt.label}
											</span>
											<span
												className="truncate"
												style={{
													fontSize: 11.5,
													marginTop: 2,
													color: "var(--fg-secondary)",
													fontFamily:
														"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
													opacity: 0.85,
												}}
											>
												{isTerminal ? "$ shell" : `$ ${opt.commandHint}`}
											</span>
										</div>

										{/* Trailing affordance */}
										<div
											className="flex items-center flex-shrink-0"
											style={{ gap: 8 }}
										>
											{isSelected ? (
												<span
													className="flex items-center"
													style={{
														gap: 6,
														fontSize: 10.5,
														color: "var(--fg-secondary)",
														letterSpacing: "0.04em",
														textTransform: "uppercase",
													}}
												>
													<span>Launch</span>
													<CornerDownLeft
														size={13}
														style={{ color: "var(--accent)" }}
													/>
												</span>
											) : idx < 9 ? (
												<span style={indexBadgeStyle}>{idx + 1}</span>
											) : null}
										</div>
									</button>
								);
							})}
						</div>

						{/* Footer hint bar */}
						<div
							className="flex items-center"
							style={{
								padding: "14px 28px",
								gap: 22,
								borderTop: "1px solid var(--border)",
								backgroundColor:
									"color-mix(in srgb, var(--bg-primary) 55%, var(--bg-secondary))",
								color: "var(--fg-secondary)",
								fontSize: 11,
							}}
						>
							<span className="flex items-center" style={{ gap: 6 }}>
								<kbd style={kbdStyle}>↑</kbd>
								<kbd style={kbdStyle}>↓</kbd>
								<span style={{ marginLeft: 2 }}>Navigate</span>
							</span>
							<span className="flex items-center" style={{ gap: 6 }}>
								<kbd style={kbdStyle}>↵</kbd>
								<span style={{ marginLeft: 2 }}>Launch</span>
							</span>
							<span className="flex items-center" style={{ gap: 6 }}>
								<kbd style={kbdStyle}>1</kbd>
								<span style={{ marginLeft: 2 }}>Quick pick</span>
							</span>
							<span
								className="flex items-center ml-auto"
								style={{ gap: 6, marginLeft: "auto" }}
							>
								<kbd style={kbdStyle}>Esc</kbd>
								<span style={{ marginLeft: 2 }}>Close</span>
							</span>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

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

const indexBadgeStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 20,
	height: 20,
	borderRadius: 5,
	border: "1px solid var(--border)",
	backgroundColor: "color-mix(in srgb, var(--bg-primary) 60%, transparent)",
	color: "var(--fg-secondary)",
	fontSize: 10,
	fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
	opacity: 0.7,
};
