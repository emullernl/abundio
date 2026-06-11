/**
 * macOS WKWebView applies system text-assist features (auto-capitalize first
 * letter, autocorrect, inline suggestions, spellcheck) to every <input> and
 * <textarea> that doesn't explicitly opt out. In a developer tool full of
 * branch names, file paths, and search queries, that behaviour is wrong
 * everywhere — so instead of remembering to add four attributes to every
 * field, a single capture-phase focusin listener stamps the opt-outs onto
 * whatever gains focus.
 *
 * Attributes already present on the element (set via JSX) are left untouched,
 * so a component can still opt back in per-field.
 */

const OPT_OUTS: ReadonlyArray<[attr: string, value: string]> = [
	["autocorrect", "off"],
	["autocapitalize", "off"],
	["spellcheck", "false"],
	["writingsuggestions", "false"],
];

export function applyTextAssistOptOuts(element: Element): void {
	for (const [attr, value] of OPT_OUTS) {
		if (!element.hasAttribute(attr)) {
			element.setAttribute(attr, value);
		}
	}
}

/**
 * Installs the focus guard on `target`. Returns a teardown function that
 * removes the listener — call it when the host is torn down (and in tests,
 * so capture-phase handlers don't accumulate across cases).
 */
export function disableNativeTextAssist(
	target: Document = document,
): () => void {
	const onFocusIn = (event: Event): void => {
		const el = event.target;
		// Intentionally narrow: contenteditable hosts (e.g. the Notes editor's
		// ProseMirror surface, src/components/Notes/NotesEditor.tsx) are prose
		// and *want* spellcheck/autocorrect, so they're deliberately excluded.
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			applyTextAssistOptOuts(el);
		}
	};
	target.addEventListener("focusin", onFocusIn, true);
	return () => target.removeEventListener("focusin", onFocusIn, true);
}
