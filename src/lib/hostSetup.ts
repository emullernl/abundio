import type { HostCheck } from "./ipc";

/** The checklist buttons that stop the running server first. */
const RESTARTS = new Set(["install", "update", "service", "unservice"]);

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
			: action === "unservice"
				? "Removing the service restarts the server without it"
				: action === "install"
					? "Installing restarts the server"
					: "Updating restarts the server";
	const count = panes === 1 ? "1 pane is" : `${panes} panes are`;
	return `${count} running on ${host}. ${what}, which ends them and their Agents. Their layouts are kept, and Agents resume their sessions where they can when you open the Profile again.`;
}

/** What Uninstall's confirm says. */
export function uninstallMessage(): string {
	return "This stops the server, ending every pane and Agent it runs, and deletes ~/.abundio-server on the Host, and its service if Abundio set one up: the server and its data (the Host's Profiles, Workspaces, layouts and notes). Your project folders there are not touched.";
}

/** A Host's checklist item, as the summary needs it. */
type Item = HostCheck["items"][number];

/** The lines that need something: an error or a warning. */
export function problemItems(items: readonly Item[]): Item[] {
	return items.filter((i) => i.state === "error" || i.state === "warn");
}

/** A Host's state in one line, for its row in Settings ▸ Hosts. */
export interface HostSummary {
	tone: "ok" | "warn" | "error" | "busy" | "unknown";
	/** One or two words: Ready, Needs attention, Can't reach it… */
	state: string;
	/** What it means, in a sentence, or nothing. */
	detail: string | null;
}

export function hostSummary(
	result: HostCheck | { error: string } | "checking" | undefined,
	busy: string | null,
): HostSummary {
	if (busy) return { tone: "busy", state: busy, detail: null };
	if (result === "checking")
		return { tone: "busy", state: "Checking…", detail: null };
	if (!result)
		return {
			tone: "unknown",
			state: "Not checked yet",
			detail: "Check shows what this Host needs.",
		};
	if ("error" in result) {
		const first = result.error
			.replace(/^[A-Za-z ]+ error: /, "")
			.split("\n")[0];
		return { tone: "error", state: "Can't reach it", detail: first };
	}
	const problems = problemItems(result.items);
	if (problems.length === 0) {
		const { current, os, arch } = result.probe;
		return {
			tone: "ok",
			state: "Ready",
			detail: current
				? `Server ${current} on ${os} ${arch}.`
				: `${os} ${arch}.`,
		};
	}
	const worst = problems.some((p) => p.state === "error") ? "error" : "warn";
	const more = problems.length - 1;
	return {
		tone: worst,
		state: "Needs attention",
		detail:
			more > 0
				? `${problems[0].label}, and ${more} more.`
				: `${problems[0].label}.`,
	};
}

/** "checked just now", "checked 5 min ago", for a remembered check. */
export function checkedAgo(at: number, now = Date.now()): string {
	const min = Math.round((now - at) / 60000);
	if (min < 1) return "Checked just now";
	if (min < 60) return `Checked ${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 24) return `Checked ${h} h ago`;
	return `Checked ${new Date(at).toLocaleDateString()}`;
}
