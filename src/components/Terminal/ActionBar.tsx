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

import { AnimatePresence, motion } from "framer-motion";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { firePromptAction } from "../../lib/firePromptAction";
import { type PulseEvent, subscribePulse } from "../../lib/promptActionPulse";
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

	// Which button last sent, and when. Nonce rather than a boolean so two sends
	// of the same action re-trigger the animation instead of collapsing into one.
	const [fired, setFired] = useState<PulseEvent | null>(null);
	useEffect(() => subscribePulse(paneId, setFired), [paneId]);

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
			{ stageOnly: altKey, actionId: action.id },
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
					// Only the right edge fades. A left fade would eat the first
					// segment's digit, which sits flush against the pane border.
					maskImage:
						"linear-gradient(to right, black 0, black calc(100% - 14px), transparent 100%)",
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
						pulseNonce={fired?.actionId === action.id ? fired.nonce : undefined}
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
	/** Bumped each time this action sends. See `promptActionPulse`. */
	pulseNonce: number | undefined;
	onFire: (altKey: boolean) => void;
}

function ActionButton({
	action,
	number,
	disabled,
	pulseNonce,
	onFire,
}: ActionButtonProps) {
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
			className="group relative overflow-hidden shrink-0 flex items-stretch transition-colors select-none"
			style={{
				// No left padding: the powerline segment is flush to the button's
				// edge, the way a status-line segment is flush to its separator.
				padding: number !== null ? "0 10px 0 0" : "0 10px",
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
				<PowerlineDigit
					number={number}
					muted={disabled}
					pulseNonce={pulseNonce}
				/>
			)}
			<span className="truncate self-center">{label}</span>
			<SendSweep nonce={pulseNonce} />
		</button>
	);
}

/**
 * The **position number**, drawn as a powerline segment.
 *
 * A filled block carrying the digit, closed by `U+E0B0` — the right-pointing
 * solid separator every powerline/starship prompt is built from — rendered in
 * the segment's own colour against the bar's transparent background, so the
 * block appears to taper into the terminal.
 *
 * The glyph is safe to rely on: Abundio **bundles** its terminal fonts and
 * every one is a `… Nerd Font Mono` variant (see `TERMINAL_FONTS`), and
 * `--font-mono` defaults to one. There is no fallback to guard against.
 *
 * The separator is sized to the bar's full height rather than the label's
 * 11px, because powerline glyphs are drawn to fill their whole cell — at the
 * text size it renders as a small arrowhead floating mid-line instead of a
 * tapering edge.
 */
function PowerlineDigit({
	number,
	muted,
	pulseNonce,
}: {
	number: number;
	muted: boolean;
	pulseNonce: number | undefined;
}) {
	// Disabled panes keep the shape but lose the colour, so a Waiting bar reads
	// as "not now" rather than as a different design.
	const fill = muted
		? "color-mix(in srgb, var(--fg-secondary) 25%, transparent)"
		: "var(--accent)";

	const reduced = prefersReducedMotion();

	return (
		<motion.span
			className="flex items-stretch shrink-0 transition-colors"
			aria-hidden="true"
			// Keyed on the nonce so a second send of the same action replays rather
			// than being treated as the same animation still running.
			key={pulseNonce ?? "idle"}
			animate={
				pulseNonce === undefined || reduced
					? {}
					: // A single brightening beat, not a loop: the prompt left once.
						{ filter: ["brightness(1)", "brightness(1.9)", "brightness(1)"] }
			}
			transition={{ duration: 0.45, ease: "easeOut", times: [0, 0.18, 1] }}
		>
			<span
				className="tabular-nums flex items-center"
				style={{
					// Wide enough that the block dominates its own taper. At the
					// digit's natural width the two are the same size and the segment
					// reads as an arrowhead rather than as an edge.
					padding: "0 7px",
					backgroundColor: fill,
					color: "var(--bg-primary)",
					fontSize: 11,
					fontWeight: 600,
				}}
			>
				{number}
			</span>
			<span
				style={{
					color: fill,
					// Sized to the cell, not to the label — see above.
					fontSize: BAR_HEIGHT,
					lineHeight: `${BAR_HEIGHT}px`,
					// The glyph carries side bearings that would open a gap between
					// the block and its own taper.
					marginLeft: -1,
					marginRight: 3,
				}}
			>
				{POWERLINE_RIGHT}
			</span>
		</motion.span>
	);
}

/**
 * A highlight that runs left-to-right across the button when it sends.
 *
 * The prompt travels *out* of the pane, so the sweep travels with it. Drawn as
 * an absolutely-positioned overlay rather than a background on the button
 * itself, so it cannot disturb the powerline segment's own colours or the
 * label's layout, and `pointer-events: none` keeps it out of the way of the
 * click that started it.
 */
function SendSweep({ nonce }: { nonce: number | undefined }) {
	if (prefersReducedMotion()) return null;
	return (
		<AnimatePresence>
			{nonce !== undefined && (
				<motion.span
					key={nonce}
					className="absolute inset-y-0 pointer-events-none"
					style={{
						width: "45%",
						background:
							"linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 45%, transparent), transparent)",
					}}
					initial={{ left: "-45%", opacity: 0.9 }}
					animate={{ left: "100%", opacity: 0 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.5, ease: "easeOut" }}
				/>
			)}
		</AnimatePresence>
	);
}

/** Honoured rather than assumed: a repeated flash is exactly the kind of motion
 *  the setting exists to suppress. Read per call — it is cheap, and a user can
 *  change it while the app is open. */
function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
	);
}

/** U+E0B0, the solid right-pointing powerline separator. */
const POWERLINE_RIGHT = "\ue0b0";

/** Height reserved when the bar is present. Exported so a caller sizing the
 *  terminal body can account for it without re-deriving the constant. */
export const ACTION_BAR_HEIGHT = BAR_HEIGHT;
