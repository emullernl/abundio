import { create } from "zustand";

export type SettingsSection =
	| "theme"
	| "terminal-font"
	| "ui-font"
	| "shell"
	| "agents"
	| "profiles";

interface SettingsUiState {
	/** When set, the SettingsPanel uses this as its initial section when it
	 *  opens, then clears the field. Used by "Manage Profiles…" entries in
	 *  the File menu and command palette to land the user on the right
	 *  section. */
	requestedSection: SettingsSection | null;
}

export const useSettingsUiStore = create<SettingsUiState>(() => ({
	requestedSection: null,
}));

export function requestSettingsSection(section: SettingsSection): void {
	useSettingsUiStore.setState({ requestedSection: section });
}

export function consumeRequestedSection(): SettingsSection | null {
	const requested = useSettingsUiStore.getState().requestedSection;
	if (requested) {
		useSettingsUiStore.setState({ requestedSection: null });
	}
	return requested;
}
