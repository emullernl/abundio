import { AlertTriangle, FileX } from "lucide-react";
import type { FilePaneState } from "../../stores/explorerStore";

interface FileChangeBannerProps {
	paneId: string;
	paneState: FilePaneState;
	onReload: () => void;
	onKeepEdits: () => void;
	onSave: () => void;
	onClose: () => void;
}

/**
 * Inline banner shown at the top of the file pane when a file was changed
 * or deleted on disk while open.
 */
export function FileChangeBanner({
	paneId: _paneId,
	paneState,
	onReload,
	onKeepEdits,
	onSave,
	onClose,
}: FileChangeBannerProps) {
	if (!paneState.externallyChanged && !paneState.deletedOnDisk) return null;

	const { icon, message, actions } = buildContent(paneState, {
		onReload,
		onKeepEdits,
		onSave,
		onClose,
	});

	return (
		<div
			className="flex items-center gap-3 px-4 py-2"
			style={{
				borderBottom: "1px solid var(--border)",
				backgroundColor:
					"color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))",
				color: "var(--fg-primary)",
				fontSize: 12,
			}}
		>
			<div
				className="flex items-center justify-center shrink-0"
				style={{ color: "var(--accent)" }}
			>
				{icon}
			</div>
			<div className="flex-1 leading-snug">{message}</div>
			<div className="flex items-center gap-2 shrink-0">
				{actions.map((a) => (
					<button
						key={a.label}
						type="button"
						onClick={a.onClick}
						className="px-3 py-1 rounded-md transition-opacity cursor-pointer"
						style={{
							fontSize: 12,
							backgroundColor: a.primary
								? "var(--accent)"
								: "var(--bg-tertiary)",
							color: a.primary ? "white" : "var(--fg-secondary)",
							border: a.primary ? "none" : "1px solid var(--border)",
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.opacity = "0.85";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.opacity = "1";
						}}
					>
						{a.label}
					</button>
				))}
			</div>
		</div>
	);
}

interface BannerAction {
	label: string;
	onClick: () => void;
	primary?: boolean;
}

interface BannerContent {
	icon: React.ReactNode;
	message: string;
	actions: BannerAction[];
}

function buildContent(
	pane: FilePaneState,
	handlers: {
		onReload: () => void;
		onKeepEdits: () => void;
		onSave: () => void;
		onClose: () => void;
	},
): BannerContent {
	if (pane.deletedOnDisk && pane.isDirty) {
		return {
			icon: <FileX size={16} />,
			message: "This file was deleted on disk. You have unsaved changes.",
			actions: [
				{ label: "Save to re-create", onClick: handlers.onSave, primary: true },
				{ label: "Close pane (discard)", onClick: handlers.onClose },
			],
		};
	}
	if (pane.deletedOnDisk) {
		return {
			icon: <FileX size={16} />,
			message: "This file was deleted on disk.",
			actions: [{ label: "Close pane", onClick: handlers.onClose, primary: true }],
		};
	}
	return {
		icon: <AlertTriangle size={16} />,
		message: "This file has changed on disk. You have unsaved changes.",
		actions: [
			{
				label: "Reload from disk",
				onClick: handlers.onReload,
				primary: true,
			},
			{ label: "Keep my edits", onClick: handlers.onKeepEdits },
		],
	};
}
