/**
 * Refusing mouse reporting: the DEC private modes a program uses to ask for the
 * mouse, and the pure helpers around intercepting them. See ADR-0031 and the
 * `Mouse-reporting pane` / `Mouse-blocked pane` entries in CONTEXT.md.
 *
 * A foreground program asks for the mouse by printing `CSI ? <mode> h` (DECSET).
 * xterm parses it, flips `Terminal.modes.mouseTrackingMode`, and from then on
 * forwards clicks — and, for 1002/1003, movement — to the PTY as reports. It is
 * an assertion, not a negotiation: nothing on our side gets a say. Swallowing
 * the DECSET before xterm's own handler sees it is the only way to decline.
 */

/** Modes that turn some flavour of mouse reporting ON.
 *
 *  - `9`    X10 compatibility — button press only
 *  - `1000` VT200 — press and release
 *  - `1001` VT200 highlight tracking
 *  - `1002` button-event — press, release, and motion while a button is down
 *  - `1003` any-event — every motion, button or not
 *
 *  Deliberately excludes `1004` (focus in/out reporting). That is not the
 *  mouse: it fires on window focus, carries no coordinates, and TUIs use it to
 *  redraw a cursor. Blocking it would break those redraws for no gain. */
export const MOUSE_TRACKING_MODES: ReadonlySet<number> = new Set([
	9, 1000, 1001, 1002, 1003,
]);

/** Modes that only choose the *encoding* of a report — UTF-8 (1005), SGR
 *  (1006), urxvt (1015), SGR-pixels (1016). Harmless on their own, since with
 *  tracking off there is nothing to encode. Intercepted anyway so a program
 *  that sets its encoding first and its tracking second doesn't leave xterm
 *  half-configured, and so a later replay restores the pair together. */
const MOUSE_ENCODING_MODES: readonly number[] = [1005, 1006, 1015, 1016];

/** Every DEC private mode number this module treats as "the mouse". */
export const MOUSE_MODES: ReadonlySet<number> = new Set([
	...MOUSE_TRACKING_MODES,
	...MOUSE_ENCODING_MODES,
]);

/** The mouse-mode numbers among a DECSET/DECRST's parameters, in order.
 *
 *  Sub-parameters (`1002:3`, which xterm surfaces as a nested array) are not
 *  mouse modes here. A sub-parameterised private mode is malformed anyway, and
 *  ignoring it is the same fail-open direction as `shouldSwallowDecset`. */
export function mouseModesIn(params: (number | number[])[]): number[] {
	return params.filter(
		(p): p is number => typeof p === "number" && MOUSE_MODES.has(p),
	);
}

/**
 * Whether a DECSET should be swallowed whole: the pane is blocking, and every
 * parameter is a mouse mode.
 *
 * The all-or-nothing rule exists because xterm's parser hook is all-or-nothing.
 * The handler returns one boolean for the sequence, and there is no supported
 * way to apply some parameters and drop the rest. A mixed set such as
 * `CSI ? 1049 ; 1002 h` therefore passes through untouched and the program does
 * get the mouse.
 *
 * That is the deliberate direction to fail in. Swallowing the mixed sequence
 * would drop the alternate-screen switch alongside it and leave a full-screen
 * TUI painting over the shell's scrollback — a visible, unrecoverable mess —
 * against a failure mode that is merely the behaviour of every previous
 * release. Mixing mouse and non-mouse modes in one DECSET is in any case
 * vanishingly rare: ncurses, tmux, vim and the agent TUIs all emit their mouse
 * modes in sequences of their own. See ADR-0031.
 */
export function shouldSwallowDecset(
	params: (number | number[])[],
	blocked: boolean,
): boolean {
	if (!blocked || params.length === 0) return false;
	return mouseModesIn(params).length === params.length;
}

/** True if any of these modes actually turns reporting on, as opposed to only
 *  choosing an encoding. Drives the mouse badge: a program that set 1006 and
 *  nothing else has not asked for the mouse in any sense the user would see. */
export function hasTrackingMode(modes: Iterable<number>): boolean {
	for (const m of modes) if (MOUSE_TRACKING_MODES.has(m)) return true;
	return false;
}

/**
 * DECRSTs turning every mouse mode off, written *into* xterm (never sent to the
 * PTY) when a pane starts blocking while its program is already reporting.
 *
 * This works because the interception is asymmetric: DECSET (`h`) is
 * intercepted, DECRST (`l`) never is. Blocking the disables too would look
 * tidier and be strictly worse — a mode that slipped through as part of a mixed
 * DECSET could then never be turned off again, and the pane would report for
 * the rest of its life.
 */
export const MOUSE_MODES_OFF_SEQUENCE = [...MOUSE_MODES]
	.map((mode) => `\x1b[?${mode}l`)
	.join("");

/**
 * DECSETs re-asserting the modes a pane refused, written into xterm when the
 * pane stops blocking.
 *
 * Without this the control is a lie. A program asks for the mouse exactly once:
 * swallow tmux's `?1000h`, lift the block a minute later, and nothing happens,
 * because tmux is never going to ask again. The user unticks a box and sees no
 * change — so the pane replays what it refused, and the mouse arrives at the
 * moment they asked for it.
 *
 * Emitted in ascending mode order so an encoding mode (1005/1006/1015/1016) is
 * always re-applied after the tracking mode it encodes, matching the order
 * programs use.
 */
export function mouseModesOnSequence(modes: Iterable<number>): string {
	return [...modes]
		.filter((m) => MOUSE_MODES.has(m))
		.sort((a, b) => a - b)
		.map((mode) => `\x1b[?${mode}h`)
		.join("");
}

/** What a pane's mouse badge shows. `"none"` means no badge at all — the
 *  program never asked for the mouse, so there is nothing to explain. */
export type MouseBadgeState = "reporting" | "blocked" | "none";

/**
 * The badge state for a pane, from xterm's live tracking mode and the modes its
 * program has asked for.
 *
 * xterm's own state is consulted FIRST, deliberately, so the badge reports what
 * is actually happening rather than what we intended. A mixed DECSET fails open
 * (see `shouldSwallowDecset`), so a pane that is nominally blocking can still
 * end up reporting — and when it does, the badge says so, and clicking it
 * sweeps the modes back off.
 */
export function mouseBadgeStateFor(
	trackingMode: string,
	wanted: Iterable<number>,
): MouseBadgeState {
	if (trackingMode !== "none") return "reporting";
	if (hasTrackingMode(wanted)) return "blocked";
	return "none";
}

/** The sequence to write into xterm when a pane changes sides: sweep the mouse
 *  off, or replay what the pane refused. Never sent to the PTY — the program is
 *  not told, because there is no sequence that would tell it. */
export function mouseTransitionSequence(
	blocked: boolean,
	wanted: Iterable<number>,
): string {
	return blocked ? MOUSE_MODES_OFF_SEQUENCE : mouseModesOnSequence(wanted);
}
