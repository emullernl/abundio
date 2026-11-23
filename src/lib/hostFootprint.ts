/**
 * What Abundio puts on a Host and what it does there, in plain words, for
 * the ⓘ on a Host in Settings ▸ Hosts: this Host's actual setup when it has
 * been checked, otherwise what Install would do. Pure.
 */
import type { HostCheck } from "./ipc";

export interface FootprintSection {
	title: string;
	/** Sentences; a `path` is shown as one to select and copy. */
	lines: { text: string; path?: string }[];
}

export interface Footprint {
	/** "Not checked yet": what follows is what Install would do. */
	unknown: boolean;
	sections: FootprintSection[];
}

const SERVICE_FILES = {
	systemd: "~/.config/systemd/user/abundio-server.service",
	launchd: "~/Library/LaunchAgents/dev.abundio.server.plist",
};

export function hostFootprint(check: HostCheck | null): Footprint {
	const p = check?.probe;
	const unknown = !p;
	const installed = !!p?.current;
	const mac = p?.os === "Darwin";

	const files: FootprintSection = {
		title: "What is installed",
		lines: unknown
			? [
					{
						text: "Install puts the server, one program, in a folder of its own in your home folder. No root, nothing outside your home folder.",
						path: "~/.abundio-server/",
					},
				]
			: installed
				? [
						{
							text: `Server ${p.current}, a single program. Earlier versions stay beside it until you uninstall.`,
							path: `~/.abundio-server/${p.current}/abundio-server`,
						},
						{
							text: "Its data: this Host's Profiles, Workspaces, layouts, notes, terminal logs and the key for its environment variables.",
							path: "~/.abundio-server/data/",
						},
						{ text: "Installed without root, all in your home folder." },
					]
				: [
						{
							text: "Nothing yet. Install puts the server in ~/.abundio-server, without root.",
						},
					],
	};

	const service: FootprintSection = {
		title: "Keeping it running",
		lines: unknown
			? [
					{
						text: "On Linux, a systemd user service when you may keep services running while logged out (linger); on a Mac, a LaunchAgent in your login session. Either starts the server again by itself if it stops, and you can remove it any time.",
					},
				]
			: p.service === "systemd"
				? [
						{
							text: "A systemd user service: it starts the server when the Host starts and again if it stops.",
							path: SERVICE_FILES.systemd,
						},
						{
							text:
								p.linger === true
									? "Linger is on for your user, so it keeps running while you are logged out."
									: "Linger is off for your user, so it stops soon after you log out.",
						},
					]
				: p.service === "launchd"
					? [
							{
								text: "A LaunchAgent: it starts the server when you log in on the Mac and again if it stops.",
								path: SERVICE_FILES.launchd,
							},
						]
					: [
							{
								text: installed
									? `No service. The server runs until the ${mac ? "Mac restarts or you log out" : "Host restarts"}.`
									: "No service.",
							},
						],
	};

	const what: FootprintSection = {
		title: "What the server does",
		lines: [
			{
				text: "Runs the terminals and Agents of this Host's Workspaces, so they keep working while this computer sleeps or is closed.",
			},
			{
				text: "Reached only through your own ssh, over a socket in its data folder. Agent hooks reach it on a local port (127.0.0.1) with a token. Nothing is open to the network.",
			},
		],
	};

	const agents: FootprintSection = {
		title: "Changes to your Agents",
		lines: [
			{
				text: "With Agent status hooks on (this Host's Agents settings), it adds its hooks to each Agent's own settings, for example ~/.claude/settings.json, ~/.gemini/settings.json and ~/.codex/hooks.json, so their status shows here. Your other settings there are kept.",
			},
			{
				text: "With the Abundio skill on, it installs the skill that teaches Agents the abundio command.",
				path: "~/.agents/skills/abundio",
			},
		],
	};

	const removing: FootprintSection = {
		title: "Removing it",
		lines: [
			{
				text: "Remove service takes the service away; the server keeps running until the Host restarts.",
			},
			{
				text: "Uninstall from the Host stops the server and deletes ~/.abundio-server with its data. Your project folders are never touched.",
			},
			{
				text: "Uninstall leaves the Agent hooks and the skill: switch both off in this Host's Agents settings first to remove them.",
			},
		],
	};

	return { unknown, sections: [files, service, what, agents, removing] };
}
