import type { Session } from "../../lib/types";

interface Props {
	session: Session;
	isActive: boolean;
	onClick: () => void;
	onDelete: () => void;
}

export function SessionItem({ session, isActive, onClick, onDelete }: Props) {
	return (
		<div
			onClick={onClick}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
			className="group flex items-center gap-3 px-3.5 py-3 rounded-lg cursor-pointer transition-colors"
			style={{
				backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
			}}
			onMouseLeave={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--success)" }} />
			<div className="flex-1 min-w-0">
				<div className="truncate font-medium" style={{ color: "var(--fg-primary)", fontSize: 14 }}>
					{session.name}
				</div>
				<div className="truncate mt-0.5" style={{ color: "var(--fg-secondary)", fontSize: 12 }}>
					{session.rootFolder}
				</div>
			</div>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--error)] hover:text-white transition-all"
				style={{ color: "var(--fg-secondary)", fontSize: 13 }}
			>
				&times;
			</button>
		</div>
	);
}
