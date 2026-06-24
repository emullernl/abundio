import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { secrets as secretsApi } from "../lib/ipc";
import { useSecretsStore } from "../stores/secretsStore";
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

	const allSecrets = useSecretsStore((s) => s.secrets);
	const reloadSecrets = useSecretsStore((s) => s.reload);

	const nameRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(workspace?.name ?? "");
	const [commands, setCommands] = useState(
		workspace?.worktreeSetupCommands ?? "",
	);
	// Secret ids assigned to this workspace. Loaded from the backend on mount;
	// `initialAssigned` is the baseline used to detect changes on save.
	const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
	const [assignedLoaded, setAssignedLoaded] = useState(false);
	const initialAssignedRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		requestAnimationFrame(() => nameRef.current?.select());
	}, []);

	useEffect(() => {
		reloadSecrets();
		let active = true;
		secretsApi
			.listForWorkspace(workspaceId)
			.then((list) => {
				if (!active) return;
				const ids = new Set(list.map((s) => s.id));
				setAssignedIds(ids);
				initialAssignedRef.current = ids;
				setAssignedLoaded(true);
			})
			.catch(() => {
				if (active) setAssignedLoaded(true);
			});
		return () => {
			active = false;
		};
	}, [workspaceId, reloadSecrets]);

	if (!workspace) return null;

	const toggleSecret = (id: string) => {
		setAssignedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const save = () => {
		const trimmed = name.trim();
		if (trimmed && trimmed !== workspace.name) {
			renameWorkspace(workspace.id, trimmed);
		}
		if (isMainWorktree && commands !== workspace.worktreeSetupCommands) {
			setWorktreeSetupCommands(workspace.id, commands);
		}
		// Persist secret assignment only if it changed.
		const initial = initialAssignedRef.current;
		const unchanged =
			assignedIds.size === initial.size &&
			[...assignedIds].every((id) => initial.has(id));
		if (assignedLoaded && !unchanged) {
			secretsApi
				.setForWorkspace(workspace.id, [...assignedIds])
				.catch((err) => console.error("[secrets] assign failed:", err));
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
									Run in a newly created worktree after Add worktree, before any
									chosen agent. One command per line, each run independently — a
									failing line doesn't stop the rest, so chain with{" "}
									<code>&&</code> if you need fail-fast.
								</span>
							</div>
						)}

						<div className="flex flex-col" style={{ gap: 6 }}>
							<span style={fieldLabelStyle}>Secrets</span>
							{allSecrets.length === 0 ? (
								<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
									No secrets yet. Add them in Settings ▸ Secrets, then assign
									them here to inject them as environment variables into this
									workspace's terminals.
								</span>
							) : (
								<>
									<div
										className="flex flex-col"
										style={{
											border: "1px solid var(--border)",
											borderRadius: 8,
											backgroundColor: "var(--bg-primary)",
											maxHeight: 168,
											overflowY: "auto",
										}}
									>
										{allSecrets.map((secret) => (
											<label
												key={secret.id}
												className="flex items-center"
												style={{
													gap: 10,
													padding: "8px 12px",
													cursor: "pointer",
												}}
											>
												<input
													type="checkbox"
													checked={assignedIds.has(secret.id)}
													onChange={() => toggleSecret(secret.id)}
												/>
												<span className="flex flex-col" style={{ minWidth: 0 }}>
													<span
														className="truncate"
														style={{
															fontSize: 13,
															color: "var(--fg-primary)",
															fontFamily:
																"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
														}}
													>
														{secret.name}
													</span>
													{secret.description && (
														<span
															className="truncate"
															style={{
																fontSize: 11,
																color: "var(--fg-secondary)",
															}}
														>
															{secret.description}
														</span>
													)}
												</span>
											</label>
										))}
									</div>
									<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
										Checked secrets are injected as environment variables into
										new terminals in this workspace. Already-open terminals pick
										them up after a restart.
									</span>
								</>
							)}
						</div>
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
