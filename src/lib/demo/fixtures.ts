/**
 * Fictional data for demo mode. Neutral generic projects (no real repo).
 *
 * Thirty workspaces are defined declaratively in `WS_DEFS`; `workspaces`,
 * `agentPanes`, `gitByRoot`, `branchesForCwd`, `workspaceRoots` and
 * `nonGitRoots` are all derived from it. They span a wide variety of configs:
 * single agents, splits, nested splits, multiple agents in one workspace,
 * file panes, agent states (active / waiting / error / idle), shells (running
 * vs idle), no-agent workspaces, and heavy / clean / non-git repos.
 *
 * Layout `ptyId`s are empty: `workspaceStore.loadWorkspaces` runs `clearPtyIds`
 * on load, so transcripts and agent dots are keyed by the stable **paneId**
 * (delivered as `pty_spawn`'s `logId` arg), not by ptyId.
 */
import type {
	AgentHookStatus,
	GitFetchBundle,
	WorkspaceGitSummary,
} from "../ipc";
import type {
	AvailableShell,
	BranchInfo,
	DetectedDevEnvironment,
	DirEntry,
	FileContent,
	FileEntry,
	GhStatus,
	GitChangedFile,
	GitFileDiff,
	PaneNode,
	Profile,
	PullRequest,
	Tab,
	WorkspaceWithTabs,
} from "../types";

/** Fixed epoch so fixtures are deterministic (no `Date.now()`). */
const T0 = 1_716_960_000_000;

const CODE = "/Users/demo/code";
export const ACME_ROOT = `${CODE}/acme-web`;
export const PAYMENTS_ROOT = `${CODE}/payments-api`;

// ── Profiles ──

export const profiles: Profile[] = [
	{
		id: "demo-personal",
		name: "Personal",
		position: 0,
		createdAt: T0,
		updatedAt: T0,
	},
	{ id: "demo-work", name: "Work", position: 1, createdAt: T0, updatedAt: T0 },
];

export const ACTIVE_PROFILE_ID = profiles[0].id;

// ── Declarative workspace model ──

type AgentState = "active" | "ready" | "waiting" | "error" | "idle";

type PaneDef =
	| { t: "agent"; agent: string; st: AgentState; tx: string }
	| { t: "shell"; st: Exclude<AgentState, "ready">; tx: string }
	| { t: "file"; path: string }
	| { t: "h" | "v"; r: number; a: PaneDef; b: PaneDef };

/** [path, status, additions, deletions, section] */
type Cf = [string, string, number, number, GitChangedFile["section"]];

interface TabDef {
	name: string;
	pane: PaneDef;
}

interface WsDef {
	id: string;
	name: string;
	base: string;
	branch: string;
	tabs: TabDef[];
	/** Changed files; omitted = clean working tree. */
	git?: Cf[];
	/** Extra branches to offer in the branch selector. */
	branches?: string[];
	nonGit?: boolean;
	/** Override the derived `${CODE}/${name}` root — used for worktree folders
	 *  that live under `<repo>.worktrees/<branch>`. */
	root?: string;
}

const a = (agent: string, st: AgentState, tx: string): PaneDef => ({
	t: "agent",
	agent,
	st,
	tx,
});
const sh = (st: Exclude<AgentState, "ready">, tx: string): PaneDef => ({
	t: "shell",
	st,
	tx,
});
const fl = (path: string): PaneDef => ({ t: "file", path });
const h = (r: number, x: PaneDef, y: PaneDef): PaneDef => ({
	t: "h",
	r,
	a: x,
	b: y,
});
const v = (r: number, x: PaneDef, y: PaneDef): PaneDef => ({
	t: "v",
	r,
	a: x,
	b: y,
});
const one = (name: string, pane: PaneDef): TabDef[] => [{ name, pane }];

// Pane DSL legend — the terse helpers above keep each `WS_DEFS` row to one line:
//   a(agent, state, transcript)  — agent pane
//   sh(state, transcript)        — shell pane
//   fl(path)                     — file pane
//   h(ratio, left, right)        — horizontal split
//   v(ratio, top, bottom)        — vertical split
//   one(name, pane)              — single-tab shorthand
// PaneDef fields: t=type, st=state, tx=transcript, r=split ratio.
const WS_DEFS: WsDef[] = [
	// 1 — acme-web: agent tab + dev split + code split with a file pane
	{
		id: "ws-acme",
		name: "acme-web",
		base: "main",
		branch: "feature/checkout-redesign",
		tabs: [
			{ name: "Agent", pane: a("claude", "active", "claudeSession") },
			{
				name: "Dev",
				pane: h(0.55, sh("active", "devServer"), sh("idle", "idleShell")),
			},
			{
				name: "Code",
				pane: v(0.7, fl("src/api/checkout.ts"), sh("idle", "scratchShell")),
			},
		],
		git: [
			["src/api/checkout.ts", "M", 32, 6, "against_base"],
			["src/components/Cart.tsx", "M", 18, 4, "against_base"],
			["src/api/__tests__/checkout.test.ts", "A", 41, 0, "staged"],
			["src/lib/money.ts", "M", 9, 2, "unstaged"],
			["README.md", "M", 2, 1, "unstaged"],
		],
		branches: ["fix/cart-rounding", "chore/deps"],
	},
	// 2 — payments-api: single Copilot agent (waiting)
	{
		id: "ws-payments",
		name: "payments-api",
		base: "develop",
		branch: "main",
		tabs: one("Agent", a("copilot", "waiting", "copilotSession")),
		git: [["src/webhooks/stripe.ts", "M", 34, 6, "against_base"]],
		branches: ["feature/webhook-retries"],
	},
	// 3 — ml-pipeline: Gemini + nested split (shell over a file pane)
	{
		id: "ws-ml",
		name: "ml-pipeline",
		base: "main",
		branch: "feature/training-loop",
		tabs: one(
			"Train",
			v(
				0.5,
				a("gemini", "active", "geminiSession"),
				h(0.6, sh("idle", "pythonTrain"), fl("src/train.py")),
			),
		),
		git: [
			["src/data/loader.py", "M", 22, 5, "against_base"],
			["src/train.py", "M", 14, 3, "unstaged"],
			["configs/train.yaml", "M", 4, 1, "unstaged"],
		],
		branches: ["experiment/mixed-precision"],
	},
	// 4 — design-system: single Aider agent (waiting), clean tree
	{
		id: "ws-design",
		name: "design-system",
		base: "main",
		branch: "main",
		tabs: one("Aider", a("aider", "waiting", "aiderSession")),
		branches: ["feature/dark-mode"],
	},
	// 5 — infra-terraform: Codex errored | plan output
	{
		id: "ws-infra",
		name: "infra-terraform",
		base: "main",
		branch: "fix/state-drift",
		tabs: one(
			"Apply",
			h(0.5, a("codex", "error", "codexSession"), sh("idle", "terraformPlan")),
		),
		git: [
			["modules/vpc/main.tf", "M", 51, 12, "against_base"],
			["modules/vpc/variables.tf", "M", 8, 0, "against_base"],
			["envs/prod/terraform.tfvars", "M", 3, 3, "staged"],
			["versions.tf", "M", 2, 2, "unstaged"],
		],
		branches: ["feature/multi-region"],
	},
	// 6 — docs-site: markdown file pane + idle shell, no agent
	{
		id: "ws-docs",
		name: "docs-site",
		base: "main",
		branch: "docs/api-reference",
		tabs: one("Docs", v(0.65, fl("README.md"), sh("idle", "idleShell"))),
		git: [
			["docs/api/checkout.md", "A", 96, 0, "staged"],
			["README.md", "M", 12, 4, "unstaged"],
		],
	},
	// 7 — game-server: single OpenCode agent (active)
	{
		id: "ws-game",
		name: "game-server",
		base: "main",
		branch: "feature/matchmaking",
		tabs: one("Server", a("opencode", "active", "opencodeSession")),
		git: [
			["internal/match/elo.go", "A", 88, 0, "against_base"],
			["internal/match/elo_test.go", "A", 64, 0, "against_base"],
			["internal/lobby/loop.go", "M", 27, 9, "against_base"],
			["internal/lobby/state.go", "M", 11, 2, "staged"],
			["cmd/server/main.go", "M", 6, 1, "unstaged"],
			["go.mod", "M", 2, 0, "unstaged"],
		],
		branches: ["perf/netcode"],
	},
	// 8 — data-warehouse: Qwen + sql shell
	{
		id: "ws-dwh",
		name: "data-warehouse",
		base: "main",
		branch: "feature/incremental-load",
		tabs: one(
			"dbt",
			h(0.55, a("qwen", "waiting", "qwenSession"), sh("idle", "sqlRun")),
		),
		git: [
			["models/fact_orders.sql", "M", 41, 7, "against_base"],
			["models/schema.yml", "M", 9, 0, "unstaged"],
		],
	},
	// 9 — legacy-monolith: two agents (Claude + Copilot) and a shell, heavy diff
	{
		id: "ws-mono",
		name: "legacy-monolith",
		base: "master",
		branch: "refactor/extract-billing",
		tabs: one(
			"Refactor",
			h(
				0.5,
				a("claude", "active", "claudeSession"),
				v(
					0.6,
					a("copilot", "waiting", "copilotSession"),
					sh("idle", "scratchShell"),
				),
			),
		),
		git: [
			["app/models/billing/invoice.rb", "M", 61, 24, "against_base"],
			["app/services/billing/charge.rb", "A", 132, 0, "against_base"],
			["app/controllers/invoices_controller.rb", "M", 38, 41, "against_base"],
			["spec/services/billing/charge_spec.rb", "A", 88, 0, "staged"],
			["config/routes.rb", "M", 4, 2, "staged"],
			["db/schema.rb", "M", 17, 3, "unstaged"],
			["Gemfile", "M", 1, 0, "unstaged"],
			["app/views/invoices/show.html.erb", "M", 6, 9, "unstaged"],
		],
		branches: ["hotfix/tax-rounding"],
	},
	// 10 — scratch: single shell in a non-git folder
	{
		id: "ws-scratch",
		name: "scratch",
		base: "main",
		branch: "main",
		tabs: one("Shell", sh("idle", "idleShell")),
		nonGit: true,
	},
	// 11 — portfolio-site: attached-but-idle Gemini, clean tree
	{
		id: "ws-portfolio",
		name: "portfolio-site",
		base: "main",
		branch: "main",
		tabs: one("Site", a("gemini", "idle", "geminiSession")),
	},
	// 12 — analytics-dashboard
	{
		id: "ws-analytics",
		name: "analytics-dashboard",
		base: "main",
		branch: "feature/funnel-report",
		tabs: one(
			"Build",
			h(0.55, a("claude", "waiting", "claudeSession"), sh("idle", "idleShell")),
		),
		git: [
			["src/charts/Funnel.tsx", "M", 44, 8, "against_base"],
			["src/data/query.ts", "M", 12, 3, "unstaged"],
			["src/pages/Overview.tsx", "M", 7, 2, "unstaged"],
		],
	},
	// 13 — auth-service
	{
		id: "ws-auth",
		name: "auth-service",
		base: "main",
		branch: "feature/oauth-pkce",
		tabs: one("Agent", a("copilot", "active", "copilotSession")),
		git: [
			["src/oauth/pkce.ts", "A", 73, 0, "against_base"],
			["src/oauth/index.ts", "M", 5, 1, "staged"],
		],
	},
	// orbit-dashboard: a Worktree set (primary + two linked worktrees), showing
	// parallel work across worktrees of one repo. Grouping is driven by the
	// shared worktreeGroupKey returned from `workspaceSummary` (WORKTREE_SETS).
	{
		id: "ws-orbit",
		name: "orbit-dashboard",
		root: `${CODE}/orbit-dashboard`,
		base: "main",
		branch: "main",
		tabs: one(
			"Dev",
			h(0.55, sh("active", "devServer"), sh("idle", "idleShell")),
		),
		branches: ["feature/charts-revamp", "chore/a11y-audit"],
	},
	{
		id: "ws-orbit-charts",
		name: "charts-revamp",
		root: `${CODE}/orbit-dashboard.worktrees/charts-revamp`,
		base: "main",
		branch: "feature/charts-revamp",
		tabs: [
			{ name: "Agent", pane: a("claude", "active", "claudeSession") },
			{
				name: "Dev",
				pane: h(0.5, sh("active", "devServer"), sh("idle", "scratchShell")),
			},
		],
		git: [
			["src/charts/Donut.tsx", "M", 44, 12, "against_base"],
			["src/charts/index.ts", "M", 6, 1, "against_base"],
			["src/charts/__tests__/donut.test.ts", "A", 38, 0, "staged"],
		],
	},
	{
		id: "ws-orbit-a11y",
		name: "a11y-audit",
		root: `${CODE}/orbit-dashboard.worktrees/a11y-audit`,
		base: "main",
		branch: "chore/a11y-audit",
		tabs: one("Audit", a("copilot", "waiting", "copilotSession")),
		git: [["src/components/Modal.tsx", "M", 15, 3, "unstaged"]],
	},
	// 14 — notification-svc
	{
		id: "ws-notify",
		name: "notification-svc",
		base: "main",
		branch: "feature/push-batching",
		tabs: one("Agent", a("gemini", "active", "geminiSession")),
		git: [
			["src/push/batcher.ts", "M", 31, 6, "against_base"],
			["src/push/worker.ts", "M", 9, 4, "unstaged"],
		],
	},
	// 15 — search-indexer (agent errored)
	{
		id: "ws-search",
		name: "search-indexer",
		base: "main",
		branch: "fix/reindex-deadlock",
		tabs: one("Agent", a("aider", "error", "aiderSession")),
		git: [["src/index/worker.rs", "M", 22, 14, "against_base"]],
	},
	// 16 — image-cdn (clean)
	{
		id: "ws-cdn",
		name: "image-cdn",
		base: "main",
		branch: "main",
		tabs: one("Agent", a("codex", "active", "codexSession")),
	},
	// 17 — billing-worker
	{
		id: "ws-billing",
		name: "billing-worker",
		base: "main",
		branch: "feature/proration",
		tabs: one(
			"Worker",
			h(0.5, a("opencode", "waiting", "opencodeSession"), sh("idle", "sqlRun")),
		),
		git: [
			["src/jobs/proration.ts", "A", 64, 0, "against_base"],
			["src/jobs/index.ts", "M", 4, 0, "staged"],
			["test/proration.test.ts", "A", 38, 0, "unstaged"],
		],
	},
	// 18 — graphql-gateway
	{
		id: "ws-gateway",
		name: "graphql-gateway",
		base: "main",
		branch: "feature/federation",
		tabs: one("Agent", a("qwen", "active", "qwenSession")),
		git: [
			["src/schema/federation.graphql", "M", 28, 5, "against_base"],
			["src/resolvers/user.ts", "M", 11, 2, "unstaged"],
		],
	},
	// 19 — ios-app
	{
		id: "ws-ios",
		name: "ios-app",
		base: "main",
		branch: "feature/widgets",
		tabs: one(
			"Xcode",
			h(
				0.55,
				a("claude", "active", "claudeSession"),
				fl("Sources/HomeWidget.swift"),
			),
		),
		git: [
			["Sources/HomeWidget.swift", "A", 121, 0, "against_base"],
			["Sources/App.swift", "M", 8, 3, "unstaged"],
		],
	},
	// 20 — android-app
	{
		id: "ws-android",
		name: "android-app",
		base: "main",
		branch: "feature/material-you",
		tabs: one("Agent", a("copilot", "waiting", "copilotSession")),
		git: [["app/src/main/java/Theme.kt", "M", 36, 12, "against_base"]],
	},
	// 21 — cli-tool (idle agent, clean)
	{
		id: "ws-cli",
		name: "cli-tool",
		base: "main",
		branch: "main",
		tabs: one("Agent", a("gemini", "idle", "geminiSession")),
	},
	// 22 — terraform-modules (no agent, two shells)
	{
		id: "ws-tfmod",
		name: "terraform-modules",
		base: "main",
		branch: "feature/eks-module",
		tabs: one(
			"Plan",
			h(0.5, sh("idle", "terraformPlan"), sh("active", "devServer")),
		),
		git: [["modules/eks/main.tf", "A", 142, 0, "against_base"]],
	},
	// 23 — k8s-manifests (waiting agent, clean)
	{
		id: "ws-k8s",
		name: "k8s-manifests",
		base: "main",
		branch: "main",
		tabs: one("Agent", a("codex", "waiting", "codexSession")),
	},
	// 24 — blog-engine
	{
		id: "ws-blog",
		name: "blog-engine",
		base: "main",
		branch: "feature/mdx-shortcodes",
		tabs: one("Agent", a("aider", "active", "aiderSession")),
		git: [
			["lib/mdx/shortcodes.ts", "A", 57, 0, "against_base"],
			["content/posts/launch.mdx", "M", 14, 6, "unstaged"],
			["lib/render.ts", "M", 5, 1, "unstaged"],
		],
	},
	// 25 — video-encoder
	{
		id: "ws-video",
		name: "video-encoder",
		base: "main",
		branch: "feature/hwaccel",
		tabs: one("Agent", a("opencode", "active", "opencodeSession")),
		git: [
			["src/encode/hwaccel.c", "M", 88, 19, "against_base"],
			["src/encode/pipeline.c", "M", 12, 4, "unstaged"],
		],
	},
	// 26 — chat-app (two agents)
	{
		id: "ws-chat",
		name: "chat-app",
		base: "main",
		branch: "feature/threads",
		tabs: one(
			"Threads",
			h(
				0.5,
				a("claude", "waiting", "claudeSession"),
				v(
					0.6,
					a("copilot", "active", "copilotSession"),
					sh("idle", "idleShell"),
				),
			),
		),
		git: [
			["src/threads/store.ts", "A", 96, 0, "against_base"],
			["src/threads/view.tsx", "A", 74, 0, "against_base"],
			["src/ws/socket.ts", "M", 18, 5, "staged"],
			["src/App.tsx", "M", 6, 2, "unstaged"],
		],
	},
	// 27 — recommendation-engine (agent errored)
	{
		id: "ws-reco",
		name: "recommendation-engine",
		base: "main",
		branch: "experiment/two-tower",
		tabs: one("Agent", a("gemini", "error", "geminiSession")),
		git: [["src/models/two_tower.py", "M", 41, 27, "against_base"]],
	},
	// 28 — payment-gateway
	{
		id: "ws-paygw",
		name: "payment-gateway",
		base: "main",
		branch: "feature/3ds2",
		tabs: one(
			"Gateway",
			h(0.55, a("qwen", "waiting", "qwenSession"), sh("idle", "sqlRun")),
		),
		git: [
			["src/3ds/challenge.ts", "A", 83, 0, "against_base"],
			["src/router.ts", "M", 9, 3, "unstaged"],
		],
	},
	// 29 — admin-portal (idle agent, clean)
	{
		id: "ws-admin",
		name: "admin-portal",
		base: "main",
		branch: "main",
		tabs: one("Agent", a("aider", "idle", "aiderSession")),
	},
	// 30 — iot-bridge (no agent, running dev server)
	{
		id: "ws-iot",
		name: "iot-bridge",
		base: "main",
		branch: "feature/mqtt-tls",
		tabs: one("Bridge", sh("active", "devServer")),
		git: [["src/mqtt/tls.ts", "M", 24, 7, "against_base"]],
	},
];

/** Workspaces opened on launch: acme-web (active) + 10 others, chosen for a
 *  varied Overview bar (every agent state, shells, no-agent, non-git). */
export const OPEN_ON_LAUNCH = [
	"ws-acme",
	"ws-payments",
	"ws-ml",
	"ws-infra",
	"ws-design",
	"ws-mono",
	"ws-game",
	"ws-dwh",
	"ws-portfolio",
	"ws-docs",
	"ws-scratch",
	// orbit-dashboard Worktree set — primary + the agent-running linked worktree.
	"ws-orbit",
	"ws-orbit-charts",
];

// ── Derive everything from WS_DEFS ──

export interface DemoPaneSpec {
	mode: "agent" | "shell";
	agentId?: string;
	state: AgentState;
	transcript: string;
}

export const agentPanes: Record<string, DemoPaneSpec> = {};

/** workspaceId → its terminal pane ids (agents + shells). Used to pre-seed
 *  status dots for opened workspaces before their PTYs spawn. */
export const panesByWorkspace: Record<string, string[]> = {};

function buildPane(
	def: PaneDef,
	root: string,
	wsId: string,
	ctr: { n: number },
): PaneNode {
	const id = `${wsId}-p${ctr.n++}`;
	const recordPane = () => {
		panesByWorkspace[wsId] ??= [];
		panesByWorkspace[wsId].push(id);
	};
	switch (def.t) {
		case "agent":
			agentPanes[id] = {
				mode: "agent",
				agentId: def.agent,
				state: def.st,
				transcript: def.tx,
			};
			recordPane();
			return { type: "terminal", id, ptyId: "", agentId: def.agent, cwd: root };
		case "shell":
			agentPanes[id] = { mode: "shell", state: def.st, transcript: def.tx };
			recordPane();
			return { type: "terminal", id, ptyId: "", cwd: root };
		case "file":
			return { type: "file", id, filePath: `${root}/${def.path}` };
		default:
			return {
				type: "split",
				id,
				direction: def.t === "h" ? "horizontal" : "vertical",
				ratio: def.r,
				first: buildPane(def.a, root, wsId, ctr),
				second: buildPane(def.b, root, wsId, ctr),
			};
	}
}

function rootOf(name: string): string {
	return `${CODE}/${name}`;
}

// Worktree sets surfaced in the demo sidebar. Each linked root shares its
// primary's `groupKey`, which is what makes them render as one Worktree set.
const WORKTREE_SETS: { groupKey: string; primary: string; linked: string[] }[] =
	[
		{
			groupKey: `${CODE}/orbit-dashboard/.git`,
			primary: `${CODE}/orbit-dashboard`,
			linked: [
				`${CODE}/orbit-dashboard.worktrees/charts-revamp`,
				`${CODE}/orbit-dashboard.worktrees/a11y-audit`,
			],
		},
	];

/** root → worktree grouping facts, for `workspaceSummary` to look up. */
const worktreeFactByRoot = new Map<
	string,
	{ groupKey: string; isMain: boolean }
>();
for (const set of WORKTREE_SETS) {
	worktreeFactByRoot.set(set.primary, { groupKey: set.groupKey, isMain: true });
	for (const linked of set.linked) {
		worktreeFactByRoot.set(linked, { groupKey: set.groupKey, isMain: false });
	}
}

const gitByRoot: Record<
	string,
	{ files: GitChangedFile[]; branch: BranchInfo }
> = {};
export const branchesForCwd: Record<string, string[]> = {};
export const nonGitRoots = new Set<string>();

export const workspaces: WorkspaceWithTabs[] = WS_DEFS.map((def, i) => {
	const root = def.root ?? rootOf(def.name);
	const ctr = { n: 0 };
	const tabs: Tab[] = def.tabs.map((t, ti) => ({
		id: `${def.id}-tab-${ti}`,
		workspaceId: def.id,
		name: t.name,
		layoutJson: JSON.stringify(buildPane(t.pane, root, def.id, ctr)),
		position: ti,
		createdAt: T0,
		updatedAt: T0,
	}));

	if (def.nonGit) {
		nonGitRoots.add(root);
	} else {
		gitByRoot[root] = {
			files: (def.git ?? []).map(
				([path, status, additions, deletions, section]) => ({
					path,
					status,
					additions,
					deletions,
					section,
				}),
			),
			branch: { defaultBranch: def.base, currentBranch: def.branch },
		};
		branchesForCwd[root] = Array.from(
			new Set([def.base, def.branch, ...(def.branches ?? [])]),
		);
	}

	return {
		id: def.id,
		name: def.name,
		rootFolder: root,
		envJson: "{}",
		agentPresetsJson: "[]",
		fileTabsJson: "[]",
		baseBranch: def.base,
		lastBranch: def.branch,
		position: i,
		profileId: ACTIVE_PROFILE_ID,
		createdAt: T0,
		updatedAt: T0,
		worktreeSetupCommands: "",
		tabs,
	};
});

/** workspaceId → rootFolder, for resolving git/summary requests. */
export const workspaceRoots: Record<string, string> = Object.fromEntries(
	workspaces.map((w) => [w.id, w.rootFolder]),
);

const allRoots = workspaces.map((w) => w.rootFolder);

// ── Git ──

const CLEAN_BRANCH: BranchInfo = {
	defaultBranch: "main",
	currentBranch: "main",
};

/** Resolve a fetch bundle from a workspace cwd. */
export function gitBundleForCwd(cwd: string): GitFetchBundle {
	const entry = gitByRoot[cwd];
	return {
		changedFiles: entry?.files ?? [],
		branchInfo: entry?.branch ?? CLEAN_BRANCH,
		statusFingerprint: `demo-fp-${cwd}`,
	};
}

export function workspaceSummary(
	workspaceId: string,
	cwd: string,
): WorkspaceGitSummary {
	if (nonGitRoots.has(cwd)) {
		return {
			workspaceId,
			isGitRepo: false,
			currentBranch: null,
			changedFileCount: 0,
			additions: 0,
			deletions: 0,
			worktreeGroupKey: null,
			isMainWorktree: false,
			worktreeRoot: null,
		};
	}
	const bundle = gitBundleForCwd(cwd);
	const additions = bundle.changedFiles.reduce((n, f) => n + f.additions, 0);
	const deletions = bundle.changedFiles.reduce((n, f) => n + f.deletions, 0);
	return {
		workspaceId,
		isGitRepo: true,
		currentBranch: bundle.branchInfo.currentBranch,
		changedFileCount: bundle.changedFiles.length,
		additions,
		deletions,
		// Roots listed in WORKTREE_SETS group into a Worktree set; every other
		// repo is its own standalone main worktree.
		worktreeGroupKey: worktreeFactByRoot.get(cwd)?.groupKey ?? `${cwd}/.git`,
		isMainWorktree: worktreeFactByRoot.get(cwd)?.isMain ?? true,
		worktreeRoot: cwd,
	};
}

// ── File diffs (keyed by the changed-file relative path) ──

export const fileDiffs: Record<string, GitFileDiff> = {
	"src/api/checkout.ts": {
		filePath: "src/api/checkout.ts",
		original: [
			"export async function createCheckout(payload: CheckoutPayload) {",
			"  const intent = await stripe.paymentIntents.create({",
			"    amount: payload.total,",
			"    currency: payload.currency,",
			"  });",
			"  return intent;",
			"}",
			"",
		].join("\n"),
		modified: [
			"export async function createCheckout(payload: CheckoutPayload) {",
			"  const computedTotal = payload.lineItems.reduce(",
			"    (sum, item) => sum + item.unitPrice * item.quantity,",
			"    0,",
			"  );",
			"  if (computedTotal !== payload.total) {",
			'    throw new CheckoutError("cart_total_mismatch");',
			"  }",
			"  const intent = await stripe.paymentIntents.create({",
			"    amount: computedTotal,",
			"    currency: payload.currency,",
			"  });",
			"  return intent;",
			"}",
			"",
		].join("\n"),
	},
	"src/components/Cart.tsx": {
		filePath: "src/components/Cart.tsx",
		original: [
			"export function Cart({ items }: CartProps) {",
			"  const total = items.reduce((s, i) => s + i.price, 0);",
			"  return <CartSummary total={total} />;",
			"}",
			"",
		].join("\n"),
		modified: [
			"export function Cart({ items }: CartProps) {",
			"  const total = items.reduce(",
			"    (s, i) => s + i.price * i.quantity,",
			"    0,",
			"  );",
			"  return <CartSummary total={formatMoney(total)} />;",
			"}",
			"",
		].join("\n"),
	},
};

// ── Pull requests (tagged by repository; filtered per-cwd for repo views) ──

export const ghStatus: GhStatus = {
	available: true,
	authenticated: true,
};

/** acme/<basename>, matching each workspace's repository. */
export function repoForCwd(cwd: string): string {
	return `acme/${cwd.split("/").pop() ?? "repo"}`;
}

function pr(
	number: number,
	title: string,
	repository: string,
	headRef: string,
	baseRef: string,
	author: string,
	additions: number,
	deletions: number,
	reviewDecision: string,
	statusCheckRollup: string,
	isDraft: boolean,
	labels: string[],
): PullRequest {
	return {
		number,
		title,
		url: `https://github.com/${repository}/pull/${number}`,
		author,
		createdAt: "2026-05-27T16:40:00Z",
		updatedAt: "2026-05-29T08:21:00Z",
		headRef,
		baseRef,
		additions,
		deletions,
		reviewDecision,
		statusCheckRollup,
		isDraft,
		labels,
		repository,
	};
}

export const allReviewPrs: PullRequest[] = [
	pr(
		482,
		"Add idempotency keys to the payments webhook",
		"acme/payments-api",
		"feature/webhook-idempotency",
		"develop",
		"dana-lee",
		213,
		41,
		"REVIEW_REQUIRED",
		"SUCCESS",
		false,
		["enhancement", "payments"],
	),
	pr(
		477,
		"Fix rounding error in multi-currency cart totals",
		"acme/acme-web",
		"fix/cart-rounding",
		"main",
		"sam-ortiz",
		54,
		22,
		"APPROVED",
		"PENDING",
		false,
		["bug"],
	),
	pr(
		150,
		"Mixed-precision training for the encoder",
		"acme/ml-pipeline",
		"experiment/mixed-precision",
		"main",
		"wei-zhang",
		188,
		33,
		"REVIEW_REQUIRED",
		"FAILURE",
		false,
		["ml", "perf"],
	),
	pr(
		88,
		"Elo-based matchmaking",
		"acme/game-server",
		"feature/matchmaking",
		"main",
		"demo",
		240,
		12,
		"REVIEW_REQUIRED",
		"SUCCESS",
		false,
		["enhancement"],
	),
	pr(
		36,
		"Extract billing into a service object",
		"acme/legacy-monolith",
		"refactor/extract-billing",
		"master",
		"priya-nair",
		411,
		146,
		"CHANGES_REQUESTED",
		"SUCCESS",
		false,
		["refactor", "tech-debt"],
	),
	pr(
		61,
		"Thread-based conversations",
		"acme/chat-app",
		"feature/threads",
		"main",
		"alex-kim",
		194,
		9,
		"REVIEW_REQUIRED",
		"PENDING",
		false,
		["enhancement"],
	),
	pr(
		29,
		"3-D Secure 2 challenge flow",
		"acme/payment-gateway",
		"feature/3ds2",
		"main",
		"demo",
		92,
		3,
		"REVIEW_REQUIRED",
		"SUCCESS",
		false,
		["payments", "security"],
	),
];

export const allMyPrs: PullRequest[] = [
	pr(
		491,
		"Refactor checkout total validation",
		"acme/acme-web",
		"feature/checkout-redesign",
		"main",
		"demo",
		91,
		12,
		"CHANGES_REQUESTED",
		"FAILURE",
		false,
		["enhancement"],
	),
	pr(
		488,
		"WIP: retry Stripe webhooks with backoff",
		"acme/payments-api",
		"feature/webhook-retries",
		"develop",
		"demo",
		34,
		6,
		"",
		"SUCCESS",
		true,
		["payments", "wip"],
	),
	pr(
		151,
		"Prefetch batches in the data loader",
		"acme/ml-pipeline",
		"feature/training-loop",
		"main",
		"demo",
		27,
		5,
		"APPROVED",
		"SUCCESS",
		false,
		["perf"],
	),
	pr(
		204,
		"Dark-mode color tokens",
		"acme/design-system",
		"feature/dark-mode",
		"main",
		"demo",
		62,
		4,
		"",
		"PENDING",
		true,
		["design"],
	),
	pr(
		73,
		"Incremental load for fact_orders",
		"acme/data-warehouse",
		"feature/incremental-load",
		"main",
		"demo",
		41,
		7,
		"REVIEW_REQUIRED",
		"SUCCESS",
		false,
		["data"],
	),
	pr(
		118,
		"OAuth PKCE support",
		"acme/auth-service",
		"feature/oauth-pkce",
		"main",
		"demo",
		78,
		6,
		"APPROVED",
		"SUCCESS",
		false,
		["security"],
	),
	pr(
		45,
		"MDX shortcodes",
		"acme/blog-engine",
		"feature/mdx-shortcodes",
		"main",
		"demo",
		76,
		7,
		"",
		"PENDING",
		true,
		["content"],
	),
];

export function reviewPrsForCwd(cwd: string): PullRequest[] {
	const repo = repoForCwd(cwd);
	return allReviewPrs.filter((p) => p.repository === repo);
}

export function myPrsForCwd(cwd: string): PullRequest[] {
	const repo = repoForCwd(cwd);
	return allMyPrs.filter((p) => p.repository === repo);
}

// ── File explorer ──

function dir(name: string, parent: string): DirEntry {
	return {
		name,
		path: `${parent}/${name}`,
		isDir: true,
		isSymlink: false,
		size: 0,
		extension: null,
	};
}

function file(name: string, parent: string, size: number): DirEntry {
	const ext = name.includes(".") ? (name.split(".").pop() ?? null) : null;
	return {
		name,
		path: `${parent}/${name}`,
		isDir: false,
		isSymlink: false,
		size,
		extension: ext,
	};
}

/** dirPath → entries. Explicit tree for acme-web; generated fallback elsewhere. */
const dirEntries: Record<string, DirEntry[]> = {
	[ACME_ROOT]: [
		dir("src", ACME_ROOT),
		dir("public", ACME_ROOT),
		file("package.json", ACME_ROOT, 1284),
		file("README.md", ACME_ROOT, 642),
		file("vite.config.ts", ACME_ROOT, 318),
	],
	[`${ACME_ROOT}/src`]: [
		dir("api", `${ACME_ROOT}/src`),
		dir("components", `${ACME_ROOT}/src`),
		dir("lib", `${ACME_ROOT}/src`),
		file("main.tsx", `${ACME_ROOT}/src`, 412),
	],
	[`${ACME_ROOT}/src/api`]: [
		dir("__tests__", `${ACME_ROOT}/src/api`),
		file("checkout.ts", `${ACME_ROOT}/src/api`, 3120),
		file("client.ts", `${ACME_ROOT}/src/api`, 1044),
	],
	[`${ACME_ROOT}/src/components`]: [
		file("Cart.tsx", `${ACME_ROOT}/src/components`, 2210),
		file("CartSummary.tsx", `${ACME_ROOT}/src/components`, 980),
		file("Checkout.tsx", `${ACME_ROOT}/src/components`, 2640),
	],
	[`${ACME_ROOT}/src/lib`]: [file("money.ts", `${ACME_ROOT}/src/lib`, 512)],
};

/** Explicit tree where defined, otherwise a small generated one so the
 *  explorer is never empty for any workspace the user opens. */
export function listDir(path: string): DirEntry[] {
	const explicit = dirEntries[path];
	if (explicit) return explicit;
	if (allRoots.includes(path)) {
		return [
			dir("src", path),
			file("README.md", path, 540),
			file("package.json", path, 820),
		];
	}
	if (path.endsWith("/src")) {
		return [file("index.ts", path, 640), file("utils.ts", path, 420)];
	}
	return [];
}

/** Flat file list for quick-open (relative to each workspace root). */
export function fileIndex(rootPath: string): string[] {
	if (rootPath === ACME_ROOT) {
		return [
			"package.json",
			"README.md",
			"vite.config.ts",
			"src/main.tsx",
			"src/api/checkout.ts",
			"src/api/client.ts",
			"src/api/__tests__/checkout.test.ts",
			"src/components/Cart.tsx",
			"src/components/CartSummary.tsx",
			"src/components/Checkout.tsx",
			"src/lib/money.ts",
		];
	}
	return ["README.md", "package.json", "src/index.ts", "src/utils.ts"];
}

export function fileEntries(rootPath: string): FileEntry[] {
	return fileIndex(rootPath).map((rel) => ({
		name: rel.split("/").pop() ?? rel,
		path: `${rootPath}/${rel}`,
		relativePath: rel,
	}));
}

/** Text file contents, keyed by absolute path (file panes + explorer). */
export const fileContents: Record<string, string> = {
	[`${ACME_ROOT}/src/api/checkout.ts`]:
		fileDiffs["src/api/checkout.ts"].modified,
	[`${ACME_ROOT}/src/components/Cart.tsx`]:
		fileDiffs["src/components/Cart.tsx"].modified,
	[`${ACME_ROOT}/README.md`]:
		"# acme-web\n\nStorefront for the Acme demo shop.\n",
	[`${ACME_ROOT}/src/lib/money.ts`]:
		"export function formatMoney(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n",
	[`${CODE}/ml-pipeline/src/train.py`]: [
		"import torch",
		"from src.data.loader import build_loader",
		"",
		"def train(model, epochs: int = 10):",
		"    loader = build_loader(batch_size=256, prefetch=4)",
		"    for epoch in range(epochs):",
		"        for batch in loader:",
		"            loss = model.step(batch)",
		"        print(f'epoch {epoch}: loss={loss:.3f}')",
		"",
	].join("\n"),
	[`${CODE}/docs-site/README.md`]: [
		"# docs-site",
		"",
		"Public documentation for the Acme platform.",
		"",
		"## Sections",
		"",
		"- Getting started",
		"- API reference",
		"- Webhooks",
		"",
	].join("\n"),
};

export function readFile(path: string): FileContent {
	const content = fileContents[path] ?? `// ${path}\n`;
	return {
		fileType: "text",
		content,
		mime: "text/plain",
		size: content.length,
	};
}

// ── System ──

export const systemFonts: string[] = [
	"JetBrains Mono",
	"Menlo",
	"Monaco",
	"SF Mono",
	"Fira Code",
];

export const availableShells: AvailableShell[] = [
	{ name: "zsh", path: "/bin/zsh", available: true, isDefault: true },
	{ name: "bash", path: "/bin/bash", available: true, isDefault: false },
];

export const devEnvironments: DetectedDevEnvironment[] = [
	{ id: "vscode", displayName: "VS Code", iconName: "vscode" },
	{ id: "cursor", displayName: "Cursor", iconName: "cursor" },
];

/** Agent CLIs reported as installed (intersected with the requested list). */
export const installedAgentCommands = new Set([
	"claude",
	"copilot",
	"gemini",
	"aider",
	"codex",
	"opencode",
	"qwen",
]);

/** Per-agent hook footprint shown in Settings → Agents (demo, no real files). */
export const agentHookStatuses: AgentHookStatus[] = [
	{
		agentId: "claude",
		configPath: "~/.claude/settings.json",
		ownership: "merged",
		events: [
			"UserPromptSubmit",
			"PermissionRequest",
			"Stop",
			"StopFailure",
			"SessionEnd",
		],
		state: "registered",
	},
	{
		agentId: "gemini",
		configPath: "~/.gemini/settings.json",
		ownership: "merged",
		events: ["BeforeAgent", "AfterAgent", "Notification", "SessionEnd"],
		state: "registered",
	},
	{
		agentId: "qwen",
		configPath: "~/.qwen/settings.json",
		ownership: "merged",
		events: ["BeforeAgent", "AfterAgent", "Notification", "SessionEnd"],
		state: "notRegistered",
	},
	{
		agentId: "codex",
		configPath: "~/.codex/hooks.json",
		ownership: "owned",
		events: ["UserPromptSubmit", "PermissionRequest", "Stop"],
		state: "registered",
	},
	{
		agentId: "copilot",
		configPath: "~/.copilot/hooks/abundio.json",
		ownership: "owned",
		events: [
			"userPromptSubmitted",
			"preToolUse",
			"notification",
			"agentStop",
			"errorOccurred",
			"sessionEnd",
		],
		state: "registered",
	},
	{
		agentId: "opencode",
		configPath: "~/.config/opencode/plugin/abundio.ts",
		ownership: "owned",
		events: ["all lifecycle events"],
		state: "registered",
	},
];
