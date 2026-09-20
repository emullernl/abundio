/**
 * Pure helpers for **Prompt actions** — named, parameterised prompts fired at a
 * running Agent from the **Action bar**. See the `Prompt action`, `Parameter`,
 * `Firing`, `Action scope` and `Position number` entries in CONTEXT.md, plus
 * ADR-0038 and ADR-0039.
 *
 * Kept side-effect-free so it is unit-testable, in the same spirit as
 * `fileDrop.ts`. Nothing here touches a PTY, a store or the clipboard — the
 * caller takes the resolved string and pastes it.
 */

import type {
	PromptActionRow,
	PromptActionUpdate,
	PtyActivityState,
} from "./types";

// ── Types ──

export type ParamType = "text" | "number" | "choice" | "toggle" | "attachment";

/**
 * A Parameter's metadata.
 *
 * The *name* deliberately lives only in the body's placeholder — see
 * `deriveParams`. This record is keyed by that name and carries nothing else
 * identifying, so an entry whose placeholder has been deleted is inert rather
 * than a conflict.
 */
export interface ParamMeta {
	type: ParamType;
	/** Pre-filled when the dialog opens. Never a remembered last-used value:
	 *  Enter submits the dialog and firing submits to the Agent, so a reflex
	 *  Enter would send a three-day-old value nobody read. */
	defaultValue?: string;
	/** `choice` only: the options the author defined. */
	options?: string[];
	/** `toggle` only: the author-written text this contributes. Interpolating a
	 *  literal `true`/`false` into a prompt is near-useless, and conditional
	 *  body sections are the template engine this design refuses to build. */
	onText?: string;
	offText?: string;
	/** `attachment` only: allow more than one file. */
	multiple?: boolean;
	/** Defaults to **true** when absent, so every Parameter authored before this
	 *  flag existed stays required. See `isRequired`. */
	required?: boolean;
}

export type ParamMetaMap = Record<string, ParamMeta>;

export type ActionScope =
	| { kind: "all" }
	/** An explicit set. Distinct from `all` on purpose: `all` must pick up an
	 *  Agent added tomorrow, a set naming every current Agent must not. May be
	 *  empty when the only scoped Agent was deleted — kept, never rendered. */
	| { kind: "set"; agentIds: string[] };

export interface PromptAction {
	id: string;
	name: string;
	body: string;
	scope: ActionScope;
	params: ParamMetaMap;
	showInBar: boolean;
	position: number;
	createdAt: number;
	updatedAt: number;
}

/** One field in the parameter dialog: a derived name plus its metadata. */
export interface DerivedParam {
	name: string;
	meta: ParamMeta;
}

// ── Placeholder derivation ──

/**
 * `{{name}}`, with `{{{{` reserved as the escape for a literal `{{`.
 *
 * Names are restricted to word characters, dashes and dots so that prose
 * containing stray braces cannot accidentally mint a Parameter — a body is
 * natural language, and `{{ note the spacing }}` should stay text.
 */
const PLACEHOLDER = /\{\{([A-Za-z0-9_.-]+)\}\}/g;

/** Stand-in for an escaped `{{` while scanning, so the escape is never read as
 *  the start of a placeholder. Chosen from a Unicode private-use area so it
 *  cannot occur in a real body. */
const ESCAPE_SENTINEL = "\uE000";

const DEFAULT_META: ParamMeta = { type: "text" };

function maskEscapes(body: string): string {
	return body.replace(/\{\{\{\{/g, ESCAPE_SENTINEL);
}

function unmaskEscapes(text: string): string {
	return text.replace(new RegExp(ESCAPE_SENTINEL, "g"), "{{");
}

/**
 * The Parameters a body asks for, in **order of first appearance** — which is
 * also the order the sentence reads in, which is the order a user expects to
 * fill them.
 *
 * Derivation rather than declaration is deliberate: the name exists in exactly
 * one place, so a placeholder with no Parameter and a Parameter no placeholder
 * uses are both structurally impossible rather than merely warned about. The
 * cost is that renaming a placeholder drops that Parameter's metadata, since
 * the name is the key — accepted, because the alternative is guessing which
 * edit was a rename.
 *
 * A placeholder used twice is one Parameter.
 */
export function deriveParams(
	body: string,
	meta: ParamMetaMap = {},
): DerivedParam[] {
	const masked = maskEscapes(body);
	const seen = new Set<string>();
	const out: DerivedParam[] = [];
	for (const match of masked.matchAll(PLACEHOLDER)) {
		const name = match[1];
		if (seen.has(name)) continue;
		seen.add(name);
		out.push({ name, meta: meta[name] ?? DEFAULT_META });
	}
	return out;
}

/** Metadata entries no placeholder in `body` refers to. Inert, not an error —
 *  useful for the editor to offer a tidy-up, never for refusing to save. */
export function orphanedParamMeta(body: string, meta: ParamMetaMap): string[] {
	const live = new Set(deriveParams(body, meta).map((p) => p.name));
	return Object.keys(meta).filter((name) => !live.has(name));
}

// ── Sanitising ──

// Strip control characters from an interpolated Parameter **value** before it
// reaches the PTY.
//
// This is `fileDrop`'s injection arriving through a different door. A value is
// typed or pasted by the user, and what they paste may come from a web page or
// from an Agent's own output. An embedded `ESC[201~` closes bracketed paste
// early and a newline (converted to CR) submits whatever follows — so a hostile
// *value* becomes command injection in the shell or the Agent. Removing C0
// (incl. ESC/LF/CR/TAB), DEL and C1 defuses both.
//
// See the matching note in `fileDrop.ts` and the security section of
// docs/plans/prompt-actions.md.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we strip control characters
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function stripControlChars(value: string): string {
	return value.replace(CONTROL_CHARS, "");
}

// ── Resolution ──

/**
 * A Parameter's value as the user supplied it, before interpolation.
 * `attachment` carries paths; everything else carries one string.
 */
export type ParamValue = string | string[] | boolean;

/**
 * Turn one supplied value into the text that replaces its placeholder.
 *
 * A `toggle` resolves to the author's own on/off text rather than to
 * `true`/`false`. An `attachment` joins its paths with spaces — the same shape
 * a multi-file **File drop** produces, so the Agent sees a format this app has
 * already taught it.
 */
export function resolveValue(meta: ParamMeta, value: ParamValue): string {
	if (meta.type === "toggle") {
		const on = value === true || value === "true";
		return on ? (meta.onText ?? "") : (meta.offText ?? "");
	}
	if (meta.type === "attachment") {
		const paths = Array.isArray(value) ? value : [String(value)];
		return paths.map(stripControlChars).filter(Boolean).join(" ");
	}
	if (Array.isArray(value)) return value.map(stripControlChars).join(" ");
	return stripControlChars(String(value));
}

/**
 * The text a **Firing** actually sends, before the trailing `\r`.
 *
 * **The body is deliberately not stripped.** It is author-written and its
 * newlines are the whole point — a numbered list of instructions is a
 * legitimate prompt. Only the interpolated values are sanitised. Do not
 * "fix" this asymmetry; it is load-bearing, and there is a test asserting it.
 *
 * A placeholder whose Parameter was never collected at all is left **as
 * written**. A *required* Parameter cannot reach here empty — the dialog's Send
 * stays disabled until it is filled — so a visible `{{name}}` surfaces a bug
 * rather than hiding it behind an empty string.
 *
 * An **optional** Parameter left empty is a different case, and substituting
 * "" is not enough: it leaves a hole in the sentence, `Review the file:
 * focusing on .` So the placeholder is erased *with its surrounding
 * whitespace*, and a line left with nothing but that placeholder is dropped
 * entirely. This is deliberately the smallest cleanup that reads correctly —
 * it collapses the gap the removal opened and nothing else. It is **not** a
 * conditional-section engine: the author cannot mark arbitrary prose as
 * belonging to a Parameter, and `{{#if}}` remains out of scope.
 */
export function resolveBody(
	body: string,
	params: ParamMetaMap,
	values: Record<string, ParamValue>,
): string {
	const masked = maskEscapes(body);

	// Pass 1: drop any line that is nothing but an omitted optional placeholder
	// (plus whitespace). Done line-wise first, because once the placeholder is
	// replaced in-place there is no way to tell a line that held only it from a
	// line that was blank to begin with.
	const lines = masked.split("\n");
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		const match = /^\{\{([A-Za-z0-9_.-]+)\}\}$/.exec(trimmed);
		if (!match) return true;
		return !isOmitted(match[1], params, values);
	});

	// Pass 2: replace the rest, eating one side's spaces with the placeholder so
	// `for {{x}} today` does not become `for  today`.
	const resolved = kept
		.join("\n")
		.replace(
			new RegExp(`[ \\t]*${PLACEHOLDER.source}`, "g"),
			(whole, name: string) => {
				if (!(name in values)) return whole;
				const meta = params[name] ?? DEFAULT_META;
				if (isOmitted(name, params, values)) return "";
				// Put back the leading space the pattern consumed.
				const lead = /^[ \t]*/.exec(whole)?.[0] ?? "";
				return lead + resolveValue(meta, values[name]);
			},
		);
	return unmaskEscapes(resolved);
}

/** True when an **optional** Parameter was left empty, so its placeholder and
 *  the gap around it should disappear rather than resolve to "". */
function isOmitted(
	name: string,
	params: ParamMetaMap,
	values: Record<string, ParamValue>,
): boolean {
	if (!(name in values)) return false;
	const meta = params[name] ?? DEFAULT_META;
	if (isRequired(meta)) return false;
	return !isFilled(meta, values[name]);
}

/** Values pre-filled when the parameter dialog opens — authored defaults only. */
export function initialValues(
	body: string,
	params: ParamMetaMap,
): Record<string, ParamValue> {
	const out: Record<string, ParamValue> = {};
	for (const { name, meta } of deriveParams(body, params)) {
		if (meta.type === "toggle") {
			out[name] = meta.defaultValue === "true";
		} else if (meta.type === "attachment") {
			out[name] = [];
		} else {
			out[name] = meta.defaultValue ?? "";
		}
	}
	return out;
}

/**
 * Whether a supplied value counts as filled. Every Parameter is required, so
 * this is what disables Send.
 *
 * A `toggle` is always filled — both of its states are meaningful, and the
 * author wrote text for each.
 */
/**
 * Whether a Parameter must be filled before the action may fire.
 *
 * Required is the default, and absent means required — so an action authored
 * before the flag existed keeps the behaviour it was written against.
 *
 * An *optional* Parameter left empty erases its placeholder rather than
 * substituting nothing in place, because "" in the middle of a sentence leaves
 * a hole in it: `Review the file:  focusing on .` See `resolveBody`.
 */
export function isRequired(meta: ParamMeta): boolean {
	// A toggle is never required: both of its states are meaningful and the
	// author wrote text for each, so there is nothing for the user to supply.
	if (meta.type === "toggle") return false;
	return meta.required !== false;
}

export function isFilled(meta: ParamMeta, value: ParamValue): boolean {
	if (meta.type === "toggle") return true;
	if (meta.type === "attachment") {
		return Array.isArray(value) ? value.length > 0 : Boolean(value);
	}
	if (meta.type === "number") {
		const s = String(value).trim();
		return s.length > 0 && Number.isFinite(Number(s));
	}
	return String(value).trim().length > 0;
}

/** Whether the action may fire: every *required* Parameter is filled. */
export function allFilled(
	body: string,
	params: ParamMetaMap,
	values: Record<string, ParamValue>,
): boolean {
	return deriveParams(body, params).every(
		({ name, meta }) => !isRequired(meta) || isFilled(meta, values[name] ?? ""),
	);
}

// ── Firing guard ──

/**
 * Whether an action may be fired at a PTY in this state.
 *
 * **Waiting is refused.** A permission-request hook has put the Agent into a
 * state where its TUI is asking "allow this tool call?", so every keystroke is
 * read as an *answer to that question*. A bracketed paste plus a bare `\r`
 * lands on a menu option and confirms it: the user thinks they queued a prompt
 * and actually granted a file write. Writing to the PTY would additionally tell
 * our own status machine the user had responded, when they had not.
 *
 * **Working is allowed.** Queuing a follow-up mid-turn is a real workflow, the
 * Agent's own input box handles it, and the worst outcome is that the text sits
 * there until the turn ends. Blocking it would make the bar feel dead for most
 * of the time it is wanted.
 *
 * Lives here, pure, so the **Action bar** and **Palette firing** cannot drift
 * apart on the rule — and so the decision is unit-testable even though its
 * *input* still needs runtime verification (see docs/plans/prompt-actions.md).
 */
export function canFire(state: PtyActivityState | undefined): boolean {
	return state !== "waiting";
}

// ── Scope ──

/** Whether an action is offered for a given Agent. */
export function isInScope(
	scope: ActionScope,
	agentId: string | undefined,
): boolean {
	if (scope.kind === "all") return true;
	if (!agentId) return false;
	return scope.agentIds.includes(agentId);
}

/**
 * The actions an **Action bar** shows for a pane, already ordered.
 *
 * Agent-scoped first, then global, each in authored order. Agent-scoped ones
 * are the more specific and more likely intended, so they take the low
 * **position numbers** and therefore the easy digits.
 *
 * `agentId` may be undefined even in an agent-mode pane: the auto-launch path
 * marks a PTY as an Agent knowing only the command string, and the id is
 * backfilled later. Global actions still show — degrading to global-only is the
 * point, since a custom Agent whose id never resolves must still get a usable
 * bar.
 */
export function actionsForPane(
	actions: PromptAction[],
	agentId: string | undefined,
	opts: { barOnly: boolean },
): PromptAction[] {
	const inScope = actions.filter(
		(a) =>
			// A body-less action is a draft: Settings creates the row and the user
			// fills it in afterwards. Never offer one — a button that pastes
			// nothing and then presses Enter would submit an empty prompt to a live
			// Agent. Kept and shown in Settings, exactly like an action whose scope
			// set has emptied out.
			a.body.trim().length > 0 &&
			isInScope(a.scope, agentId) &&
			(!opts.barOnly || a.showInBar),
	);
	const byPosition = (a: PromptAction, b: PromptAction) =>
		a.position - b.position;
	const scoped = inScope.filter((a) => a.scope.kind === "set").sort(byPosition);
	const global = inScope.filter((a) => a.scope.kind === "all").sort(byPosition);
	return [...scoped, ...global];
}

// ── Position numbers ──

/** How many bar buttons get a **position number** and a digit shortcut. */
export const MAX_NUMBERED = 9;

/**
 * The 1-based number shown on a button, or `null` past the ninth.
 *
 * Positional on purpose — a property of where the button sits in *this* bar,
 * not of the action. The two diverge because agent-scoped actions sort ahead of
 * global ones, so the same action is number 2 in one pane and 7 in another. The
 * number's whole job is answering "which key fires this button", and an
 * authored number that disagreed with the visible order would fire the wrong
 * prompt at a live Agent — unrecoverable, since firing submits.
 */
export function positionNumber(index: number): number | null {
	return index < MAX_NUMBERED ? index + 1 : null;
}

/** The label drawn on a bar button. The trailing `…` follows the macOS menu
 *  convention that an item opens a dialog — it matters here because a click
 *  otherwise *submits*, so the ellipsis is the warning that you will be asked
 *  something first. */
export function buttonLabel(action: PromptAction): string {
	const hasParams = deriveParams(action.body, action.params).length > 0;
	return hasParams ? `${action.name}…` : action.name;
}

// ── Wire conversion ──

/**
 * Fold a row into the domain shape.
 *
 * A `paramsJson` that fails to parse degrades to no parameters rather than
 * throwing. Rust validates it on the way in, so this is defence against a row
 * written by a newer build — and an action that renders with no fields is
 * recoverable, whereas a list that fails to load is not.
 */
export function fromRow(row: PromptActionRow): PromptAction {
	let params: ParamMetaMap = {};
	try {
		const parsed: unknown = JSON.parse(row.paramsJson);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			params = parsed as ParamMetaMap;
		}
	} catch {
		// Leave params empty — see above.
	}
	return {
		id: row.id,
		name: row.name,
		body: row.body,
		scope:
			row.scopeKind === "set"
				? { kind: "set", agentIds: row.scopeAgentIds ?? [] }
				: { kind: "all" },
		params,
		showInBar: row.showInBar,
		position: row.position,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Flatten the domain shape back into the wire update. */
export function toUpdate(
	patch: Partial<Pick<PromptAction, "name" | "body" | "showInBar">> & {
		scope?: ActionScope;
		params?: ParamMetaMap;
	},
): PromptActionUpdate {
	const out: PromptActionUpdate = {};
	if (patch.name !== undefined) out.name = patch.name;
	if (patch.body !== undefined) out.body = patch.body;
	if (patch.showInBar !== undefined) out.showInBar = patch.showInBar;
	if (patch.scope) {
		out.scopeKind = patch.scope.kind;
		out.scopeAgentIds = patch.scope.kind === "set" ? patch.scope.agentIds : [];
	}
	if (patch.params) out.paramsJson = JSON.stringify(patch.params);
	return out;
}
