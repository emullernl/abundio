import { useSettingsStore } from "../stores/settingsStore";
import { hostSettingsFromApp } from "./hostSettings";
import { hostSettingsApi, hostsApi } from "./ipc";

/**
 * This computer's Host settings (ADR-0064) are edited where they always
 * were, in the app's own settings, and every change is written into this
 * computer's database at once, so the two never drift and this computer's
 * backend (its hooks, its typed-Agent list) reads the same values. Started
 * in each local Window and in Settings; the writes are the same, so doing it
 * more than once is harmless. Returns a stop function.
 */
export function startHostSettingsMirror(): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let remote: boolean | null = null;
	const write = async () => {
		if (remote === null) {
			remote = !!(await hostsApi.remoteProfileForWindow().catch(() => null));
		}
		// A remote Window's own backend is its Host, which keeps its own.
		if (remote) return;
		await hostSettingsApi
			.set(hostSettingsFromApp(useSettingsStore.getState()))
			.catch((e) =>
				console.warn("[host settings] cannot write this computer's", e),
			);
	};
	const unsubscribe = useSettingsStore.subscribe((s, prev) => {
		if (
			s.agents === prev.agents &&
			s.agentHooksEnabled === prev.agentHooksEnabled &&
			s.agentSkillEnabled === prev.agentSkillEnabled &&
			s.shellPath === prev.shellPath &&
			s.terminalScrollback === prev.terminalScrollback &&
			s.declinedWatchOffers === prev.declinedWatchOffers
		) {
			return;
		}
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void write(), 300);
	});
	return () => {
		if (timer) clearTimeout(timer);
		unsubscribe();
	};
}
