/**
 * Demo / simulation mode.
 *
 * When enabled, the IPC chokepoint in `lib/ipc.ts` routes every data command
 * to in-memory fixtures instead of the Tauri backend, so the app renders a
 * fully fictional workspace (terminals, agents, git changes, PRs) for clean
 * screenshots and manuals — without touching the real DB, PTYs, git, GitHub,
 * or filesystem.
 *
 * Activated by the `VITE_ABUNDIO_DEMO=true` env var, set by the `pnpm demo`
 * (Tauri) and `pnpm demo:web` (browser) scripts. It is never on in normal
 * builds. Always read the flag through `isDemoMode()` so it stays mockable.
 */
export function isDemoMode(): boolean {
	return import.meta.env.VITE_ABUNDIO_DEMO === "true";
}
