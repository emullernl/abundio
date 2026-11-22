import type { HostCheck } from "./ipc";

/** The checklist buttons that stop the running server first. */
const RESTARTS = new Set(["install", "update", "service"]);

/**
 * How many running panes a checklist button would end (docs/plans/
 * remote-hosts.md phase 8d), or 0 when it ends none: Install, Update and
 * Set up as a service restart the Host's installed server, and with it every
 * shell and Agent it runs.
 */
export function panesEndedBy(action: string, last: HostCheck): number {
	if (!RESTARTS.has(action) || !last.probe.running) return 0;
	return last.probe.panes ?? 0;
}

/** The confirm text for a restart that ends `panes` panes on `host`. */
export function restartMessage(action: string, host: string, panes: number) {
	const what =
		action === "service"
			? "Setting it up as a service restarts the server"
			: action === "install"
				? "Installing restarts the server"
				: "Updating restarts the server";
	const count = panes === 1 ? "1 pane is" : `${panes} panes are`;
	return `${count} running on ${host}. ${what}, which ends them and their Agents. Their layouts are kept, and Agents resume their sessions where they can when you open the Profile again.`;
}

/** The LaunchAgent label the Mac steps use (ADR-0062, phase 13). */
export const MAC_LAUNCH_AGENT = "dev.abundio.server";

/** What Uninstall's confirm says; `os` is the Host's, when checked. On a
 *  Mac a LaunchAgent the user set up would start the server again, and
 *  Abundio never touches it, so the user unloads it first. */
export function uninstallMessage(os: string | null): string {
	const base =
		"This stops the server, ending every pane and Agent it runs, and deletes ~/.abundio-server on the Host: the server and its data (the Host's Profiles, Workspaces, layouts and notes). Your project folders there are not touched.";
	if (os !== "Darwin") return base;
	return `${base} If you set up a LaunchAgent for it on the Mac, unload it there first, or it starts the server again: launchctl bootout gui/$(id -u)/${MAC_LAUNCH_AGENT}`;
}
