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

export function disableNativeTextAssist(target: Document = document): void {
	target.addEventListener(
		"focusin",
		(event) => {
			const el = event.target;
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				applyTextAssistOptOuts(el);
			}
		},
		true,
	);
}
