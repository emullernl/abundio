import { Zap } from "lucide-react";
import { useEffect } from "react";
import { inheritSourceWorkspaceId } from "../../lib/worktreeGrouping";
import { useWorkspaceEnvStore } from "../../stores/workspaceEnvStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

interface Props {
	workspaceId: string;
}

/**
 * Status-bar badge naming the Environment Bundle every new terminal in this
 * Workspace receives.
 *
 * It exists because injection is otherwise invisible: nothing in a terminal
 * says which Bundle it was spawned with, and a workspace holding both `dev` and
 * `production` gives that question real stakes. Green, because "your secrets are
 * loaded" is a live state, not a warning — and it is the only green in the bar,
 * so it reads at a glance.
 *
 * Read-only on purpose. The status bar reports what is true; changing which
 * Bundle is injected — or turning injection off — belongs on the bundle row in
 * workspace settings, next to the Bundles it acts on.
 *
 * Hidden when the injected Bundle resolves to nothing, since a badge claiming an
 * environment that is not there would be worse than no badge.
 */
export function InjectedBundlePill({ workspaceId }: Props) {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);
	// The same resolution the PTY spawn path uses, so the badge names the Bundle
	// a terminal would actually get rather than the one this Workspace owns.
	const inheritFromId = inheritSourceWorkspaceId(
		workspaces,
		worktreeFacts,
		workspaceId,
	);

	const summary = useWorkspaceEnvStore((s) => s.injectedSummary[workspaceId]);
	const loadSummary = useWorkspaceEnvStore((s) => s.loadInjectedSummary);
	// Set by the app-wide `env-vars-unavailable` listener, so this is known
	// whether or not the settings dialog was ever opened.
	const keyError = useWorkspaceEnvStore((s) => s.keyError);

	useEffect(() => {
		loadSummary(workspaceId, inheritFromId);
	}, [workspaceId, inheritFromId, loadSummary]);

	// Nothing injected, or an injected Bundle with no variables in it: in both
	// cases a terminal starts with a plain environment.
	if (!summary || summary.varCount === 0) return null;
	// The summary counts rows without opening them, but the spawn path SKIPS
	// rows it cannot open — so a locked or missing credential store means every
	// new terminal gets a plain environment. Green must not survive that.
	if (keyError) return null;

	const plural = summary.varCount === 1 ? "" : "s";

	return (
		<span
			// A status role, not a label-less decoration: a screen reader user
			// gets the same "which environment am I in?" answer the pill gives.
			role="status"
			className="flex items-center"
			title={`${summary.varCount} environment variable${plural} from the "${
				summary.bundle
			}" bundle${
				summary.inherited ? " (inherited from the main worktree)" : ""
			} are injected into every new terminal here`}
			aria-label={`Injected environment bundle: ${summary.bundle}, ${summary.varCount} variable${plural}`}
			style={{
				gap: 5,
				padding: "1px 8px",
				borderRadius: 999,
				fontSize: 11,
				fontWeight: 500,
				fontFamily: "var(--font-mono)",
				lineHeight: 1.6,
				color: "var(--success)",
				backgroundColor: "color-mix(in srgb, var(--success) 14%, transparent)",
				border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)",
			}}
		>
			<Zap size={10} style={{ flexShrink: 0 }} />
			<span>{summary.bundle}</span>
			<span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
				{summary.varCount}
			</span>
		</span>
	);
}
