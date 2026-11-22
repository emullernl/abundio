import { useCallback, useEffect, useState } from "react";
import { listenToThisWindow } from "../../lib/ipc";
import type { Profile } from "../../lib/types";
import { useSettingsHostStore } from "../../stores/settingsHostStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { Plus, X } from "../Icons";
import {
	paramTextInputStyle,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { SectionLabel } from "./primitives";

/**
 * Settings ▸ Profiles for a Host (phase 10d-3): its Profiles, made, renamed
 * and deleted there. Deleting one removes its Workspaces on the Host (never
 * their project folders) and stops its panes; the Host refuses while a
 * Window shows it.
 */
export function HostProfilesSection() {
	const hostName = useSettingsHostStore((s) => s.hostName);
	const { call } = useSettingsHostStore.getState();
	const [profiles, setProfiles] = useState<Profile[] | null>(null);
	const [newName, setNewName] = useState("");
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
		null,
	);
	const [deleting, setDeleting] = useState<Profile | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(() => {
		void call<Profile[]>("server_profile_list")
			.then(setProfiles)
			.catch((e) => setError(String(e)));
	}, [call]);
	useEffect(() => {
		reload();
		const off = listenToThisWindow("profiles-changed", reload);
		return () => {
			void off.then((stop) => stop());
		};
	}, [reload]);

	const run = async (p: Promise<unknown>) => {
		setError(null);
		try {
			await p;
		} catch (e) {
			setError(String(e));
		}
		reload();
	};

	return (
		<div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
			<SectionLabel>Profiles on {hostName}</SectionLabel>
			{error && (
				<div style={{ fontSize: 12, color: "var(--error)" }}>{error}</div>
			)}
			{profiles === null ? (
				<p style={{ fontSize: 12, color: "var(--fg-secondary)" }}>Reading…</p>
			) : (
				<div
					className="flex flex-col rounded-lg overflow-hidden"
					style={{ border: "1px solid var(--border)" }}
				>
					{profiles.map((p, i) => (
						<div
							key={p.id}
							className="group flex items-center gap-2"
							style={{
								padding: "8px 12px",
								borderTop: i === 0 ? "none" : "1px solid var(--border)",
								backgroundColor: "var(--bg-primary)",
							}}
						>
							{renaming?.id === p.id ? (
								<input
									className="rounded-md flex-1"
									style={paramTextInputStyle}
									value={renaming.name}
									// biome-ignore lint/a11y/noAutofocus: the field the user just asked for
									autoFocus
									onChange={(e) =>
										setRenaming({ id: p.id, name: e.target.value })
									}
									onKeyDown={(e) => {
										if (e.key === "Enter" && renaming.name.trim()) {
											setRenaming(null);
											void run(
												call("server_profile_rename", {
													id: p.id,
													name: renaming.name.trim(),
												}),
											);
										}
										if (e.key === "Escape") setRenaming(null);
									}}
									onBlur={() => setRenaming(null)}
								/>
							) : (
								<button
									type="button"
									className="flex-1 text-left truncate"
									style={{ fontSize: 13, color: "var(--fg-primary)" }}
									title="Rename"
									onDoubleClick={() => setRenaming({ id: p.id, name: p.name })}
								>
									{p.name}
								</button>
							)}
							<button
								type="button"
								className={`${secondaryButtonClass} rounded-md`}
								style={{ fontSize: 12, height: 24, padding: "0 8px" }}
								onClick={() => setRenaming({ id: p.id, name: p.name })}
							>
								Rename
							</button>
							<button
								type="button"
								aria-label={`Delete ${p.name}`}
								className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md flex items-center justify-center text-[var(--fg-secondary)] hover:bg-[var(--error)] hover:text-white transition-all"
								onClick={() => setDeleting(p)}
							>
								<X size={12} />
							</button>
						</div>
					))}
				</div>
			)}
			<div className="flex gap-2" style={{ maxWidth: 420 }}>
				<input
					className="rounded-md flex-1"
					style={paramTextInputStyle}
					placeholder={`New profile on ${hostName}`}
					value={newName}
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && newName.trim()) {
							void run(call("server_profile_create", { name: newName.trim() }));
							setNewName("");
						}
					}}
				/>
				<button
					type="button"
					className={`${secondaryButtonClass} rounded-md flex items-center gap-1`}
					style={{ fontSize: 12, height: 30, padding: "0 10px" }}
					disabled={!newName.trim()}
					onClick={() => {
						void run(call("server_profile_create", { name: newName.trim() }));
						setNewName("");
					}}
				>
					<Plus size={12} /> Add
				</button>
			</div>
			{deleting && (
				<ConfirmDialog
					title={`Delete ${deleting.name} on ${hostName}?`}
					message={`This deletes the profile and its workspaces on ${hostName}, and stops every pane and agent they run there. The project folders are not touched. Not possible while a window shows it.`}
					confirmLabel="Delete profile"
					confirmVariant="danger"
					onConfirm={() => {
						const id = deleting.id;
						setDeleting(null);
						void run(call("server_profile_delete", { id }));
					}}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
