import { AlertTriangle, FileX } from "lucide-react";
import type { FileTab } from "../../stores/explorerStore";
import { useExplorerStore } from "../../stores/explorerStore";

interface FileChangeBannerProps {
	tab: FileTab;
}

/**
 * Inline banner shown at the top of the file viewer when a file was changed
 * or deleted on disk while open. Four visual states, driven by the tab's
 * `externallyChanged`, `deletedOnDisk`, and `isDirty` flags.
 */
export function FileChangeBanner({ tab }: FileChangeBannerProps) {
	const reloadTabFromDisk = useExplorerStore((s) => s.reloadTabFromDisk);
	const dismissExternalChange = useExplorerStore(
		(s) => s.dismissExternalChange,
	);
	const saveFile = useExplorerStore((s) => s.saveFile);
	const closeFileTab = useExplorerStore((s) => s.closeFileTab);

	if (!tab.externallyChanged && !tab.deletedOnDisk) return null;

	const { icon, message, actions } = buildContent(tab, {
		onReload: () => reloadTabFromDisk(tab.id),
		onKeepEdits: () => dismissExternalChange(tab.id),
		onSave: () => saveFile(tab.id),
		onClose: () => closeFileTab(tab.id),
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
	tab: FileTab,
	handlers: {
		onReload: () => void;
		onKeepEdits: () => void;
		onSave: () => void;
		onClose: () => void;
	},
): BannerContent {
	if (tab.deletedOnDisk && tab.isDirty) {
		return {
			icon: <FileX size={16} />,
			message: "This file was deleted on disk. You have unsaved changes.",
			actions: [
				{ label: "Save to re-create", onClick: handlers.onSave, primary: true },
				{ label: "Close tab (discard)", onClick: handlers.onClose },
			],
		};
	}
	if (tab.deletedOnDisk) {
		return {
			icon: <FileX size={16} />,
			message: "This file was deleted on disk.",
			actions: [
				{ label: "Close tab", onClick: handlers.onClose, primary: true },
			],
		};
	}
	// externallyChanged && isDirty (externallyChanged with clean tab auto-reloads)
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
