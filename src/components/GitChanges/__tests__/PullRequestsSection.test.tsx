import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
// `handleRefresh` also re-runs the batch workspace summary (the recovery path
// for a `git remote add` made in a terminal), and workspaceGitStore reaches for
// `workspacesApi` — both must be stubbed or the Refresh test fails on the mock
// rather than on the behaviour.
vi.mock("../../../lib/ipc", () => ({
	pr: {
		refresh: vi.fn().mockResolvedValue(undefined),
		markRead: vi.fn().mockResolvedValue(undefined),
	},
	git: { workspacesSummary: vi.fn().mockResolvedValue([]) },
	workspaces: { update: vi.fn().mockResolvedValue(undefined) },
}));

import { open } from "@tauri-apps/plugin-shell";
import { git, pr as prIpc } from "../../../lib/ipc";
import type { PullRequest } from "../../../lib/types";
import { usePrStore } from "../../../stores/prStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { PullRequestsSection } from "../PullRequestsSection";

const makePr = (number: number, repository: string): PullRequest => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/${repository}/pull/${number}`,
	author: "alice",
	createdAt: "2026-08-01T10:00:00Z",
	updatedAt: "2026-08-01T10:00:00Z",
	headRef: "feature",
	baseRef: "main",
	additions: 1,
	deletions: 0,
	reviewDecision: "",
	statusCheckRollup: "",
	isDraft: false,
	labels: [],
	repository,
	unreadThreadId: null,
});

/** The account-wide dataset the poller pushes: two profiles' worth of repos. */
const REVIEW = [makePr(1, "acme/web"), makePr(2, "other/thing")];
const MINE = [makePr(3, "acme/web"), makePr(4, "other/thing")];

function seed(overrides: Partial<ReturnType<typeof usePrStore.getState>> = {}) {
	usePrStore.setState({
		ghStatus: { available: true, authenticated: true },
		reviewRequested: REVIEW,
		mine: MINE,
		loading: false,
		error: null,
		refreshing: false,
		activeRepoSlug: "acme/web",
		profileRepoSlugs: new Set(["acme/web"]),
		repoSlugsResolved: true,
		reviewView: "review-profile",
		myPrsView: "mine-profile",
		...overrides,
	});
}

describe("PullRequestsSection", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ prPollEnabled: true });
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["ws-1"]) });
		useWorkspaceGitStore.setState({ repoSlugsById: { "ws-1": ["acme/web"] } });
		useWorkspaceStore.setState({
			workspaces: [
				{ id: "ws-1", rootFolder: "/web", baseBranch: null },
				// biome-ignore lint/suspicious/noExplicitAny: partial workspace fixture
			] as any,
		});
		seed();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () => {
		act(() => root.render(<PullRequestsSection />));
	};
	const text = () => container.textContent ?? "";

	it("defaults to the Profile scope and shows only the profile's repos", () => {
		render();
		expect(text()).toContain("Review Requested (Profile)");
		expect(text()).toContain("My Open PRs (Profile)");
		// acme/web is in the profile; other/thing is not.
		expect(text()).toContain("PR 1");
		expect(text()).toContain("PR 3");
		expect(text()).not.toContain("PR 2");
		expect(text()).not.toContain("PR 4");
	});

	it("shows everything in the All scope", () => {
		seed({ reviewView: "review-all", myPrsView: "mine-all" });
		render();
		expect(text()).toContain("PR 2");
		expect(text()).toContain("PR 4");
	});

	it("says so — rather than widening — when the profile has no repositories", () => {
		seed({ profileRepoSlugs: new Set(), repoSlugsResolved: true });
		render();
		expect(text()).toContain("No GitHub repositories in this profile");
		expect(text()).not.toContain("PR 1");
		expect(text()).not.toContain("PR 2");
	});

	it("waits rather than claiming the profile is empty while resolving", () => {
		seed({ profileRepoSlugs: new Set(), repoSlugsResolved: false });
		render();
		expect(text()).toContain("Loading repositories");
		expect(text()).not.toContain("No GitHub repositories in this profile");
	});

	it("Refresh re-polls PRs and re-scans the workspaces' remotes", async () => {
		render();
		const refresh = Array.from(container.querySelectorAll("button")).find(
			(b) => b.getAttribute("title") === "Refresh",
		);
		await act(async () => {
			refresh?.click();
		});
		expect(prIpc.refresh).toHaveBeenCalled();
		// The recovery path for a `git remote add` made in a terminal: without
		// this, a new remote stays invisible to the Profile scope until relaunch.
		expect(git.workspacesSummary).toHaveBeenCalledWith([
			{ workspaceId: "ws-1", cwd: "/web", baseBranch: null },
		]);
	});

	describe("Unread PRs", () => {
		const unreadReview = [
			{ ...makePr(1, "acme/web"), unreadThreadId: "901" },
			makePr(5, "acme/web"),
		];

		it("counts unread PRs in the header and marks the row", () => {
			seed({ reviewRequested: unreadReview });
			render();
			expect(text()).toContain("2 · 1 unread");
			expect(container.querySelectorAll('[aria-label="Unread"]').length).toBe(
				1,
			);
		});

		it("shows no unread count when everything is read", () => {
			render();
			expect(text()).not.toContain("unread");
		});

		it("opening an unread PR clears its marker and marks it read", () => {
			seed({ reviewRequested: unreadReview });
			render();
			const openBtn = container.querySelector(
				'button[title="Open in browser"]',
			) as HTMLButtonElement;
			act(() => openBtn.click());
			expect(open).toHaveBeenCalledWith("https://github.com/acme/web/pull/1");
			expect(prIpc.markRead).toHaveBeenCalledWith("901");
			expect(container.querySelector('[aria-label="Unread"]')).toBeNull();
			expect(text()).not.toContain("unread");
		});

		it("opening a read PR does not call markRead", () => {
			render();
			const openBtn = container.querySelector(
				'button[title="Open in browser"]',
			) as HTMLButtonElement;
			act(() => openBtn.click());
			expect(prIpc.markRead).not.toHaveBeenCalled();
		});

		it("shows a quiet note when the markers could not be fetched", () => {
			seed({ unreadError: "HTTP 403" });
			render();
			expect(text()).toContain("Unread markers unavailable");
			// The lists themselves are unaffected.
			expect(text()).toContain("PR 1");
		});

		it("shows no note when the markers loaded", () => {
			seed({ unreadError: null });
			render();
			expect(text()).not.toContain("Unread markers unavailable");
		});
	});

	it("offers all three scopes when a workspace is opened", () => {
		render();
		const button = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Review Requested"),
		);
		act(() => button?.click());
		const labels = Array.from(container.querySelectorAll("button")).map(
			(b) => b.textContent ?? "",
		);
		expect(labels).toContain("Review Requested (Profile)");
		expect(labels).toContain("Review Requested (All)");
		expect(labels).toContain("Review Requested (Repo)");
	});

	describe("with no Opened workspaces", () => {
		beforeEach(() => {
			usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
		});

		it("degrades a stored Repo preference to Profile, not All", () => {
			seed({ reviewView: "review-repo", myPrsView: "mine-repo" });
			render();
			expect(text()).toContain("Review Requested (Profile)");
			// Still filtered — degrading must not dump the account-wide list.
			expect(text()).not.toContain("PR 2");
			// The stored preference itself is untouched.
			expect(usePrStore.getState().reviewView).toBe("review-repo");
		});

		it("drops Repo from the dropdown but keeps it interactive", () => {
			render();
			const button = Array.from(container.querySelectorAll("button")).find(
				(b) => b.textContent?.includes("Review Requested"),
			);
			expect(button?.hasAttribute("disabled")).toBe(false);
			act(() => button?.click());
			const labels = Array.from(container.querySelectorAll("button")).map(
				(b) => b.textContent ?? "",
			);
			expect(labels).toContain("Review Requested (Profile)");
			expect(labels).toContain("Review Requested (All)");
			expect(labels).not.toContain("Review Requested (Repo)");
		});
	});
});
