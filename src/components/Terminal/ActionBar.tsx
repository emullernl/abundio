/**
 * The **Action bar**: a horizontally-scrolling rail of **Prompt action**
 * buttons along the bottom of a terminal pane.
 *
 * Designed to read as *terminal chrome*, not as a web toolbar. It mirrors
 * `TerminalTitleBar` exactly — same 11px mono, same `--fg-secondary`, same
 * transparent background so the workspace's ambient gradient shows through,
 * same hairline border but on the opposite edge. The pane ends up bracketed by
 * two matching rails.
 *
 * The **position number** is drawn as a dim monospace prefix, like a gutter
 * line number rather than a badge, and brightens to the accent on hover so the
 * digit reads as a key you can press.
 *
 * Renders nothing at all when no action is in scope — not an empty bar. A
 * feature the user has not adopted costs them no terminal rows.
 */

import { Plus } from "lucide-react";
import { useMemo, useRef } from "react";
import { firePromptAction } from "../../lib/firePromptAction";
import {
	actionsForPane,
	buttonLabel,
	canFire,
	deriveParams,
	initialValues,
	type PromptAction,
	positionNumber,
} from "../../lib/promptActions";
import { usePromptActionStore } from "../../stores/promptActionStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";

interface ActionBarProps {
	paneId: string;
	/** Opens the parameter dialog. The bar never collects values itself. */
	onRequestParams: (action: PromptAction) => void;
	/** Opens the in-pane authoring popover, anchored to the `+`. */
	onAddAction: (anchor: { x: number; y: number }) => void;
}

/**
 * Marks a bar button with its Prompt action id.
 *
 * The pane's `contextmenu` listener is registered in the **capture** phase and
 * calls `stopPropagation` unconditionally — it has to, because xterm's own
 * listener moves a hidden textarea under the cursor, which on Windows WebView2
 * pastes the clipboard straight into the PTY. A bubble-phase `onContextMenu`
 * here would therefore never run. So the button advertises itself instead, and
 * `TerminalSlot` reads this off the event target to decide which menu to open.
 */
export const PROMPT_ACTION_ATTR = "data-prompt-action-id";

/** Matches the title bar's 22px, one notch taller for the touch target. */
const BAR_HEIGHT = 24;

export function ActionBar({
	paneId,
	onRequestParams,
	onAddAction,
}: ActionBarProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

	const ptyId = usePtyActivityStore((s) => s.panePtyMap[paneId]);
	const detectionMode = usePtyActivityStore((s) =>
		ptyId ? s.activities[ptyId]?.detectionMode : undefined,
	);
	const state = usePtyActivityStore((s) =>
		ptyId ? s.activities[ptyId]?.state : undefined,
	);
	const agentId = usePtyActivityStore((s) =>
		ptyId ? s.detectedAgentIds[ptyId] : undefined,
	);

	const showActionBar = useSettingsStore((s) => s.showActionBar);
	const actions = usePromptActionStore((s) => s.actions);
	const loaded = usePromptActionStore((s) => s.loaded);

	const visible = useMemo(
		() => actionsForPane(actions, agentId, { barOnly: true }),
		[actions, agentId],
	);

	// Agent mode is read from `detectionMode` — the canonical signal the status
	// indicators and File drop use. `agentPtyIds` tracks it but is not the source
	// of truth.
	const isAgentPane = detectionMode === "agent";

	// The bar is present in every agent pane, even with nothing in it — that is
	// what makes the feature findable, since nothing is seeded on a fresh
	// install and an invisible `+` cannot be clicked. It costs one terminal row.
	//
	// `loaded` is still gated on, but only to keep the *empty* bar from
	// rendering its invitation for a frame before the real buttons arrive. The
	// bar's presence no longer depends on how many actions there are, so there
	// is no appear/disappear flicker on load either way.
	if (!showActionBar || !isAgentPane) return null;

	const fireable = canFire(state);

	function fire(action: PromptAction, altKey: boolean) {
		// An action with any parameters asks first; one with none fires straight
		// from the click.
		if (deriveParams(action.body, action.params).length > 0) {
			onRequestParams(action);
			return;
		}
		firePromptAction(
			paneId,
			action.body,
			action.params,
			initialValues(action.body, action.params),
			{
				stageOnly: altKey,
			},
		);
	}

	return (
		<div
			className="flex items-stretch shrink-0 relative"
			style={{
				height: BAR_HEIGHT,
				// Transparent for the same reason the title bar is: the workspace's
				// ambient gradient is painted behind the pane tree and should show
				// through every part of the pane.
				background: "transparent",
				borderTop:
					"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
				// The bar is chrome, not content: a drag started here must not be
				// read as a pane drag by TerminalSlot's capture-phase handler.
				cursor: "default",
			}}
			onMouseDownCapture={(e) => e.stopPropagation()}
		>
			<div
				ref={scrollRef}
				className="flex items-stretch gap-px flex-1 min-w-0 overflow-x-auto"
				style={{
					scrollbarWidth: "none",
					// Fade the live edges instead of showing a scrollbar — a scrollbar
					// in a 24px rail would eat a third of it.
					maskImage:
						"linear-gradient(to right, transparent 0, black 10px, black calc(100% - 14px), transparent 100%)",
				}}
				onWheel={(e) => {
					// A trackpad flick down over a horizontal rail should move it.
					if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
					const el = scrollRef.current;
					if (!el || el.scrollWidth <= el.clientWidth) return;
					el.scrollLeft += e.deltaY;
				}}
			>
				{loaded && visible.length === 0 && (
					<button
						type="button"
						className="shrink-0 flex items-center gap-1.5 transition-colors select-none"
						style={{
							padding: "0 10px",
							fontFamily: "var(--font-mono)",
							fontSize: 11,
							lineHeight: `${BAR_HEIGHT}px`,
							whiteSpace: "nowrap",
							color: "var(--fg-secondary)",
							opacity: 0.55,
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.opacity = "1";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.opacity = "0.55";
						}}
						onClick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							onAddAction({ x: r.right, y: r.top });
						}}
					>
						<Plus size={11} />
						Add a prompt action
					</button>
				)}
				{visible.map((action, index) => (
					<ActionButton
						key={action.id}
						action={action}
						number={positionNumber(index)}
						disabled={!fireable}
						onFire={(altKey) => fire(action, altKey)}
					/>
				))}
			</div>

			{/* Outside the scroller on purpose: the way to add an action must never
			    scroll out of reach. Hidden while the bar is empty, where the
			    left-aligned invitation already says it better than a bare icon
			    stranded at the far edge. */}
			{visible.length > 0 && (
				<button
					type="button"
					className="shrink-0 flex items-center justify-center transition-colors"
					style={{
						width: 24,
						color: "var(--fg-secondary)",
						opacity: 0.55,
						borderLeft:
							"1px solid color-mix(in srgb, var(--border) 30%, transparent)",
					}}
					title="Add prompt action…"
					aria-label="Add prompt action"
					onMouseEnter={(e) => {
						e.currentTarget.style.opacity = "1";
						e.currentTarget.style.color = "var(--accent)";
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.opacity = "0.55";
						e.currentTarget.style.color = "var(--fg-secondary)";
					}}
					onClick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						onAddAction({ x: r.right, y: r.top });
					}}
				>
					<Plus size={12} />
				</button>
			)}
		</div>
	);
}

interface ActionButtonProps {
	action: PromptAction;
	number: number | null;
	disabled: boolean;
	onFire: (altKey: boolean) => void;
}

function ActionButton({ action, number, disabled, onFire }: ActionButtonProps) {
	const label = buttonLabel(action);

	// The tooltip is the only place the user can read what this button will
	// actually say to their Agent before it is sent.
	const preview =
		action.body.length > 240 ? `${action.body.slice(0, 240)}…` : action.body;
	const title = disabled
		? `${action.name} — the agent is waiting for a permission answer`
		: `${action.name}\n\n${preview}${number ? `\n\n⌘${number}` : ""}`;

	return (
		<button
			type="button"
			disabled={disabled}
			// Read by TerminalSlot's capture-phase contextmenu handler, which
			// swallows the event before any bubble-phase handler here could see
			// it. See PROMPT_ACTION_ATTR.
			{...{ [PROMPT_ACTION_ATTR]: action.id }}
			className="group shrink-0 flex items-center gap-[5px] transition-colors select-none"
			style={{
				padding: "0 9px",
				fontFamily: "var(--font-mono)",
				fontSize: 11,
				lineHeight: `${BAR_HEIGHT}px`,
				whiteSpace: "nowrap",
				color: "var(--fg-secondary)",
				opacity: disabled ? 0.35 : 0.8,
				cursor: disabled ? "not-allowed" : "pointer",
				maxWidth: 220,
			}}
			title={title}
			onMouseEnter={(e) => {
				if (disabled) return;
				e.currentTarget.style.opacity = "1";
				e.currentTarget.style.background =
					"color-mix(in srgb, var(--fg-primary) 7%, transparent)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.opacity = disabled ? "0.35" : "0.8";
				e.currentTarget.style.background = "transparent";
			}}
			onClick={(e) => onFire(e.altKey)}
		>
			{number !== null && (
				<span
					// A gutter line number, not a badge. Dim enough to recede, and it
					// turns accent on hover so the digit reads as a key you press.
					className="tabular-nums opacity-45 transition-colors group-hover:opacity-100 group-hover:text-[var(--accent)] group-disabled:opacity-45 group-disabled:text-[var(--fg-secondary)]"
					style={{ color: "var(--fg-secondary)", fontSize: 10 }}
				>
					{number}
				</span>
			)}
			<span className="truncate">{label}</span>
		</button>
	);
}

/** Height reserved when the bar is present. Exported so a caller sizing the
 *  terminal body can account for it without re-deriving the constant. */
export const ACTION_BAR_HEIGHT = BAR_HEIGHT;
