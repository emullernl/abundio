import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	FallbackAgentIcon,
	getAgentIconComponent,
	TerminalBrandIcon,
} from "../lib/agentIcons";
import { worktrees } from "../lib/ipc";
import type { CodingAgent } from "../lib/types";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface Props {
	/** The primary worktree's folder — worktrees are added relative to it. */
	primaryCwd: string;
	primaryName: string;
	onClose: () => void;
}

type LaunchChoice =
	| { kind: "terminal" }
	| { kind: "agent"; agent: CodingAgent };

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Resolve a (possibly relative, possibly `..`-laden) path against a base. */
function resolvePath(base: string, rel: string): string {
	const combined = rel.startsWith("/") ? rel : `${base}/${rel}`;
	const stack: string[] = [];
	for (const part of combined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return `/${stack.join("/")}`;
}

/** Basic git ref validity: no spaces, no shell/ref-special chars, no `..`. */
function isValidBranch(branch: string): boolean {
	if (!branch || /\s/.test(branch)) return false;
	if (/[~^:?*[\\]/.test(branch)) return false;
	if (branch.includes("..")) return false;
	if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//"))
		return false;
	if (branch.startsWith("-")) return false;
	return true;
}

export function AddWorktreeDialog({ primaryCwd, primaryName, onClose }: Props) {
	const agents = useSettingsStore((s) => s.agents);
	const addWorktreeWorkspace = useWorkspaceStore((s) => s.addWorktreeWorkspace);
	const setupCommands = useWorkspaceStore(
		(s) =>
			s.workspaces.find((w) => w.rootFolder === primaryCwd)
				?.worktreeSetupCommands ?? "",
	);

	const branchInputRef = useRef<HTMLInputElement>(null);
	const [branch, setBranch] = useState("");
	const [folder, setFolder] = useState("");
	const folderDirty = useRef(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const repo = basename(primaryCwd);

	const options = useMemo(() => {
		const list: { key: string; label: string; choice: LaunchChoice }[] = [
			{
				key: "__terminal__",
				label: "New Terminal",
				choice: { kind: "terminal" },
			},
		];
		for (const agent of agents.filter((a) => a.enabled)) {
			list.push({
				key: agent.id,
				label: agent.name,
				choice: { kind: "agent", agent },
			});
		}
		return list;
	}, [agents]);

	useEffect(() => {
		requestAnimationFrame(() => branchInputRef.current?.focus());
	}, []);

	// Default folder follows the branch until the user edits it manually.
	useEffect(() => {
		if (folderDirty.current) return;
		const slug = branch.replace(/\//g, "-");
		setFolder(slug ? `../${repo}.worktrees/${slug}` : "");
	}, [branch, repo]);

	const absolutePath = folder ? resolvePath(primaryCwd, folder) : "";
	const branchValid = isValidBranch(branch);
	const isValid = branchValid && folder.length > 0 && !submitting;

	const submit = async () => {
		if (!isValid) return;
		setSubmitting(true);
		setError(null);
		try {
			const entry = await worktrees.add(primaryCwd, branch, absolutePath);
			const opt = options[selectedIndex];
			const agent = opt?.choice.kind === "agent" ? opt.choice.agent : undefined;
			await addWorktreeWorkspace(entry, setupCommands, agent);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setSubmitting(false);
		}
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			onClose();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIndex((i) => (i + 1) % options.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIndex((i) => (i - 1 + options.length) % options.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			submit();
		}
	};

	return (
		<AnimatePresence>
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
					role="dialog"
					aria-label="Add worktree"
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
					<div className="flex flex-col" style={{ padding: "28px 36px 18px" }}>
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
							Add worktree
						</span>
						<h2
							style={{
								color: "var(--fg-primary)",
								fontSize: 19,
								fontWeight: 600,
								letterSpacing: "-0.01em",
							}}
						>
							New worktree of {primaryName}
						</h2>
					</div>

					<div
						className="flex flex-col"
						style={{
							padding: "8px 36px 18px",
							gap: 16,
							borderTop: "1px solid var(--border)",
							paddingTop: 20,
						}}
					>
						<div className="flex flex-col" style={{ gap: 6 }}>
							<label htmlFor="aw-branch" style={fieldLabelStyle}>
								Branch
							</label>
							<div style={{ position: "relative" }}>
								<GitBranch
									size={14}
									style={{
										position: "absolute",
										left: 11,
										top: 11,
										color: "var(--fg-secondary)",
									}}
								/>
								<input
									id="aw-branch"
									ref={branchInputRef}
									type="text"
									value={branch}
									placeholder="feature/my-branch"
									onChange={(e) => setBranch(e.target.value)}
									style={{ ...inputStyle, paddingLeft: 32 }}
								/>
							</div>
							{branch.length > 0 && !branchValid && (
								<span style={hintErrorStyle}>
									Branch names can't contain spaces or special characters.
								</span>
							)}
						</div>

						<div className="flex flex-col" style={{ gap: 6 }}>
							<label htmlFor="aw-folder" style={fieldLabelStyle}>
								Folder
							</label>
							<input
								id="aw-folder"
								type="text"
								value={folder}
								placeholder={`../${repo}.worktrees/<branch>`}
								onChange={(e) => {
									folderDirty.current = true;
									setFolder(e.target.value);
								}}
								style={{
									...inputStyle,
									fontFamily:
										"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
									fontSize: 12,
								}}
							/>
							{absolutePath && (
								<span
									className="truncate"
									style={{
										fontSize: 11,
										color: "var(--fg-secondary)",
										fontFamily:
											"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
									}}
									title={absolutePath}
								>
									→ {absolutePath}
								</span>
							)}
						</div>

						<div className="flex flex-col" style={{ gap: 6 }}>
							<span style={fieldLabelStyle}>Launch with</span>
							<div
								className="flex flex-col"
								style={{ gap: 2, maxHeight: 168, overflowY: "auto" }}
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
											onClick={() => setSelectedIndex(idx)}
											onDoubleClick={() => {
												setSelectedIndex(idx);
												submit();
											}}
											className="flex items-center rounded-lg text-left cursor-pointer transition-all"
											style={{
												height: 42,
												padding: "0 14px",
												gap: 12,
												backgroundColor: isSelected
													? "color-mix(in srgb, var(--accent) 16%, var(--bg-primary))"
													: "transparent",
												border: `1px solid ${
													isSelected
														? "color-mix(in srgb, var(--accent) 55%, var(--border))"
														: "transparent"
												}`,
												color: "var(--fg-primary)",
											}}
										>
											<div
												className="flex items-center justify-center flex-shrink-0"
												style={{ width: 26, height: 26 }}
											>
												{isTerminal ? (
													<TerminalBrandIcon size={20} />
												) : AgentBrand ? (
													<AgentBrand size={18} />
												) : (
													<FallbackAgentIcon size={15} strokeWidth={1.8} />
												)}
											</div>
											<span style={{ fontSize: 13, fontWeight: 500 }}>
												{opt.label}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						{error && (
							<div
								style={{
									fontSize: 12,
									color: "var(--error)",
									backgroundColor:
										"color-mix(in srgb, var(--error) 12%, transparent)",
									border:
										"1px solid color-mix(in srgb, var(--error) 30%, transparent)",
									borderRadius: 8,
									padding: "8px 12px",
								}}
							>
								{error}
							</div>
						)}
					</div>

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
								cursor: isValid ? "pointer" : "not-allowed",
								opacity: isValid ? 1 : 0.6,
								border: "none",
							}}
						>
							<span>{submitting ? "Creating…" : "Create worktree"}</span>
							<CornerDownLeft size={13} />
						</button>
					</div>
				</motion.div>
			</motion.div>
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

const hintErrorStyle: React.CSSProperties = {
	fontSize: 11,
	color: "var(--error)",
};
