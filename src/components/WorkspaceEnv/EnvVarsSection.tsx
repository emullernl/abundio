import { AlertTriangle, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { injectionCost, isValidEnvName } from "../../lib/dotenvParse";
import { useWorkspaceEnvStore } from "../../stores/workspaceEnvStore";
import { BundleTabs } from "./BundleTabs";
import { EnvImportDialog } from "./EnvImportDialog";
import { EnvVarRow } from "./EnvVarRow";
import { formatValueSize } from "./formatValueSize";

interface Props {
	workspaceId: string;
	/** Main-worktree Workspace to inherit Bundles from, or null. */
	inheritFromWorkspaceId: string | null;
	/** Display name of that workspace, for the inherited-row tooltip. */
	inheritFromName?: string;
	/** Number of live PTYs in this workspace — gates "Apply to running". */
	/** Root folder — where the import file picker opens. */
	workspaceFolder: string;
	liveTerminalCount: number;
	onApplyToRunning: () => void;
	/** Jump to the Usage tab, where the `abundio-env` recipes live. */
	onShowUsage: () => void;
}

export function EnvVarsSection({
	workspaceId,
	inheritFromWorkspaceId,
	inheritFromName,
	workspaceFolder,
	liveTerminalCount,
	onApplyToRunning,
	onShowUsage,
}: Props) {
	const store = useWorkspaceEnvStore();
	const [expandedName, setExpandedName] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [newName, setNewName] = useState("");
	const [newValue, setNewValue] = useState("");

	const selected = store.selectedBundle;
	const currentBundle = store.bundles.find((b) => b.name === selected);
	const isInjected = currentBundle?.injected ?? false;
	const existingNames = useMemo(
		() => store.vars.map((v) => v.name),
		[store.vars],
	);
	// Storage order is insertion order (position ASC); the list reads as a pile
	// once a bundle grows past a handful of rows, so sort it for display only.
	const sortedVars = useMemo(
		() =>
			[...store.vars].sort((a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
			),
		[store.vars],
	);

	const duplicate = store.vars.some(
		(v) => v.name === newName.trim() && !v.inherited,
	);
	// The SAME cost the spawn path will spend — `name.length + value.length`
	// under-counts by more than half, so the form stayed enabled well past the
	// point where variables start being dropped.
	const wouldExceedBudget =
		isInjected &&
		store.bytesBudget > 0 &&
		store.bytesUsed + injectionCost(newName.trim().length, newValue.length) >
			store.bytesBudget;
	// Import and value-edit have no pre-flight check of their own, so a
	// post-write banner is what covers those paths.
	const overBudget =
		isInjected && store.bytesBudget > 0 && store.bytesUsed > store.bytesBudget;
	const canAdd =
		isValidEnvName(newName.trim()) &&
		newValue.length > 0 &&
		!duplicate &&
		!wouldExceedBudget &&
		!store.keyError;

	const submitNew = async () => {
		if (!canAdd) return;
		const ok = await store.upsert(
			workspaceId,
			inheritFromWorkspaceId,
			selected,
			newName.trim(),
			newValue,
		);
		if (ok) {
			setNewName("");
			setNewValue("");
		}
	};

	const dirty = store.dirtyInjected.has(workspaceId);

	return (
		<div className="flex flex-col" style={{ gap: 8 }}>
			<div className="flex items-center" style={{ gap: 10 }}>
				<span style={fieldLabelStyle}>Environment variables</span>
				<button
					type="button"
					onClick={() => setImporting(true)}
					style={{
						marginLeft: "auto",
						background: "none",
						border: "none",
						padding: 0,
						color: "var(--accent)",
						fontSize: 11,
						fontWeight: 600,
						cursor: "pointer",
					}}
				>
					Import…
				</button>
			</div>

			<BundleTabs
				bundles={store.bundles}
				selected={selected}
				onSelect={(name) => {
					setExpandedName(null);
					store.selectBundle(workspaceId, inheritFromWorkspaceId, name);
				}}
				onCreate={(name) =>
					store.createBundle(workspaceId, inheritFromWorkspaceId, name)
				}
				onRename={(from, to) =>
					store.renameBundle(workspaceId, inheritFromWorkspaceId, from, to)
				}
				onSetInjected={(name) =>
					store.setInjected(workspaceId, inheritFromWorkspaceId, name)
				}
				onClearInjected={() =>
					store.clearInjected(workspaceId, inheritFromWorkspaceId)
				}
				onDelete={(name) =>
					store.deleteBundle(workspaceId, inheritFromWorkspaceId, name)
				}
			/>

			{/* Gated on a loaded list: the dialog resets the store on close, so an
			    ungated notice would claim "plain environment" for a frame every
			    time the tab opens, and after a failed load. */}
			{store.bundles.length > 0 && !store.bundles.some((b) => b.injected) && (
				// Without this the row simply loses its bolt, which reads as a
				// rendering gap rather than a state. Say it outright.
				<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
					No bundle is injected — new terminals start with a plain environment.
					Select a bundle and choose Inject to change that.
				</span>
			)}

			{store.keyError && (
				<div
					className="flex items-center"
					style={{
						gap: 8,
						padding: "8px 10px",
						borderRadius: 8,
						fontSize: 11,
						color: "var(--fg-primary)",
						backgroundColor:
							"color-mix(in srgb, var(--error) 12%, var(--bg-primary))",
						border:
							"1px solid color-mix(in srgb, var(--error) 35%, transparent)",
					}}
				>
					<AlertTriangle size={13} style={{ color: "var(--error)" }} />
					<span style={{ flex: 1 }}>
						Environment variables are unavailable — the system keychain could
						not be read. Terminals still open, just without these values.
					</span>
					<button
						type="button"
						onClick={() => store.retryKey(workspaceId, inheritFromWorkspaceId)}
						style={{
							padding: "3px 10px",
							borderRadius: 6,
							border: "1px solid var(--border)",
							backgroundColor: "var(--bg-primary)",
							color: "var(--fg-primary)",
							fontSize: 11,
							cursor: "pointer",
						}}
					>
						Retry
					</button>
				</div>
			)}

			{overBudget && (
				<div
					className="flex items-center"
					style={{
						gap: 8,
						padding: "8px 10px",
						borderRadius: 8,
						fontSize: 11,
						lineHeight: 1.45,
						color: "var(--fg-primary)",
						backgroundColor:
							"color-mix(in srgb, var(--error) 12%, var(--bg-primary))",
						border:
							"1px solid color-mix(in srgb, var(--error) 35%, transparent)",
					}}
				>
					<AlertTriangle size={13} style={{ color: "var(--error)" }} />
					<span>
						This bundle is over the {formatValueSize(store.bytesBudget)}{" "}
						environment budget. Variables past the limit are dropped when a
						terminal starts — move some to an on-demand bundle.
					</span>
				</div>
			)}

			{store.error && (
				<span style={{ fontSize: 11, color: "var(--error)" }}>
					{store.error}
				</span>
			)}

			<div
				className="flex flex-col"
				style={{
					borderRadius: 8,
					border: "1px solid var(--border)",
					backgroundColor: "var(--bg-primary)",
					overflow: "hidden",
				}}
			>
				{store.vars.length === 0 ? (
					<span
						style={{
							padding: "14px 12px",
							fontSize: 11.5,
							color: "var(--fg-secondary)",
						}}
					>
						{store.loading
							? "Loading…"
							: `No variables in ${selected} yet. Add one below, or import a .env file.`}
					</span>
				) : (
					sortedVars.map((variable) => (
						<EnvVarRow
							key={`${variable.bundleId}:${variable.name}`}
							variable={variable}
							locked={store.keyError !== null}
							inheritedFrom={inheritFromName}
							expanded={expandedName === variable.name}
							revealedValue={
								store.revealed?.name === variable.name &&
								store.revealed?.bundle === selected
									? store.revealed.value
									: null
							}
							onToggle={() => {
								if (expandedName === variable.name) {
									setExpandedName(null);
									store.clearRevealed();
								} else {
									setExpandedName(variable.name);
									store.reveal(
										workspaceId,
										inheritFromWorkspaceId,
										selected,
										variable.name,
									);
								}
							}}
							onSave={async (value) => {
								const ok = await store.upsert(
									workspaceId,
									inheritFromWorkspaceId,
									selected,
									variable.name,
									value,
								);
								if (ok) {
									setExpandedName(null);
									store.clearRevealed();
								}
							}}
							onDelete={() => {
								setExpandedName(null);
								store.remove(
									workspaceId,
									inheritFromWorkspaceId,
									selected,
									variable.name,
								);
							}}
						/>
					))
				)}
			</div>

			{/* Add form. Disabled-until-valid with no error text, matching
			    NewWorkspaceDialog and AddAgentForm. */}
			<div className="flex items-start" style={{ gap: 6 }}>
				<input
					value={newName}
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") submitNew();
					}}
					placeholder="NAME"
					spellCheck={false}
					style={{
						...smallInputStyle,
						width: 150,
						fontFamily: "var(--font-mono, ui-monospace, monospace)",
					}}
				/>
				<textarea
					value={newValue}
					onChange={(e) => {
						setNewValue(e.target.value);
						// Grow with the content so a pasted certificate is visible
						// without the field turning into a one-line slot.
						const el = e.currentTarget;
						el.style.height = "auto";
						el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitNew();
					}}
					placeholder="value"
					rows={1}
					spellCheck={false}
					style={{
						...smallInputStyle,
						flex: 1,
						minHeight: 30,
						padding: "6px 10px",
						resize: "none",
						fontFamily: "var(--font-mono, ui-monospace, monospace)",
						lineHeight: 1.5,
					}}
				/>
				<button
					type="button"
					onClick={submitNew}
					disabled={!canAdd}
					title={
						duplicate
							? `${newName.trim()} already exists in ${selected}`
							: wouldExceedBudget
								? "This would exceed the injected bundle's size budget"
								: "Add variable"
					}
					className="flex items-center transition-opacity"
					style={{
						gap: 4,
						height: 30,
						padding: "0 12px",
						borderRadius: 6,
						border: "none",
						backgroundColor: canAdd ? "var(--accent)" : "var(--bg-tertiary)",
						color: canAdd ? "#fff" : "var(--fg-secondary)",
						fontSize: 11.5,
						fontWeight: 600,
						cursor: canAdd ? "pointer" : "not-allowed",
						opacity: canAdd ? 1 : 0.6,
						flexShrink: 0,
					}}
				>
					<Plus size={12} />
					Add
				</button>
			</div>

			{/* How this bundle is actually consumed. Without this line the
			    on-demand bundles are undiscoverable. */}
			<span style={helpStyle}>
				{isInjected ? (
					<>
						Injected into every terminal opened in this workspace. Values are
						encrypted at rest and never written to disk in plain text.
						{store.bytesBudget > 0 && (
							<>
								{" "}
								Using {formatValueSize(store.bytesUsed)} of{" "}
								{formatValueSize(store.bytesBudget)}.
							</>
						)}
					</>
				) : (
					<>
						On-demand — never placed in a terminal's environment, and never
						written to disk. Reaches a process only through{" "}
						<code>abundio-env</code>.
					</>
				)}{" "}
				<button
					type="button"
					onClick={onShowUsage}
					style={{
						background: "none",
						border: "none",
						padding: 0,
						color: "var(--accent)",
						fontSize: 11,
						fontWeight: 600,
						cursor: "pointer",
					}}
				>
					How to use it →
				</button>
			</span>

			{dirty && liveTerminalCount > 0 && (
				<button
					type="button"
					onClick={onApplyToRunning}
					className="flex items-center"
					style={{
						gap: 6,
						alignSelf: "flex-start",
						padding: "6px 12px",
						borderRadius: 6,
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-primary)",
						color: "var(--fg-primary)",
						fontSize: 11.5,
						cursor: "pointer",
					}}
				>
					Apply to {liveTerminalCount} running{" "}
					{liveTerminalCount === 1 ? "terminal" : "terminals"}…
				</button>
			)}
			{dirty && liveTerminalCount === 0 && (
				<span style={helpStyle}>
					Changes apply to terminals opened from now on.
				</span>
			)}

			{importing && (
				<EnvImportDialog
					bundle={selected}
					existingNames={existingNames}
					workspaceFolder={workspaceFolder}
					onClose={() => setImporting(false)}
					onImport={async (entries) => {
						const ok = await store.importMany(
							workspaceId,
							inheritFromWorkspaceId,
							selected,
							entries,
						);
						// Import is all-or-nothing; closing on failure would throw
						// away the pasted text with nothing written.
						if (ok) setImporting(false);
					}}
				/>
			)}
		</div>
	);
}

const fieldLabelStyle: React.CSSProperties = {
	fontSize: 10.5,
	fontWeight: 600,
	letterSpacing: "0.1em",
	textTransform: "uppercase",
	color: "var(--fg-secondary)",
};

const helpStyle: React.CSSProperties = {
	fontSize: 11,
	color: "var(--fg-secondary)",
	lineHeight: 1.5,
};

const smallInputStyle: React.CSSProperties = {
	height: 30,
	padding: "0 10px",
	borderRadius: 6,
	border: "1px solid var(--border)",
	backgroundColor: "var(--bg-primary)",
	color: "var(--fg-primary)",
	fontSize: 12,
	outline: "none",
};
