import { create } from "zustand";
import { agentRegistry as agentRegistryApi } from "../lib/ipc";

interface AgentRegistryState {
	installedCommands: Set<string>;
	/** The commands the scan behind `installedCommands` looked up. A command
	 *  missing from `installedCommands` is only known *not* Installed when it
	 *  is in here; `load` returns early once anything has loaded, so a later
	 *  caller may be reading a scan that never asked about its command. */
	scannedCommands: Set<string>;
	loaded: boolean;
	loading: boolean;
	load: (commands: string[]) => Promise<void>;
	/** Re-scan `$PATH` regardless of the once-guard, e.g. when the Agents
	 * settings section opens, so a mid-session install shows as installed. */
	reload: (commands: string[]) => Promise<void>;
}

/** The scan currently in flight, and the commands it was started with.
 *
 *  Callers that arrive mid-scan join it rather than returning early: both of
 *  them (first-run **Agent seeding** and the Settings "Match to installed"
 *  button) act on `installedCommands` the moment their promise resolves, and an
 *  early return hands them the empty set the in-flight scan is about to
 *  replace. See ADR-0037.
 *
 *  The commands are kept because joining on the *existence* of a scan is not
 *  the same as joining on a scan that answers your question: a caller asking
 *  about a command the in-flight scan never looked up would be told, with no
 *  error, that it isn't installed. */
let inFlight: { promise: Promise<void>; commands: Set<string> } | null = null;

function scan(
	set: (partial: Partial<AgentRegistryState>) => void,
	commands: string[],
): Promise<void> {
	set({ loading: true });
	const promise = agentRegistryApi
		.listInstalled(commands)
		.then((installed) => {
			set({
				installedCommands: new Set(installed),
				scannedCommands: new Set(commands),
				loaded: true,
				loading: false,
			});
		})
		.catch(() => {
			set({
				installedCommands: new Set(),
				scannedCommands: new Set(),
				loaded: true,
				loading: false,
			});
		})
		.finally(() => {
			if (inFlight?.promise === promise) inFlight = null;
		});
	inFlight = { promise, commands: new Set(commands) };
	return promise;
}

/** Join the in-flight scan when it covers everything the caller asked about,
 *  otherwise wait for it and then scan again — the caller gets an answer to
 *  its own question either way. `null` means there is nothing to join. */
function joinable(commands: string[]): Promise<void> | null {
	if (!inFlight) return null;
	const covered = commands.every((c) => inFlight?.commands.has(c));
	return covered ? inFlight.promise : null;
}

export const useAgentRegistryStore = create<AgentRegistryState>((set, get) => ({
	installedCommands: new Set(),
	scannedCommands: new Set(),
	loaded: false,
	loading: false,

	load: async (commands) => {
		if (get().loaded) return;
		const join = joinable(commands);
		if (join) return join;
		if (inFlight) await inFlight.promise;
		await scan(set, commands);
	},

	reload: async (commands) => {
		const join = joinable(commands);
		if (join) return join;
		// Queue behind the in-flight scan rather than racing it: two concurrent
		// scans would both write `installedCommands`, and the later-started one
		// is not necessarily the later to finish.
		if (inFlight) await inFlight.promise;
		await scan(set, commands);
	},
}));
