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

/** Less right padding than a text field: a `<select>` draws its own arrow. */
export const paramSelectStyle: React.CSSProperties = {
	...fieldBase,
	fontSize: 12,
	height: 32,
	width: "auto",
	padding: "0 8px",
};
