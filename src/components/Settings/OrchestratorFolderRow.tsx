import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";
import {
	fs as fsApi,
	type OrchestratorFolder,
	orchestrator as orchestratorApi,
} from "../../lib/ipc";
import { tildePath } from "../../lib/orchestratorFolder";
import { ConfirmDialog } from "../ConfirmDialog";
import { secondaryButtonClass } from "../PromptActions/fieldStyles";

const buttonStyle = { fontSize: 11, padding: "3px 8px", borderRadius: 5 };

/**
 * A Profile's **Orchestrator folder** (ADR-0059): where it is, and Choose…,
 * Reset to default and Show in Finder. Changing it asks first, since a
 * running Orchestrator restarts there with a new conversation.
 */
export function OrchestratorFolderRow({ profileId }: { profileId: string }) {
	const [folder, setFolder] = useState<OrchestratorFolder | null>(null);
	const [home, setHome] = useState("");
	const [error, setError] = useState<string | null>(null);
	// The change waiting for the user's yes: a path, or `null` for the default.
	const [pending, setPending] = useState<{ path: string | null } | null>(null);

	useEffect(() => {
		let live = true;
		orchestratorApi
			.folder(profileId)
			.then((f) => live && setFolder(f))
			.catch(() => {});
		homeDir()
			.then((h) => live && setHome(h))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [profileId]);

	async function choose() {
		setError(null);
		const { open } = await import("@tauri-apps/plugin-dialog");
		const picked = await open({
			directory: true,
			multiple: false,
			defaultPath: folder?.path,
			title: "Choose an empty folder for the Orchestrator",
		});
		if (typeof picked === "string" && picked !== folder?.path) {
			setPending({ path: picked });
		}
	}

	function apply(path: string | null) {
		setPending(null);
		orchestratorApi
			.setFolder(profileId, path)
			.then((f) => {
				setFolder(f);
				setError(null);
			})
			.catch((e) => setError(String(e)));
	}

	if (!folder) return null;
	return (
		<div
			className="flex flex-col"
			style={{ padding: "0 10px 8px", gap: 4 }}
			data-testid="orchestrator-folder"
		>
			<div className="flex items-center" style={{ gap: 6, minWidth: 0 }}>
				<span
					style={{ fontSize: 11, color: "var(--fg-secondary)", flexShrink: 0 }}
				>
					Orchestrator folder
				</span>
				<span
					className="truncate"
					title={folder.path}
					style={{
						fontSize: 11,
						color: "var(--fg-primary)",
						fontFamily: "var(--font-mono, monospace)",
						minWidth: 0,
					}}
				>
					{tildePath(folder.path, home)}
				</span>
			</div>
			<div className="flex items-center" style={{ gap: 6 }}>
				<button
					type="button"
					className={secondaryButtonClass}
					style={buttonStyle}
					onClick={() => void choose()}
				>
					Choose…
				</button>
				{folder.path !== folder.defaultPath && (
					<button
						type="button"
						className={secondaryButtonClass}
						style={buttonStyle}
						onClick={() => setPending({ path: null })}
					>
						Reset to default
					</button>
				)}
				<button
					type="button"
					className={secondaryButtonClass}
					style={buttonStyle}
					onClick={() => fsApi.revealInFolder(folder.path).catch(() => {})}
				>
					Show in Finder
				</button>
			</div>
			{error && (
				<span role="alert" style={{ fontSize: 11, color: "var(--error)" }}>
					{error.replace(/^Error:\s*/, "")}
				</span>
			)}
			{pending && (
				<ConfirmDialog
					title="Move the Orchestrator?"
					message={`The Orchestrator moves to ${
						pending.path ? tildePath(pending.path, home) : "its default folder"
					}. If it is running, it restarts there and starts a new conversation. Your my-instructions.md comes along; the old folder is left as it is.`}
					confirmLabel="Move"
					onConfirm={() => apply(pending.path)}
					onCancel={() => setPending(null)}
				/>
			)}
		</div>
	);
}
