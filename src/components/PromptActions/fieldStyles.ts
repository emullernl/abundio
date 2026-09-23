/**
 * Form control styles shared by both **Prompt action** authoring surfaces.
 *
 * **Padding is inline and lives on the base**, never a Tailwind `p-*` utility:
 * `globals.css:273` carries an unlayered `* { margin: 0; padding: 0 }` reset,
 * and an unlayered *normal* declaration beats a layered one whatever its
 * specificity — so every spacing utility in this app is silently dead, and a
 * control that relies on one puts its text and its placeholder hard against
 * the border. See the long note at `SettingsPanel.tsx:188`.
 *
 * The UI font is the default here. Monospace is reserved for the two things
 * that really are code: the prompt **body**, which the Agent reads verbatim,
 * and a **parameter name**, which is a `{{token}}` inside it.
 */

const fieldBase: React.CSSProperties = {
	color: "var(--fg-primary)",
	backgroundColor: "var(--bg-primary)",
	border: "1px solid var(--border)",
	outline: "none",
	width: "100%",
	padding: "0 12px",
};

/** A name or a default value — prose, not code. */
export const paramTextInputStyle: React.CSSProperties = {
	...fieldBase,
	fontSize: 13,
	height: 36,
};

/** The prompt body. Mono, and its `{{placeholders}}` are tokens. */
export const paramBodyInputStyle: React.CSSProperties = {
	...fieldBase,
	fontFamily: "var(--font-mono)",
	fontSize: 12.5,
	lineHeight: 1.6,
	padding: "10px 12px",
};

/** The closed `Select` control. Less left padding than a text field; the room
 *  on the right for the chevron is added by `Select` itself, which draws it. */
export const paramSelectStyle: React.CSSProperties = {
	...fieldBase,
	fontSize: 12,
	height: 32,
	width: "auto",
	padding: "0 8px",
};

/*
 * Button states. Colour, border and the hover/pressed states live in classes,
 * never in an inline `style`: an inline declaration beats any `hover:` or
 * `active:` utility, so the state would silently never show. Sizing and
 * padding stay inline (see the padding note above).
 *
 * Every state is gated on `enabled:` so a disabled button reacts to nothing.
 * Pressed is a small sink (`scale` + a darker fill) rather than a colour swap
 * alone, so the click reads even where two theme colours sit close together.
 */

/** A bordered, quiet button — Cancel, Choose file…, Paste from clipboard. */
export const secondaryButtonClass =
	"inline-flex items-center justify-center gap-2 transition-[background-color,border-color,color,transform] duration-100 " +
	"border border-[var(--border)] text-[var(--fg-secondary)] cursor-pointer " +
	"enabled:hover:bg-[var(--bg-tertiary)] enabled:hover:text-[var(--fg-primary)] " +
	"enabled:hover:border-[color-mix(in_srgb,var(--fg-secondary)_60%,transparent)] " +
	"enabled:active:scale-[0.97] " +
	"enabled:active:bg-[color-mix(in_srgb,var(--bg-tertiary)_80%,var(--fg-primary)_20%)] " +
	"disabled:opacity-60 disabled:cursor-default";

/** The accent-filled action — Send. Hover lifts it with a soft accent ring;
 *  pressed darkens and sinks it. Its fill stays inline, since filter and
 *  shadow are what change. */
export const primaryButtonClass =
	"inline-flex items-center justify-center gap-1.5 transition-[filter,box-shadow,transform] duration-100 " +
	"cursor-pointer disabled:cursor-not-allowed " +
	"enabled:hover:brightness-110 " +
	"enabled:hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_28%,transparent)] " +
	"enabled:active:brightness-90 enabled:active:scale-[0.97] " +
	"enabled:active:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_20%,transparent)]";
