import { Plus, Zap, ZapOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EnvBundleMeta } from "../../lib/ipc";

interface Props {
	bundles: EnvBundleMeta[];
	selected: string;
	onSelect: (name: string) => void;
	onCreate: (name: string) => void;
	onRename: (from: string, to: string) => void;
	onSetInjected: (name: string) => void;
	/** Stop injecting anything — every Bundle becomes on-demand. */
	onClearInjected: () => void;
	onDelete: (name: string) => void;
}

/**
 * Bundle switcher. Injection state lives on the toggle at the end of the row,
 * not as a badge on each tab: one green control that both reports whether the
 * selected Bundle is injected and flips it.
 *
 * Rename is click-to-edit on the active tab, matching `ProfileRow` in
 * SettingsPanel rather than introducing a second editing idiom.
 */
export function BundleTabs({
	bundles,
	selected,
	onSelect,
	onCreate,
	onRename,
	onSetInjected,
	onClearInjected,
	onDelete,
}: Props) {
	const [creating, setCreating] = useState(false);
	const [draft, setDraft] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const createRef = useRef<HTMLInputElement>(null);
	const renameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (creating) requestAnimationFrame(() => createRef.current?.focus());
	}, [creating]);
	useEffect(() => {
		if (renaming) requestAnimationFrame(() => renameRef.current?.select());
	}, [renaming]);

	const commitCreate = () => {
		const name = draft.trim();
		setCreating(false);
		setDraft("");
		if (name) onCreate(name);
	};

	const commitRename = (from: string) => {
		const to = renameDraft.trim();
		setRenaming(null);
		if (to && to !== from) onRename(from, to);
	};

	return (
		<div className="flex items-center flex-wrap" style={{ gap: 5 }}>
			{bundles.map((bundle) => {
				const active = bundle.name === selected;
				const isRenaming = renaming === bundle.name;

				if (isRenaming) {
					return (
						<input
							key={bundle.id || bundle.name}
							ref={renameRef}
							value={renameDraft}
							onChange={(e) => setRenameDraft(e.target.value)}
							onBlur={() => commitRename(bundle.name)}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename(bundle.name);
								if (e.key === "Escape") setRenaming(null);
								e.stopPropagation();
							}}
							style={{
								...pillBase,
								width: 110,
								backgroundColor: "var(--bg-primary)",
								border: "1px solid var(--accent)",
								color: "var(--fg-primary)",
								outline: "none",
							}}
						/>
					);
				}

				return (
					<button
						key={bundle.id || bundle.name}
						type="button"
						onClick={() => {
							// Second click on the active tab starts a rename, so renaming
							// needs no extra affordance competing for space.
							if (active && !bundle.inherited) {
								setRenameDraft(bundle.name);
								setRenaming(bundle.name);
							} else {
								onSelect(bundle.name);
							}
						}}
						onContextMenu={(e) => {
							e.preventDefault();
							onSelect(bundle.name);
						}}
						title={
							bundle.injected
								? "Injected into every terminal in this workspace"
								: `On-demand — read with: abundio-env print ${bundle.name}`
						}
						className="flex items-center transition-colors"
						style={{
							...pillBase,
							gap: 5,
							cursor: "pointer",
							backgroundColor: active
								? "color-mix(in srgb, var(--accent) 16%, var(--bg-primary))"
								: "var(--bg-primary)",
							border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
							color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
						}}
					>
						<span>{bundle.name}</span>
						{bundle.varCount > 0 && (
							<span style={{ opacity: 0.6, fontSize: 10 }}>
								{bundle.varCount}
							</span>
						)}
					</button>
				);
			})}

			{creating ? (
				<input
					ref={createRef}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitCreate}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitCreate();
						if (e.key === "Escape") {
							setCreating(false);
							setDraft("");
						}
						e.stopPropagation();
					}}
					placeholder="production"
					style={{
						...pillBase,
						width: 110,
						backgroundColor: "var(--bg-primary)",
						border: "1px solid var(--accent)",
						color: "var(--fg-primary)",
						outline: "none",
					}}
				/>
			) : (
				<button
					type="button"
					onClick={() => setCreating(true)}
					title="New bundle"
					aria-label="New bundle"
					className="flex items-center"
					style={{
						...pillBase,
						padding: "3px 7px",
						cursor: "pointer",
						backgroundColor: "transparent",
						border: "1px dashed var(--border)",
						color: "var(--fg-secondary)",
					}}
				>
					<Plus size={11} />
				</button>
			)}

			<BundleActions
				bundles={bundles}
				selected={selected}
				onSetInjected={onSetInjected}
				onClearInjected={onClearInjected}
				onDelete={onDelete}
			/>
		</div>
	);
}

/** Actions for the selected Bundle: the injection toggle, and delete. Kept
 *  beside the tabs rather than in a menu so "which bundle is injected" stays a
 *  one-click change. */
function BundleActions({
	bundles,
	selected,
	onSetInjected,
	onClearInjected,
	onDelete,
}: {
	bundles: EnvBundleMeta[];
	selected: string;
	onSetInjected: (name: string) => void;
	onClearInjected: () => void;
	onDelete: (name: string) => void;
}) {
	const current = bundles.find((b) => b.name === selected);
	if (!current) return null;

	// A Workspace must keep at least one Bundle, and an inherited Bundle has no
	// local row to delete.
	const ownCount = bundles.filter((b) => !b.inherited).length;
	const canDelete = !current.inherited && ownCount > 1;
	const injected = current.injected;
	// Naming the injected Bundle in the off-state title: with no per-tab badge,
	// selecting an on-demand Bundle would otherwise leave nothing on screen
	// saying what IS injected — the status pill only covers the active
	// workspace, and this dialog opens for any workspace in the sidebar.
	const injectedName = bundles.find((b) => b.injected)?.name;

	return (
		<div className="flex items-center" style={{ gap: 4, marginLeft: "auto" }}>
			{/* One control, two states: this is where injection is read AND
			    changed, so it carries the green. Splitting it into separate
			    "Inject" and "Turn off" buttons made the current state something
			    you had to infer from which button was showing.

			    Offered for an inherited Bundle too — the backend materialises a
			    local row and the parent's values still resolve through
			    inheritance, so a worktree can run `production` while its main
			    worktree runs `dev`. */}
			<button
				type="button"
				role="switch"
				aria-checked={injected}
				onClick={() => (injected ? onClearInjected() : onSetInjected(selected))}
				title={
					injected
						? "Injected into every new terminal in this workspace — click to turn off"
						: injectedName
							? `Inject ${selected} into every new terminal in this workspace, instead of ${injectedName}`
							: `Inject ${selected} into every new terminal in this workspace`
				}
				className="flex items-center transition-colors"
				style={{
					gap: 5,
					padding: "3px 9px",
					borderRadius: 999,
					fontSize: 10.5,
					fontWeight: 500,
					cursor: "pointer",
					color: injected ? "var(--success)" : "var(--fg-secondary)",
					backgroundColor: injected
						? "color-mix(in srgb, var(--success) 14%, transparent)"
						: "transparent",
					border: `1px solid ${
						injected
							? "color-mix(in srgb, var(--success) 40%, transparent)"
							: "var(--border)"
					}`,
				}}
			>
				{injected ? <Zap size={10} /> : <ZapOff size={10} />}
				{injected ? "Injected" : "Inject"}
			</button>
			{canDelete && (
				<button
					type="button"
					onClick={() => onDelete(selected)}
					title={`Delete the ${selected} bundle and its variables`}
					style={{
						padding: "3px 8px",
						borderRadius: 999,
						border: "1px solid var(--border)",
						backgroundColor: "transparent",
						color: "var(--fg-secondary)",
						fontSize: 10.5,
						cursor: "pointer",
					}}
				>
					Delete bundle
				</button>
			)}
		</div>
	);
}

const pillBase: React.CSSProperties = {
	padding: "3px 9px",
	borderRadius: 999,
	fontSize: 11,
	fontWeight: 500,
	fontFamily: "var(--font-mono, ui-monospace, monospace)",
	lineHeight: 1.6,
};
