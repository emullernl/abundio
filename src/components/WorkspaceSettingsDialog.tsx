import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface Props {
	workspaceId: string;
	/** Whether to show the Worktree setup commands box (main worktrees only). */
	isMainWorktree: boolean;
	onClose: () => void;
}

export function WorkspaceSettingsDialog({
	workspaceId,
	isMainWorktree,
	onClose,
}: Props) {
	const workspace = useWorkspaceStore((s) =>
		s.workspaces.find((w) => w.id === workspaceId),
	);
	const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
	const setWorktreeSetupCommands = useWorkspaceStore(
		(s) => s.setWorktreeSetupCommands,
	);

	const nameRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(workspace?.name ?? "");
	const [commands, setCommands] = useState(
		workspace?.worktreeSetupCommands ?? "",
	);

	useEffect(() => {
		requestAnimationFrame(() => nameRef.current?.select());
	}, []);

	if (!workspace) return null;

	const save = () => {
		const trimmed = name.trim();
		if (trimmed && trimmed !== workspace.name) {
			renameWorkspace(workspace.id, trimmed);
		}
		if (isMainWorktree && commands !== workspace.worktreeSetupCommands) {
			setWorktreeSetupCommands(workspace.id, commands);
		}
		onClose();
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
					aria-label="Workspace settings"
					className="rounded-2xl overflow-hidden flex flex-col outline-none"
					initial={{ opacity: 0, scale: 0.96, y: 12 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.96, y: 12 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 540,
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
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							save();
						}
					}}
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
							Workspace settings
						</span>
						<h2
							style={{
								color: "var(--fg-primary)",
								fontSize: 19,
								fontWeight: 600,
								letterSpacing: "-0.01em",
							}}
						>
							{workspace.name}
						</h2>
					</div>

					<div
						className="flex flex-col"
						style={{
							padding: "8px 36px 20px",
							gap: 18,
							borderTop: "1px solid var(--border)",
							paddingTop: 20,
						}}
					>
						<div className="flex flex-col" style={{ gap: 6 }}>
							<label htmlFor="ws-name" style={fieldLabelStyle}>
								Name
							</label>
							<input
								id="ws-name"
								ref={nameRef}
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								style={inputStyle}
							/>
						</div>

						{isMainWorktree && (
							<div className="flex flex-col" style={{ gap: 6 }}>
								<label htmlFor="ws-setup" style={fieldLabelStyle}>
									Worktree setup commands
								</label>
								<textarea
									id="ws-setup"
									value={commands}
									onChange={(e) => setCommands(e.target.value)}
									placeholder={"pnpm install\ncp ../$(basename $PWD)/.env .env"}
									spellCheck={false}
									rows={6}
									style={{
										...inputStyle,
										height: "auto",
										minHeight: 120,
										padding: "10px 12px",
										resize: "vertical",
										fontFamily:
											"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
										fontSize: 12,
										lineHeight: 1.5,
									}}
								/>
								<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
									Run one command per line in a newly created worktree after Add
									worktree, before any chosen agent.
								</span>
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
							onClick={save}
							className="flex items-center transition-opacity"
							style={{
								marginLeft: "auto",
								gap: 8,
								padding: "7px 16px",
								borderRadius: 6,
								backgroundColor: "var(--accent)",
								color: "#fff",
								fontSize: 12,
								fontWeight: 600,
								cursor: "pointer",
								border: "none",
							}}
						>
							Save
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
