import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { collectLivePanes } from "../lib/paneRestart";
import { inheritSourceWorkspaceId } from "../lib/worktreeGrouping";
import { useWorkspaceEnvStore } from "../stores/workspaceEnvStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { ApplyEnvToTerminalsDialog } from "./WorkspaceEnv/ApplyEnvToTerminalsDialog";
import { EnvUsageView } from "./WorkspaceEnv/EnvUsageView";
import { EnvVarsSection } from "./WorkspaceEnv/EnvVarsSection";

interface Props {
	workspaceId: string;
	/** Whether to show the Worktree setup commands box (main worktrees only). */
	isMainWorktree: boolean;
	onClose: () => void;
}

type Tab = "general" | "environment";
/** Sub-view of the Environment tab. Reference material is a *view of*
 *  Environment, not a peer of it — making it a third top-level tab read as an
 *  unrelated section. */
type EnvView = "variables" | "usage";

export function WorkspaceSettingsDialog({
	workspaceId,
	isMainWorktree,
	onClose,
}: Props) {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);
	// Same resolution the PTY spawn path uses, so what the dialog shows as
	// "inherited" is exactly what a terminal would receive.
	const inheritFromId = inheritSourceWorkspaceId(
		workspaces,
		worktreeFacts,
		workspaceId,
	);
	const inheritFromName = workspaces.find((w) => w.id === inheritFromId)?.name;
	const livePanes = collectLivePanes(workspaceId);
	const [applyOpen, setApplyOpen] = useState(false);
	const workspace = useWorkspaceStore((s) =>
		s.workspaces.find((w) => w.id === workspaceId),
	);
	const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
	const setWorktreeSetupCommands = useWorkspaceStore(
		(s) => s.setWorktreeSetupCommands,
	);

	const [tab, setTab] = useState<Tab>("general");
	const [envView, setEnvView] = useState<EnvView>("variables");
	const nameRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(workspace?.name ?? "");
	const [commands, setCommands] = useState(
		workspace?.worktreeSetupCommands ?? "",
	);

	useEffect(() => {
		if (tab === "general") {
			requestAnimationFrame(() => nameRef.current?.select());
		}
	}, [tab]);

	// Bundles are loaded once for the dialog rather than per tab: switching tabs
	// unmounts their content, so a per-tab load would clear the list out from
	// under whichever tab you just left.
	const loadEnv = useWorkspaceEnvStore((s) => s.load);
	const resetEnv = useWorkspaceEnvStore((s) => s.reset);
	useEffect(() => {
		loadEnv(workspaceId, inheritFromId);
		return () => resetEnv();
	}, [workspaceId, inheritFromId, loadEnv, resetEnv]);

	if (!workspace) return null;

	// Only the General tab holds a draft. Environment writes take effect as they
	// are made, which is why the footer changes meaning per tab rather than
	// showing a Save button that would do nothing.
	// Mirrors what `save` will actually write: an emptied name is ignored, so it
	// must not light the unsaved dot either.
	const dirty =
		(name.trim().length > 0 && name.trim() !== workspace.name) ||
		(isMainWorktree && commands !== workspace.worktreeSetupCommands);

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
						width: 660,
						maxHeight: "min(86vh, 840px)",
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
						// Cmd+Enter is a General-tab affordance; on Environment there is
						// no draft to commit.
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							if (tab === "general") save();
						}
					}}
				>
					{/* Header — identity first, then navigation. */}
					<div className="flex flex-col" style={{ padding: "24px 32px 0" }}>
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
							Workspace settings
						</span>
						<h2
							className="truncate"
							style={{
								color: "var(--fg-primary)",
								fontSize: 19,
								fontWeight: 600,
								letterSpacing: "-0.01em",
							}}
							title={workspace.rootFolder}
						>
							{workspace.name}
						</h2>
						<span
							className="truncate"
							style={{
								marginTop: 3,
								fontFamily: "var(--font-mono, ui-monospace, monospace)",
								fontSize: 11,
								color: "var(--fg-secondary)",
							}}
						>
							{workspace.rootFolder}
						</span>

						<div
							className="flex items-center"
							style={{ gap: 2, marginTop: 16 }}
							role="tablist"
							aria-label="Workspace settings sections"
						>
							<TabButton
								id="general"
								label="General"
								active={tab === "general"}
								badge={dirty ? "•" : undefined}
								onSelect={setTab}
							/>
							<TabButton
								id="environment"
								label="Environment"
								active={tab === "environment"}
								onSelect={setTab}
							/>
						</div>
					</div>

					<div
						style={{
							height: 1,
							backgroundColor: "var(--border)",
						}}
					/>

					{tab === "environment" && (
						<div style={{ padding: "16px 32px 0" }}>
							<SegmentedControl
								value={envView}
								onChange={setEnvView}
								options={[
									{ id: "variables", label: "Variables" },
									{ id: "usage", label: "Using them" },
								]}
							/>
						</div>
					)}

					{/* Body — scrolls independently so the footer never leaves the frame. */}
					<div
						className="flex flex-col"
						style={{
							padding: "16px 32px 22px",
							gap: 18,
							overflowY: "auto",
							minHeight: 0,
						}}
					>
						<AnimatePresence mode="wait" initial={false}>
							<motion.div
								key={tab === "environment" ? `env:${envView}` : tab}
								className="flex flex-col"
								style={{ gap: 18 }}
								initial={{ opacity: 0, x: 6 }}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
							>
								{tab === "general" ? (
									<>
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
													placeholder={
														"pnpm install\ncp ../$(basename $PWD)/.env .env"
													}
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
												<span
													style={{ fontSize: 11, color: "var(--fg-secondary)" }}
												>
													Run in a newly created worktree after Add worktree,
													before any chosen agent. One command per line, each
													run independently — a failing line doesn't stop the
													rest, so chain with <code>&&</code> if you need
													fail-fast.
												</span>
											</div>
										)}
									</>
								) : envView === "variables" ? (
									<EnvVarsSection
										workspaceId={workspaceId}
										inheritFromWorkspaceId={inheritFromId}
										inheritFromName={inheritFromName}
										workspaceFolder={workspace.rootFolder}
										liveTerminalCount={livePanes.length}
										onApplyToRunning={() => setApplyOpen(true)}
										onShowUsage={() => setEnvView("usage")}
									/>
								) : (
									<EnvUsageView />
								)}
							</motion.div>
						</AnimatePresence>
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
						<span>
							{tab === "general"
								? "Esc to cancel"
								: envView === "usage"
									? "Click any command to copy it"
									: "Changes are saved as you make them"}
						</span>
						<button
							type="button"
							onClick={tab === "general" ? save : onClose}
							className="flex items-center transition-opacity"
							style={{
								marginLeft: "auto",
								gap: 8,
								padding: "7px 16px",
								borderRadius: 6,
								backgroundColor:
									tab === "general" ? "var(--accent)" : "var(--bg-tertiary)",
								color: tab === "general" ? "#fff" : "var(--fg-primary)",
								fontSize: 12,
								fontWeight: 600,
								cursor: "pointer",
								border: tab === "general" ? "none" : "1px solid var(--border)",
							}}
						>
							{tab === "general" ? "Save" : "Done"}
						</button>
					</div>
				</motion.div>

				{applyOpen && (
					<ApplyEnvToTerminalsDialog
						workspaceId={workspaceId}
						panes={livePanes}
						onClose={() => setApplyOpen(false)}
					/>
				)}
			</motion.div>
		</AnimatePresence>
	);
}

/**
 * Pill toggle for a sub-view. Deliberately a different shape from `TabButton`'s
 * underline: two identical treatments at different depths would read as two
 * competing levels of navigation.
 */
function SegmentedControl<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (next: T) => void;
	options: { id: T; label: string }[];
}) {
	return (
		<div
			className="flex items-center"
			style={{
				alignSelf: "flex-start",
				gap: 2,
				padding: 2,
				borderRadius: 8,
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			{options.map((option) => {
				const active = option.id === value;
				return (
					<button
						key={option.id}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.id)}
						className="relative flex items-center"
						style={{
							padding: "4px 12px",
							borderRadius: 6,
							border: "none",
							background: "transparent",
							cursor: "pointer",
							fontSize: 11.5,
							fontWeight: active ? 600 : 500,
							color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
						}}
					>
						{active && (
							<motion.span
								layoutId="ws-settings-segment-thumb"
								transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
								style={{
									position: "absolute",
									inset: 0,
									borderRadius: 6,
									backgroundColor: "var(--bg-tertiary)",
								}}
							/>
						)}
						<span style={{ position: "relative" }}>{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}

function TabButton({
	id,
	label,
	active,
	badge,
	onSelect,
}: {
	id: Tab;
	label: string;
	active: boolean;
	/** Shown when the tab holds unsaved changes. */
	badge?: string;
	onSelect: (tab: Tab) => void;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			// The dot is decorative; the unsaved state belongs in the accessible
			// name so a screen reader announces it with the tab, not beside it.
			aria-label={badge ? `${label} (unsaved changes)` : undefined}
			onClick={() => onSelect(id)}
			className="flex items-center relative transition-colors"
			style={{
				gap: 5,
				padding: "8px 12px 10px",
				background: "none",
				border: "none",
				cursor: "pointer",
				fontSize: 12.5,
				fontWeight: active ? 600 : 500,
				color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
			}}
		>
			{label}
			{badge && (
				<span
					aria-hidden
					style={{ color: "var(--accent)", fontSize: 14, lineHeight: 1 }}
				>
					{badge}
				</span>
			)}
			{/* The one motion flourish: the underline slides between tabs rather
			    than cutting, so the relationship between them stays legible. */}
			{active && (
				<motion.span
					layoutId="ws-settings-tab-underline"
					transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
					style={{
						position: "absolute",
						left: 8,
						right: 8,
						bottom: -1,
						height: 2,
						borderRadius: 2,
						backgroundColor: "var(--accent)",
					}}
				/>
			)}
		</button>
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
