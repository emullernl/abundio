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
	selectVisibleMyPrs,
	selectVisibleReviewPrs,
	usePrStore,
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
		activeRepoSlug: null,
		reviewView: "review-all",
		myPrsView: "mine-all",
		globalReviewCount: 0,
		globalMyPrsCount: 0,
	});
	useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
});

describe("prStore", () => {
	describe("PR_VIEW_LABELS", () => {
		it("has labels for all views", () => {
			expect(PR_VIEW_LABELS["review-repo"]).toBe("Review Requested (Repo)");
			expect(PR_VIEW_LABELS["review-all"]).toBe("Review Requested (All)");
			expect(PR_VIEW_LABELS["mine-repo"]).toBe("My Open PRs (Repo)");
			expect(PR_VIEW_LABELS["mine-all"]).toBe("My Open PRs (All)");
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
	});

	describe("applyPrState", () => {
		it("sets status, raw lists, account-wide counts and clears loading", () => {
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
			// Overview-bar counts are always the full account-wide lengths.
			expect(s.globalReviewCount).toBe(2);
			expect(s.globalMyPrsCount).toBe(1);
			expect(s.loading).toBe(false);
			expect(s.error).toBe(null);
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

	describe("client-side All-vs-Repo filtering", () => {
		const prA = makePr({ number: 1, repository: "org/a" });
		const prB = makePr({ number: 2, repository: "org/b" });

		it("review-all returns the full account-wide list", () => {
			usePrStore.setState({
				reviewRequested: [prA, prB],
				reviewView: "review-all",
				activeRepoSlug: "org/a",
			});
			expect(selectVisibleReviewPrs(usePrStore.getState())).toEqual([prA, prB]);
		});

		it("review-repo filters to the active repo slug", () => {
			usePrStore.setState({
				reviewRequested: [prA, prB],
				reviewView: "review-repo",
				activeRepoSlug: "org/a",
			});
			expect(selectVisibleReviewPrs(usePrStore.getState())).toEqual([prA]);
		});

		it("review-repo with no active slug falls back to the full list", () => {
			usePrStore.setState({
				reviewRequested: [prA, prB],
				reviewView: "review-repo",
				activeRepoSlug: null,
			});
			expect(selectVisibleReviewPrs(usePrStore.getState())).toEqual([prA, prB]);
		});

		it("mine-repo filters to the active repo slug", () => {
			usePrStore.setState({
				mine: [prA, prB],
				myPrsView: "mine-repo",
				activeRepoSlug: "org/b",
			});
			expect(selectVisibleMyPrs(usePrStore.getState())).toEqual([prB]);
		});

		it("mine-all returns the full list regardless of slug", () => {
			usePrStore.setState({
				mine: [prA, prB],
				myPrsView: "mine-all",
				activeRepoSlug: "org/b",
			});
			expect(selectVisibleMyPrs(usePrStore.getState())).toEqual([prA, prB]);
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
