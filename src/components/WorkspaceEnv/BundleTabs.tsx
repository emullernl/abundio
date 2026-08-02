import { Check, Plus, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EnvBundleMeta } from "../../lib/ipc";

interface Props {
	bundles: EnvBundleMeta[];
	selected: string;
	onSelect: (name: string) => void;
	onCreate: (name: string) => void;
	onRename: (from: string, to: string) => void;
	onSetInjected: (name: string) => void;
	onDelete: (name: string) => void;
}

/**
 * Bundle switcher. The injected Bundle carries a bolt badge — it is the one
 * whose variables land in every terminal, and telling it apart from an
 * on-demand Bundle at a glance is the whole point of the row.
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
						{bundle.injected && (
							<Zap
								size={10}
								style={{ color: "var(--accent)", flexShrink: 0 }}
								aria-label="injected"
							/>
						)}
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
				onDelete={onDelete}
			/>
		</div>
	);
}

/** Actions for the selected Bundle. Kept beside the tabs rather than in a menu
 *  so "which bundle is injected" stays a one-click change. */
function BundleActions({
	bundles,
	selected,
	onSetInjected,
	onDelete,
}: {
	bundles: EnvBundleMeta[];
	selected: string;
	onSetInjected: (name: string) => void;
	onDelete: (name: string) => void;
}) {
	const current = bundles.find((b) => b.name === selected);
	if (!current) return null;

	// A Workspace must keep at least one Bundle, and an inherited Bundle has no
	// local row to delete.
	const ownCount = bundles.filter((b) => !b.inherited).length;
	const canDelete = !current.inherited && ownCount > 1;
	// `set_injected` looks the bundle up on THIS workspace, so offering it for a
	// bundle that exists only on the main worktree would just raise NotFound.
	const canInject = !current.injected && !current.inherited;

	return (
		<div className="flex items-center" style={{ gap: 4, marginLeft: "auto" }}>
			{canInject && (
				<button
					type="button"
					onClick={() => onSetInjected(selected)}
					title="Inject this bundle into every terminal in this workspace"
					className="flex items-center transition-opacity"
					style={{
						gap: 4,
						padding: "3px 8px",
						borderRadius: 999,
						border: "1px solid var(--border)",
						backgroundColor: "transparent",
						color: "var(--fg-secondary)",
						fontSize: 10.5,
						cursor: "pointer",
					}}
				>
					<Check size={10} />
					Inject
				</button>
			)}
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
