import { useEffect, useState } from "react";
import { useProfileStore } from "../../stores/profileStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { Plus, X } from "../Icons";
import { SectionLabel } from "./primitives";

/* ─── Profile row ─── */
function ProfileRow({
	name,
	canDelete,
	onRename,
	onDelete,
}: {
	name: string;
	/** True when the "at least one profile must exist" rule allows deletion.
	 *  False only for the last remaining profile. */
	canDelete: boolean;
	onRename: (name: string) => void;
	onDelete: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(name);

	useEffect(() => {
		setDraft(name);
	}, [name]);

	function commit() {
		const trimmed = draft.trim();
		setEditing(false);
		if (trimmed && trimmed !== name) {
			onRename(trimmed);
		} else {
			setDraft(name);
		}
	}

	return (
		<div
			className="flex items-center gap-3 rounded-lg group transition-colors"
			style={{
				padding: "9px 10px",
				backgroundColor: "transparent",
				border: "1px solid transparent",
			}}
		>
			<div className="flex-1 min-w-0">
				{editing ? (
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === "Enter") commit();
							else if (e.key === "Escape") {
								setEditing(false);
								setDraft(name);
							}
						}}
						// biome-ignore lint/a11y/noAutofocus: rename UI focuses on click
						autoFocus
						style={{
							width: "100%",
							fontSize: 13,
							color: "var(--fg-primary)",
							backgroundColor: "var(--bg-primary)",
							border: "1px solid var(--border)",
							borderRadius: 4,
							padding: "3px 6px",
							outline: "none",
						}}
					/>
				) : (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="truncate text-left"
						style={{
							width: "100%",
							fontSize: 13,
							color: "var(--fg-primary)",
							lineHeight: 1.3,
							background: "transparent",
							border: "none",
							padding: 0,
							cursor: "text",
						}}
						title="Click to rename"
					>
						{name}
					</button>
				)}
			</div>
			{canDelete ? (
				<button
					type="button"
					onClick={onDelete}
					className="flex-shrink-0 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
					style={{
						width: 24,
						height: 24,
						color: "var(--fg-secondary)",
					}}
					onMouseEnter={(e) => {
						(e.currentTarget as HTMLElement).style.color = "var(--error)";
						(e.currentTarget as HTMLElement).style.backgroundColor =
							"color-mix(in srgb, var(--error) 10%, transparent)";
					}}
					onMouseLeave={(e) => {
						(e.currentTarget as HTMLElement).style.color =
							"var(--fg-secondary)";
						(e.currentTarget as HTMLElement).style.backgroundColor =
							"transparent";
					}}
					title="Delete profile (and all its workspaces)"
				>
					<X size={13} />
				</button>
			) : (
				// Last remaining profile — explicitly disabled per ADR-0007's
				// "at least one profile must exist" invariant.
				<button
					type="button"
					disabled
					className="flex-shrink-0 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
					style={{
						width: 24,
						height: 24,
						color: "var(--fg-secondary)",
						opacity: 0.4,
						cursor: "not-allowed",
					}}
					title="Cannot delete the last profile"
				>
					<X size={13} />
				</button>
			)}
		</div>
	);
}

/* ─── Add profile form ─── */
function AddProfileForm({ onAdd }: { onAdd: (name: string) => void }) {
	const [name, setName] = useState("");

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		onAdd(trimmed);
		setName("");
	}

	return (
		<form onSubmit={handleSubmit} className="flex items-center gap-2">
			<input
				type="text"
				placeholder="Profile name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				style={{
					flex: 1,
					fontSize: 13,
					color: "var(--fg-primary)",
					backgroundColor: "var(--bg-primary)",
					border: "1px solid var(--border)",
					borderRadius: 6,
					padding: "7px 10px",
					outline: "none",
				}}
			/>
			<button
				type="submit"
				disabled={!name.trim()}
				className="rounded-md flex items-center gap-1.5 transition-colors"
				style={{
					fontSize: 12,
					color: name.trim() ? "var(--fg-primary)" : "var(--fg-secondary)",
					padding: "7px 12px",
					backgroundColor: name.trim() ? "var(--accent)" : "var(--bg-tertiary)",
					border: "none",
					cursor: name.trim() ? "pointer" : "not-allowed",
					opacity: name.trim() ? 1 : 0.5,
				}}
			>
				<Plus size={12} />
				Add Profile
			</button>
		</form>
	);
}

export function ProfilesSection() {
	const profiles = useProfileStore((s) => s.profiles);
	const ownershipMap = useProfileStore((s) => s.ownershipMap);
	const createProfile = useProfileStore((s) => s.createProfile);
	const renameProfile = useProfileStore((s) => s.renameProfile);
	const deleteProfile = useProfileStore((s) => s.deleteProfile);
	// Pending profile-delete confirmation. When non-null, the ConfirmDialog
	// is mounted asking the user to confirm. If the profile is open in some
	// window, the dialog message also warns that the window will close.
	const [pendingDelete, setPendingDelete] = useState<{
		id: string;
		name: string;
		ownerLabel: string | null;
	} | null>(null);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				<SectionLabel>Profiles</SectionLabel>
				<p
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						marginBottom: 12,
						lineHeight: 1.5,
					}}
				>
					Profiles group your workspaces into separate contexts. Switching
					profiles closes the current profile's opened workspaces. Click a name
					to rename it.
				</p>
				<div className="flex flex-col gap-0.5">
					{profiles.map((p) => (
						<ProfileRow
							key={p.id}
							name={p.name}
							canDelete={profiles.length > 1}
							onRename={(newName) =>
								renameProfile(p.id, newName).catch(() => {})
							}
							onDelete={() =>
								setPendingDelete({
									id: p.id,
									name: p.name,
									ownerLabel: ownershipMap[p.id] ?? null,
								})
							}
						/>
					))}
				</div>
			</div>
			<div className="flex-shrink-0">
				<AddProfileForm
					onAdd={(name) => {
						createProfile(name).catch((err) => {
							console.error("[profiles] create failed:", err);
						});
					}}
				/>
			</div>
			{/* The dialog is `position: fixed`, so it covers the whole window
			    regardless of where in the tree it is mounted. */}
			{pendingDelete && (
				<ConfirmDialog
					title={`Delete "${pendingDelete.name}"?`}
					message={
						pendingDelete.ownerLabel
							? "This profile is currently open in another window. Deleting it will close that window and permanently remove all of its workspaces, tabs, and saved layouts."
							: "This permanently removes the profile and all of its workspaces, tabs, and saved layouts."
					}
					confirmLabel="Delete profile"
					confirmVariant="danger"
					onConfirm={() => {
						const target = pendingDelete;
						setPendingDelete(null);
						deleteProfile(target.id).catch((err) => {
							console.error("[profiles] delete failed:", err);
						});
					}}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
		</div>
	);
}
