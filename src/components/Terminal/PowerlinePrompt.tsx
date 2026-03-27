import type { ShellMeta } from "../../lib/oscParser";
import { getTheme } from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";

interface Props {
	meta: ShellMeta | null;
}

interface Pill {
	text: string;
	bg: string;
	fg: string;
}

function abbreviatePath(path: string): string {
	const home = path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
	const parts = home.split("/");
	if (parts.length <= 3) return home;
	return `${parts[0]}/${parts[1]}/.../${parts[parts.length - 1]}`;
}

function formatTime(): string {
	const now = new Date();
	return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function PowerlinePrompt({ meta }: Props) {
	const themeName = useSettingsStore((s) => s.theme);
	const theme = getTheme(themeName);
	const t = theme.terminal;

	if (!meta) {
		return (
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					fontFamily: "var(--font-mono)",
					fontSize: 12,
					padding: "0 8px",
					color: "var(--fg-secondary)",
				}}
			>
				<span>~</span>
			</div>
		);
	}

	const leftPills: Pill[] = [];

	// User@host pill
	if (meta.user) {
		leftPills.push({
			text: meta.user,
			bg: t.green ?? "#3FB950",
			fg: "#000000",
		});
	}

	// CWD pill
	leftPills.push({
		text: abbreviatePath(meta.cwd),
		bg: t.brightBlack ?? "#6E7681",
		fg: t.white ?? "#E6EDF3",
	});

	// Git branch pill (only if present)
	if (meta.git) {
		leftPills.push({
			text: `\u2387 ${meta.git}`,
			bg: t.blue ?? "#58A6FF",
			fg: "#000000",
		});
	}

	const rightPills: Pill[] = [];

	// Elapsed time (only if non-empty)
	if (meta.elapsed) {
		rightPills.push({
			text: meta.elapsed,
			bg: t.green ?? "#3FB950",
			fg: "#000000",
		});
	}

	// Exit code (only on error)
	if (meta.exit !== 0) {
		rightPills.push({
			text: `\u2717 ${meta.exit}`,
			bg: t.red ?? "#F85149",
			fg: "#ffffff",
		});
	}

	// Clock
	rightPills.push({
		text: formatTime(),
		bg: t.blue ?? "#58A6FF",
		fg: "#000000",
	});

	const pillStyle = (pill: Pill): React.CSSProperties => ({
		display: "inline-flex",
		alignItems: "center",
		padding: "2px 10px",
		borderRadius: 4,
		background: pill.bg,
		color: pill.fg,
		fontSize: 12,
		fontWeight: 500,
		whiteSpace: "nowrap",
		lineHeight: "18px",
	});

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				fontFamily: "var(--font-mono)",
				padding: "0 8px",
				gap: 6,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 4 }}>
				{leftPills.map((pill, i) => (
					<span key={`l-${i}`} style={pillStyle(pill)}>
						{pill.text}
					</span>
				))}
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: 4 }}>
				{rightPills.map((pill, i) => (
					<span key={`r-${i}`} style={pillStyle(pill)}>
						{pill.text}
					</span>
				))}
			</div>
		</div>
	);
}
