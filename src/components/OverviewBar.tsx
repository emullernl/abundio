import {
	AlertTriangle,
	BarChart3,
	Check,
	Circle,
	Eye,
	GitPullRequest,
	HelpCircle,
	LayoutGrid,
	type LucideIcon,
} from "lucide-react";
import {
	type ComponentType,
	type CSSProperties,
	memo,
	type ReactNode,
} from "react";
import type { DotStatus } from "../stores/ptyActivityStore";
import { AgentStatusIcon, ShellChevronGlyph } from "./AgentStatusIcon";

// Matches the sidebar's WORKSPACES header height so the bar's bottom border
// sits on the same horizontal line as the sidebar header's border-bottom.
export const OVERVIEW_BAR_HEIGHT = 40;

export interface OverviewBarProps {
	/** Workspaces activated this session and still open. */
	openedWorkspaces: number;
	/** Total workspaces in the sidebar. */
	totalWorkspaces: number;
	/** Agents at rest (post-acknowledgement). */
	idleAgents: number;
	/** Agents mid-turn. */
	workingAgents: number;
	/** Agents blocked on user input. Tile hidden when `showAgentWaiting` is false. */
	waitingAgents: number;
	/** Agents that finished a turn and have not been acknowledged. */
	readyAgents: number;
	/** Agents whose last turn failed. */
	errorAgents: number;
	/** Shell-mode PTYs at rest. */
	idleShells: number;
	/** Shell-mode PTYs running a command. */
	workingShells: number;
	/** Shell-mode PTYs whose last command errored. */
	errorShells: number;
	/** PRs across all repos where the user is a requested reviewer. */
	reviewRequestedPrs: number;
	/** User's own open PRs across all repos. */
	myOpenPrs: number;
	/**
	 * When false, the Waiting agent tile is hidden. Driven by
	 * `settingsStore.agentHooksEnabled` — without hooks, the Waiting state
	 * can't be detected, so showing the tile would be misleading.
	 */
	showAgentWaiting: boolean;
	/** Whether the Statistics overlay is currently open (drives the toggle's
	 *  active styling). */
	statisticsOpen: boolean;
	/** Open/close the Statistics overlay. The bar's one navigation affordance —
	 *  it reveals a view, it does not mutate workspace state. See ADR-0018. */
	onToggleStatistics: () => void;
}

const TILE_WIDTH = 44;
const TILE_HEIGHT = 24;
const GLYPH_SIZE = 12;
const GLYPH_STROKE = 2.5;
const NUMBER_FONT_SIZE = 13;
const SECTION_TITLE_FONT_SIZE = 7;
// Gap between the section title and its row of tiles.
const SECTION_TITLE_GAP = 3;
// Gap between adjacent sections in the bar.
const SECTION_GAP = 14;

/** Tile face shows up to two digits; everything past 99 collapses to "99+".
 *  Tooltips keep the real count. */
function formatTileCount(n: number): string {
	return n > 99 ? "99+" : String(n);
}

// Silver for the two "no state" tiles (Workspaces, Idle). A neutral cool
// grey distinct from --fg-secondary, evoking a polished metal indicator.
const SILVER = "rgb(176 188 204)";
const ACCENT_COLOR = "var(--accent)";

/**
 * Working-state still glyph: same broken double-ring as AgentStatusIcon's
 * amber spinner, no rotation. Used as the zero-count fallback so the
 * Working tile shape stays consistent whether the bar is animating or not.
 */
function BrokenRingGlyph({
	size = GLYPH_SIZE,
	strokeWidth = GLYPH_STROKE,
	style,
}: {
	size?: number;
	strokeWidth?: number;
	style?: CSSProperties;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			style={style}
		>
			<circle
				cx="12"
				cy="12"
				r="10"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeDasharray="15.71 47.12"
			/>
			<circle
				cx="12"
				cy="12"
				r="10"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeDasharray="15.71 47.12"
				transform="rotate(180 12 12)"
			/>
		</svg>
	);
}

type GlyphComponent = ComponentType<{
	size?: number;
	strokeWidth?: number;
	style?: CSSProperties;
}>;

export const OverviewBar = memo(function OverviewBar(props: OverviewBarProps) {
	const {
		openedWorkspaces,
		totalWorkspaces,
		idleAgents,
		workingAgents,
		waitingAgents,
		readyAgents,
		errorAgents,
		idleShells,
		workingShells,
		errorShells,
		reviewRequestedPrs,
		myOpenPrs,
		showAgentWaiting,
		statisticsOpen,
		onToggleStatistics,
	} = props;

	return (
		<div
			data-overview-bar
			className="flex items-center select-none overflow-x-auto overflow-y-hidden"
			style={{
				height: OVERVIEW_BAR_HEIGHT,
				backgroundColor: "var(--bg-secondary)",
				borderBottom: "1px solid var(--border)",
				paddingLeft: 10,
				paddingRight: 10,
				paddingTop: 2,
				paddingBottom: 2,
				gap: SECTION_GAP,
				scrollbarWidth: "none",
			}}
		>
			<Section title="Workspaces">
				<WorkspaceTile opened={openedWorkspaces} total={totalWorkspaces} />
			</Section>

			<Section title="Agents">
				<AgentTile kind="idle" count={idleAgents} />
				<AgentTile kind="working" count={workingAgents} />
				{showAgentWaiting && <AgentTile kind="waiting" count={waitingAgents} />}
				<AgentTile kind="ready" count={readyAgents} />
				<AgentTile kind="error" count={errorAgents} />
			</Section>

			<Section title="Terminals">
				<ShellTile kind="idle" count={idleShells} />
				<ShellTile kind="working" count={workingShells} />
				<ShellTile kind="error" count={errorShells} />
			</Section>

			<Section title="Pull requests">
				<PrTile kind="review" count={reviewRequestedPrs} />
				<PrTile kind="mine" count={myOpenPrs} />
			</Section>

			{/* Right-aligned: the bar's one interactive affordance — opens the
			    Statistics overlay. Pushed to the far edge with margin-left:auto. */}
			<div style={{ marginLeft: "auto", paddingLeft: SECTION_GAP }}>
				<StatisticsToggle open={statisticsOpen} onClick={onToggleStatistics} />
			</div>
		</div>
	);
});

function StatisticsToggle({
	open,
	onClick,
}: {
	open: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title="Statistics — agent activity for this profile (Cmd/Ctrl+Shift+S)"
			aria-pressed={open}
			className="flex items-center justify-center flex-shrink-0"
			style={{
				width: 34,
				height: TILE_HEIGHT,
				borderRadius: 5,
				border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
				backgroundColor: open ? "var(--bg-tertiary)" : "transparent",
				color: open ? "var(--accent)" : "var(--fg-secondary)",
				cursor: "pointer",
				transition: "color 160ms ease-out, border-color 160ms ease-out",
			}}
		>
			<BarChart3 size={14} strokeWidth={2.25} style={{ flexShrink: 0 }} />
		</button>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div
			className="flex flex-col flex-shrink-0"
			style={{ gap: SECTION_TITLE_GAP }}
		>
			<div
				style={{
					fontSize: SECTION_TITLE_FONT_SIZE,
					textTransform: "uppercase",
					letterSpacing: "0.12em",
					color: "var(--fg-secondary)",
					fontWeight: 400,
					lineHeight: 1,
					paddingLeft: 2,
					whiteSpace: "nowrap",
				}}
			>
				{title}
			</div>
			<div className="flex items-center" style={{ gap: 4 }}>
				{children}
			</div>
		</div>
	);
}

interface TileShellProps {
	glyph: ReactNode;
	active: boolean;
	title: string;
	primary: number;
}

function TileShell({ glyph, active, title, primary }: TileShellProps) {
	return (
		<div
			title={title}
			className="flex items-center justify-center flex-shrink-0"
			style={{
				width: TILE_WIDTH,
				height: TILE_HEIGHT,
				backgroundColor: "var(--bg-tertiary)",
				borderRadius: 5,
				gap: 4,
				opacity: active ? 1 : 0.4,
				transition: "opacity 220ms ease-out",
			}}
		>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: NUMBER_FONT_SIZE,
					fontVariantNumeric: "tabular-nums",
					color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
					fontWeight: 600,
					lineHeight: 1,
					letterSpacing: "-0.03em",
				}}
			>
				{formatTileCount(primary)}
			</span>
			{glyph}
		</div>
	);
}

function staticGlyph(Icon: GlyphComponent | LucideIcon, color: string) {
	return (
		<Icon
			size={GLYPH_SIZE}
			strokeWidth={GLYPH_STROKE}
			style={{ color, flexShrink: 0 }}
		/>
	);
}

function WorkspaceTile({ opened, total }: { opened: number; total: number }) {
	// Mute the tile whenever nothing is warm — even if workspaces exist in
	// the sidebar but none are opened, the bar has nothing live to report.
	const active = opened > 0;
	const title =
		total === 0
			? "No workspaces yet"
			: `${opened} of ${total} workspace${total === 1 ? "" : "s"} opened`;
	return (
		<TileShell
			glyph={staticGlyph(LayoutGrid, active ? SILVER : "var(--fg-secondary)")}
			active={active}
			primary={opened}
			title={title}
		/>
	);
}

type AgentKind = "idle" | "working" | "waiting" | "ready" | "error";

interface AgentDef {
	/** Used at zero count, or for idle (which is never animated). */
	StaticGlyph: GlyphComponent | LucideIcon;
	/** Solid colour for static rendering. */
	color: string;
	/**
	 * When the count is > 0 and this is set, render `AgentStatusIcon` to
	 * get the per-pane indicator's animated, glowing glyph. Identical shape,
	 * colour, and motion as the per-pane indicator. `null` for Idle — at-rest
	 * doesn't animate.
	 */
	animatedStatus: DotStatus | null;
	label: string;
	description: string;
}

const AGENT_DEFINITIONS: Record<AgentKind, AgentDef> = {
	idle: {
		StaticGlyph: Circle,
		color: "rgb(52 211 153)", // emerald-400 — matches AgentStatusIcon "green"
		animatedStatus: "green",
		label: "Idle",
		description: "agent at rest",
	},
	working: {
		StaticGlyph: BrokenRingGlyph,
		color: "rgb(251 191 36)", // amber-400
		animatedStatus: "amber",
		label: "Working",
		description: "agent mid-turn",
	},
	waiting: {
		StaticGlyph: HelpCircle,
		color: "rgb(56 189 248)", // sky-400
		animatedStatus: "skyblue",
		label: "Waiting",
		description: "blocked on your input",
	},
	ready: {
		StaticGlyph: Check,
		color: "rgb(192 132 252)", // purple-400
		animatedStatus: "purple",
		label: "Ready",
		description: "finished a turn — needs acknowledgement",
	},
	error: {
		StaticGlyph: AlertTriangle,
		color: "rgb(244 63 94)", // rose-500
		animatedStatus: "red",
		label: "Error",
		description: "last turn failed",
	},
};

/**
 * Renders a tile for any PTY-derived state count (agent OR shell). The
 * glyph + animation come from `AGENT_DEFINITIONS[agentKind]`; the tooltip
 * comes from the caller. Sharing the glyph-selection branch keeps the
 * visual vocabulary drift-resistant — agent and shell tiles can't get
 * out of sync if one of them gets an animation tweak later.
 */
function StateTile({
	agentKind,
	count,
	title,
}: {
	agentKind: AgentKind;
	count: number;
	title: string;
}) {
	const def = AGENT_DEFINITIONS[agentKind];
	const active = count > 0;
	const glyph =
		active && def.animatedStatus !== null ? (
			<AgentStatusIcon status={def.animatedStatus} size={GLYPH_SIZE} />
		) : (
			staticGlyph(def.StaticGlyph, active ? def.color : "var(--fg-secondary)")
		);
	return (
		<TileShell glyph={glyph} active={active} primary={count} title={title} />
	);
}

function AgentTile({ kind, count }: { kind: AgentKind; count: number }) {
	const def = AGENT_DEFINITIONS[kind];
	return (
		<StateTile
			agentKind={kind}
			count={count}
			title={`${def.label} agents — ${def.description} (${count})`}
		/>
	);
}

type ShellKind = "idle" | "working" | "error";

/**
 * Shell tiles reuse the agent definitions' glyph + colour for Idle and Error,
 * but the Working tile diverges: shells use the breathing triple-chevron
 * glyph (matching the per-pane indicator), not the agent spinner. Shells
 * never reach Ready — see ADR-0009.
 */
const SHELL_DEFINITIONS: Record<
	ShellKind,
	{ agentKind: AgentKind; label: string; description: string }
> = {
	idle: {
		agentKind: "idle",
		label: "Idle terminals",
		description: "shell at rest",
	},
	working: {
		agentKind: "working",
		label: "Busy terminals",
		description: "running a command",
	},
	error: {
		agentKind: "error",
		label: "Error terminals",
		description: "last command failed",
	},
};

// Shell-Working uses cyan, not amber — distinct from agent-Working to convey
// "neutral throughput" rather than "attention-needed". See ADR-0009.
const SHELL_WORKING_COLOR = "rgb(34 211 238)"; // cyan-400

function ShellTile({ kind, count }: { kind: ShellKind; count: number }) {
	const shellDef = SHELL_DEFINITIONS[kind];
	const title = `${shellDef.label} — ${shellDef.description} (${count})`;
	if (kind === "working") {
		const active = count > 0;
		const glyph = (
			<span
				style={{
					color: active ? SHELL_WORKING_COLOR : "var(--fg-secondary)",
					display: "inline-flex",
					flexShrink: 0,
					animation: active
						? "shell-running-breathe 1.6s ease-in-out infinite"
						: undefined,
				}}
			>
				<ShellChevronGlyph size={GLYPH_SIZE} />
			</span>
		);
		return (
			<TileShell glyph={glyph} active={active} primary={count} title={title} />
		);
	}
	return (
		<StateTile agentKind={shellDef.agentKind} count={count} title={title} />
	);
}

type PrKind = "review" | "mine";

const PR_DEFINITIONS: Record<
	PrKind,
	{ Glyph: LucideIcon; label: string; description: string }
> = {
	review: {
		Glyph: Eye,
		label: "Review requested",
		description: "PRs awaiting your review across all repos",
	},
	mine: {
		Glyph: GitPullRequest,
		label: "My open PRs",
		description: "your open PRs across all repos",
	},
};

function PrTile({ kind, count }: { kind: PrKind; count: number }) {
	const def = PR_DEFINITIONS[kind];
	const active = count > 0;
	return (
		<TileShell
			glyph={staticGlyph(
				def.Glyph,
				active ? ACCENT_COLOR : "var(--fg-secondary)",
			)}
			active={active}
			primary={count}
			title={`${def.label} — ${def.description} (${count})`}
		/>
	);
}
