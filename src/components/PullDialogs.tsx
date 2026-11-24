import { pullOutcomeNotice } from "../lib/incomingCommits";
import { pullWorkspace } from "../lib/pull";
import { useIncomingStore } from "../stores/incomingStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { ConfirmDialog } from "./ConfirmDialog";

/** The two dialogs a **Pull** can raise, from wherever it was started
 *  (ADR-0066): "an Agent is working here, pull anyway?", and why a Pull did
 *  not happen. */
export function PullDialogs() {
	const dialog = useIncomingStore((s) => s.dialog);
	const name = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === dialog?.workspaceId)?.name,
	);
	if (!dialog) return null;
	const close = () => useIncomingStore.getState().setDialog(null);

	if (dialog.kind === "confirmBusy") {
		return (
			<ConfirmDialog
				title="Pull while an Agent is working?"
				message={`An Agent is working in ${name ?? "this workspace"}. Pulling changes files in its folder while it works.`}
				confirmLabel="Pull anyway"
				onConfirm={() => {
					close();
					void pullWorkspace(dialog.workspaceId, { confirmed: true });
				}}
				onCancel={close}
			/>
		);
	}

	const notice = pullOutcomeNotice(dialog.outcome);
	if (!notice) return null;
	const showChanges = notice.files.length > 0;
	return (
		<ConfirmDialog
			title={notice.title}
			message={notice.message}
			confirmLabel={showChanges ? "Show Git changes" : "OK"}
			hideCancel={!showChanges}
			onConfirm={() => {
				close();
				if (!showChanges) return;
				useWorkspaceStore.getState().setActiveWorkspace(dialog.workspaceId);
				const ui = useWindowUiStore.getState();
				ui.setRightSidebarActiveTab("git");
				ui.setRightSidebarOpen(true);
			}}
			onCancel={close}
			details={
				showChanges ? (
					<ul
						className="w-full text-left overflow-y-auto"
						style={{
							marginTop: 12,
							maxHeight: 160,
							listStyle: "none",
							padding: "6px 10px",
							borderRadius: 6,
							fontFamily: "var(--font-mono)",
							fontSize: 11.5,
							color: "var(--fg-primary)",
							backgroundColor: "var(--bg-tertiary)",
						}}
					>
						{notice.files.map((f) => (
							<li key={f} className="truncate" title={f}>
								{f}
							</li>
						))}
					</ul>
				) : undefined
			}
		/>
	);
}
