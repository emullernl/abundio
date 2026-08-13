import { sendNotification } from "@tauri-apps/plugin-notification";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
}));

const focusMock = vi.hoisted(() => ({ blurredMs: 10_000 as number | null }));
vi.mock("../../lib/windowFocus", () => ({
	isAppWindowFocused: () => document.hasFocus(),
	getWindowBlurredMs: () => (document.hasFocus() ? null : focusMock.blurredMs),
	addWindowFocusListener: () => () => {},
	NOTIFICATION_BLUR_THRESHOLD_MS: 3000,
}));

import type { PrChange, PrStatePayload, PullRequest } from "../../lib/types";
import {
	handlePrChanges,
	PR_VIEW_LABELS,
	profilePrCounts,
	scopeOf,
	usePrStore,
	visiblePrs,
} from "../prStore";
import { useWorkspaceStore } from "../workspaceStore";

const mockSendNotification = vi.mocked(sendNotification);

const makePr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
	number: 1,
	title: "Test PR",
	url: "https://github.com/org/repo/pull/1",
	author: "alice",
	createdAt: "2026-03-28T10:00:00Z",
	updatedAt: "2026-03-28T10:00:00Z",
	headRef: "feature",
	baseRef: "main",
	additions: 10,
	deletions: 5,
	reviewDecision: "APPROVED",
	statusCheckRollup: "SUCCESS",
	isDraft: false,
	labels: [],
	repository: "org/repo",
	...overrides,
});

const makePayload = (
	overrides: Partial<PrStatePayload> = {},
): PrStatePayload => ({
	available: true,
	authenticated: true,
	reviewRequested: [],
	mine: [],
	error: null,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	usePrStore.setState({
		ghStatus: null,
		reviewRequested: [],
		mine: [],
		error: null,
		loading: true,
		refreshing: false,
		activeRepoSlug: null,
		profileRepoSlugs: new Set<string>(),
		repoSlugsResolved: false,
		reviewView: "review-all",
		myPrsView: "mine-all",
	});
	useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
});

describe("prStore", () => {
	describe("PR_VIEW_LABELS", () => {
		it("has labels for all views", () => {
			expect(PR_VIEW_LABELS["review-repo"]).toBe("Review Requested (Repo)");
			expect(PR_VIEW_LABELS["review-all"]).toBe("Review Requested (All)");
			expect(PR_VIEW_LABELS["review-profile"]).toBe(
				"Review Requested (Profile)",
			);
			expect(PR_VIEW_LABELS["mine-repo"]).toBe("My Open PRs (Repo)");
			expect(PR_VIEW_LABELS["mine-all"]).toBe("My Open PRs (All)");
			expect(PR_VIEW_LABELS["mine-profile"]).toBe("My Open PRs (Profile)");
		});
	});

	describe("scopeOf", () => {
		it("maps every view to its scope", () => {
			expect(scopeOf("review-all")).toBe("all");
			expect(scopeOf("review-repo")).toBe("repo");
			expect(scopeOf("review-profile")).toBe("profile");
			expect(scopeOf("mine-all")).toBe("all");
			expect(scopeOf("mine-repo")).toBe("repo");
			expect(scopeOf("mine-profile")).toBe("profile");
		});
	});

	describe("view + slug setters", () => {
		it("setReviewView updates the review view", () => {
			usePrStore.getState().setReviewView("review-repo");
			expect(usePrStore.getState().reviewView).toBe("review-repo");
		});

		it("setMyPrsView updates the my PRs view", () => {
			usePrStore.getState().setMyPrsView("mine-repo");
			expect(usePrStore.getState().myPrsView).toBe("mine-repo");
		});

		it("setActiveRepoSlug updates the slug", () => {
			usePrStore.getState().setActiveRepoSlug("org/x");
			expect(usePrStore.getState().activeRepoSlug).toBe("org/x");
		});

		it("setProfileRepoSlugs stores the set and its resolution", () => {
			usePrStore
				.getState()
				.setProfileRepoSlugs(new Set(["org/x", "org/y"]), true);
			const s = usePrStore.getState();
			expect([...s.profileRepoSlugs]).toEqual(["org/x", "org/y"]);
			expect(s.repoSlugsResolved).toBe(true);
		});

		it("an empty set can be resolved — a profile can genuinely have none", () => {
			usePrStore.getState().setProfileRepoSlugs(new Set(), true);
			expect(usePrStore.getState().repoSlugsResolved).toBe(true);
		});

		it("an empty set can also be unresolved — the summary hasn't answered yet", () => {
			usePrStore.getState().setProfileRepoSlugs(new Set(), false);
			expect(usePrStore.getState().repoSlugsResolved).toBe(false);
		});
	});

	describe("applyPrState", () => {
		it("sets status and raw lists and clears loading", () => {
			usePrStore.getState().applyPrState(
				makePayload({
					reviewRequested: [makePr({ number: 1 }), makePr({ number: 2 })],
					mine: [makePr({ number: 3 })],
				}),
			);
			const s = usePrStore.getState();
			expect(s.ghStatus).toEqual({ available: true, authenticated: true });
			expect(s.reviewRequested).toHaveLength(2);
			expect(s.mine).toHaveLength(1);
			expect(s.loading).toBe(false);
			expect(s.error).toBe(null);
		});

		it("clears an in-flight manual refresh when a payload lands", () => {
			usePrStore.getState().beginRefresh();
			expect(usePrStore.getState().refreshing).toBe(true);
			usePrStore.getState().applyPrState(makePayload());
			expect(usePrStore.getState().refreshing).toBe(false);
		});

		it("carries an error and the unauthenticated status", () => {
			usePrStore
				.getState()
				.applyPrState(
					makePayload({ available: true, authenticated: false, error: "boom" }),
				);
			const s = usePrStore.getState();
			expect(s.ghStatus).toEqual({ available: true, authenticated: false });
			expect(s.error).toBe("boom");
			expect(s.loading).toBe(false);
		});
	});

	describe("visiblePrs (scope filter)", () => {
		const prA = makePr({ number: 1, repository: "org/a" });
		const prB = makePr({ number: 2, repository: "org/b" });
		const none = new Set<string>();

		it("returns the full account-wide list in all scope", () => {
			expect(
				visiblePrs([prA, prB], "all", "org/a", new Set(["org/b"])),
			).toEqual([prA, prB]);
		});

		it("filters to the active repo slug in repo scope", () => {
			expect(visiblePrs([prA, prB], "repo", "org/a", none)).toEqual([prA]);
		});

		it("falls back to the full list in repo scope with no slug", () => {
			expect(visiblePrs([prA, prB], "repo", null, none)).toEqual([prA, prB]);
		});

		it("filters to the profile's repositories in profile scope", () => {
			expect(
				visiblePrs([prA, prB], "profile", null, new Set(["org/b"])),
			).toEqual([prB]);
		});

		it("keeps a PR matched through any of the profile's repos", () => {
			// A fork Workspace contributes both its origin and its upstream.
			expect(
				visiblePrs([prA, prB], "profile", null, new Set(["org/a", "org/b"])),
			).toEqual([prA, prB]);
		});

		it("returns nothing — not everything — when the profile has no repos", () => {
			// The empty set must NOT read as "no filter": that would silently
			// widen the view to account-wide. See ADR-0028.
			expect(visiblePrs([prA, prB], "profile", "org/a", none)).toEqual([]);
		});
	});

	describe("persist migration to v1", () => {
		const migrate = () => {
			const m = usePrStore.persist.getOptions().migrate;
			if (!m) throw new Error("expected a migrate function");
			return m;
		};

		it("resets a legacy stored preference to the Profile views", () => {
			expect(
				migrate()({ reviewView: "review-all", myPrsView: "mine-repo" }, 0),
			).toEqual({
				reviewView: "review-profile",
				myPrsView: "mine-profile",
			});
		});

		it("leaves an already-migrated preference alone", () => {
			expect(
				migrate()({ reviewView: "review-all", myPrsView: "mine-repo" }, 1),
			).toEqual({
				reviewView: "review-all",
				myPrsView: "mine-repo",
			});
		});
	});

	describe("profilePrCounts", () => {
		const prA = makePr({ number: 1, repository: "org/a" });
		const prB = makePr({ number: 2, repository: "org/b" });

		it("counts only the profile's repositories", () => {
			expect(
				profilePrCounts({
					reviewRequested: [prA, prB],
					mine: [prB],
					profileRepoSlugs: new Set(["org/a"]),
				}),
			).toEqual({ review: 1, mine: 0 });
		});

		it("tracks a slug-set change with no new payload", () => {
			// The drift case the derived counts exist to prevent: the workspace
			// list changed, the poller has not pushed since.
			usePrStore
				.getState()
				.applyPrState(
					makePayload({ reviewRequested: [prA, prB], mine: [prA] }),
				);
			usePrStore.getState().setProfileRepoSlugs(new Set(["org/a"]), true);
			expect(profilePrCounts(usePrStore.getState())).toEqual({
				review: 1,
				mine: 1,
			});

			usePrStore
				.getState()
				.setProfileRepoSlugs(new Set(["org/a", "org/b"]), true);
			expect(profilePrCounts(usePrStore.getState())).toEqual({
				review: 2,
				mine: 1,
			});
		});
	});

	// The diff that produces these descriptors now lives in Rust (pr_poller).
	// The frontend's job is only to render them as OS notifications, gated on
	// the window-blur threshold.
	describe("handlePrChanges", () => {
		const change = (body: string): PrChange => ({ kind: "review", body });

		beforeEach(() => {
			vi.spyOn(document, "hasFocus").mockReturnValue(false);
			focusMock.blurredMs = 10_000;
		});

		it("notifies with the preformatted body, title and routing payload", () => {
			handlePrChanges([change("Review requested: New PR (#2)")]);
			expect(mockSendNotification).toHaveBeenCalledWith({
				title: "Abundio",
				body: "Review requested: New PR (#2)",
				extra: { type: "pr", workspaceId: "ws-1" },
			});
		});

		it("fires one notification per change", () => {
			handlePrChanges([change("a"), change("b"), change("c")]);
			expect(mockSendNotification).toHaveBeenCalledTimes(3);
		});

		it("does not notify when the app is focused", () => {
			vi.spyOn(document, "hasFocus").mockReturnValue(true);
			handlePrChanges([change("x")]);
			expect(mockSendNotification).not.toHaveBeenCalled();
		});

		it("does not notify when blurred for less than the threshold", () => {
			focusMock.blurredMs = 1500;
			handlePrChanges([change("x")]);
			expect(mockSendNotification).not.toHaveBeenCalled();
		});

		it("does nothing for an empty change list", () => {
			handlePrChanges([]);
			expect(mockSendNotification).not.toHaveBeenCalled();
		});
	});
});
