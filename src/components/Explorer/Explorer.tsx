import { useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { ChevronDown, ChevronRight } from "../Icons";
import { FileTree } from "./FileTree";

export function Explorer() {
	const activeSession = useSessionStore((s) =>
		s.sessions.find((sess) => sess.id === s.activeSessionId),
	);
	const [collapsed, setCollapsed] = useState(false);

	if (!activeSession) return null;

	return (
		<div className="flex flex-col min-h-0 h-full">
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				className="flex items-center gap-1.5 w-full text-left flex-shrink-0"
				style={{
					height: 32,
					paddingLeft: 16,
					paddingRight: 16,
				}}
			>
				<span style={{ color: "var(--fg-secondary)", flexShrink: 0 }}>
					{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
				</span>
				<span
					className="font-semibold"
					style={{
						color: "var(--fg-secondary)",
						fontSize: 11,
						letterSpacing: "0.05em",
						textTransform: "uppercase",
					}}
				>
					Explorer
				</span>
			</button>
			{!collapsed && (
				<div className="flex-1 overflow-y-auto min-h-0">
					<FileTree
						rootPath={activeSession.rootFolder}
						sessionId={activeSession.id}
					/>
				</div>
			)}
		</div>
	);
}
