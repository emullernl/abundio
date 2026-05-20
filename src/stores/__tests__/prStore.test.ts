import { sendNotification } from "@tauri-apps/plugin-notification";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
}));

const focusMock = vi.hoisted(() => ({ blurredMs: 10_000 as number | null }));
vi.mock("../../lib/windowFocus", () => ({
	isAppWindowFocused: () => document.hasFocus(),
	getWindowBlurredMs: () => (document.hasFocus() ? null : focusMock.blurredMs),
	NOTIFICATION_BLUR_THRESHOLD_MS: 3000,
}));

vi.mock("../../lib/ipc", () => ({
	gh: {
		status: vi.fn(),
		reviewRequests: vi.fn(),
		reviewRequestsAll: vi.fn(),
		myPrs: vi.fn(),
		myPrsAll: vi.fn(),
	},
}));

import { gh } from "../../lib/ipc";
import type { GhStatus, PullRequest } from "../../lib/types";
import {
	PR_VIEW_LABELS,
	resetPrNotificationState,
	usePrStore,
} from "../prStore";
import { useWorkspaceStore } from "../workspaceStore";

const mockSendNotification = vi.mocked(sendNotification);

const mockGh = vi.mocked(gh);

const makeGhStatus = (overrides: Partial<GhStatus> = {}): GhStatus => ({
	available: true,
	authenticated: true,
	hasRemote: true,
	...overrides,
});

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
	repository: "",
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	resetPrNotificationState();
	usePrStore.setState({
		ghStatus: null,
		reviewView: "review-all",
		review: { prs: [], loading: false, error: null },
		myPrsView: "mine-all",
		myPrs: { prs: [], loading: false, error: null },
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

	describe("setReviewView", () => {
		it("updates the review view", () => {
			usePrStore.getState().setReviewView("review-repo");
			expect(usePrStore.getState().reviewView).toBe("review-repo");
		});
	});

	describe("setMyPrsView", () => {
		it("updates the my PRs view", () => {
			usePrStore.getState().setMyPrsView("mine-repo");
			expect(usePrStore.getState().myPrsView).toBe("mine-repo");
		});
	});

	describe("checkGhStatus", () => {
		it("sets ghStatus on success", async () => {
			const status = makeGhStatus();
			mockGh.status.mockResolvedValue(status);

			await usePrStore.getState().checkGhStatus("/test");

			expect(usePrStore.getState().ghStatus).toEqual(status);
			expect(mockGh.status).toHaveBeenCalledWith("/test");
		});

		it("sets unavailable on error", async () => {
			mockGh.status.mockRejectedValue(new Error("failed"));

			await usePrStore.getState().checkGhStatus("/test");

			expect(usePrStore.getState().ghStatus).toEqual({
				available: false,
				authenticated: false,
				hasRemote: false,
			});
		});
	});

	describe("fetchReviewPrs", () => {
		it("fetches review requests for review-repo view", async () => {
			const prs = [makePr({ number: 42 })];
			mockGh.reviewRequests.mockResolvedValue(prs);

			usePrStore.setState({ reviewView: "review-repo" });
			await usePrStore.getState().fetchReviewPrs("/test");

			expect(mockGh.reviewRequests).toHaveBeenCalledWith("/test");
			expect(usePrStore.getState().review.prs).toEqual(prs);
			expect(usePrStore.getState().review.loading).toBe(false);
		});

		it("fetches all review requests for review-all view", async () => {
			const prs = [makePr({ number: 87, repository: "org/lib" })];
			mockGh.reviewRequestsAll.mockResolvedValue(prs);

			usePrStore.setState({ reviewView: "review-all" });
			await usePrStore.getState().fetchReviewPrs("/test");

			expect(mockGh.reviewRequestsAll).toHaveBeenCalledWith("/test");
			expect(usePrStore.getState().review.prs).toEqual(prs);
		});

		it("sets error on failure", async () => {
			mockGh.reviewRequestsAll.mockRejectedValue(new Error("rate limited"));

			await usePrStore.getState().fetchReviewPrs("/test");

			expect(usePrStore.getState().review.error).toBe("rate limited");
			expect(usePrStore.getState().review.prs).toEqual([]);
			expect(usePrStore.getState().review.loading).toBe(false);
		});

		it("sets loading while fetching", async () => {
			let resolvePromise: (value: PullRequest[]) => void;
			const pending = new Promise<PullRequest[]>((resolve) => {
				resolvePromise = resolve;
			});
			mockGh.reviewRequestsAll.mockReturnValue(pending);

			const fetchPromise = usePrStore.getState().fetchReviewPrs("/test");
			expect(usePrStore.getState().review.loading).toBe(true);

			// biome-ignore lint/style/noNonNullAssertion: assigned in Promise callback above
			resolvePromise!([]);
			await fetchPromise;
			expect(usePrStore.getState().review.loading).toBe(false);
		});
	});

	describe("fetchMyPrs", () => {
		it("fetches my PRs for mine-repo view", async () => {
			const prs = [makePr({ number: 10 })];
			mockGh.myPrs.mockResolvedValue(prs);

			usePrStore.setState({ myPrsView: "mine-repo" });
			await usePrStore.getState().fetchMyPrs("/test");

			expect(mockGh.myPrs).toHaveBeenCalledWith("/test");
			expect(usePrStore.getState().myPrs.prs).toEqual(prs);
			expect(usePrStore.getState().myPrs.loading).toBe(false);
		});

		it("fetches all my PRs for mine-all view", async () => {
			const prs = [makePr({ number: 20, repository: "org/other" })];
			mockGh.myPrsAll.mockResolvedValue(prs);

			usePrStore.setState({ myPrsView: "mine-all" });
			await usePrStore.getState().fetchMyPrs("/test");

			expect(mockGh.myPrsAll).toHaveBeenCalledWith("/test");
			expect(usePrStore.getState().myPrs.prs).toEqual(prs);
		});

		it("sets error on failure", async () => {
			mockGh.myPrsAll.mockRejectedValue(new Error("network error"));

			await usePrStore.getState().fetchMyPrs("/test");

			expect(usePrStore.getState().myPrs.error).toBe("network error");
			expect(usePrStore.getState().myPrs.prs).toEqual([]);
			expect(usePrStore.getState().myPrs.loading).toBe(false);
		});

		it("sets loading while fetching", async () => {
			let resolvePromise: (value: PullRequest[]) => void;
			const pending = new Promise<PullRequest[]>((resolve) => {
				resolvePromise = resolve;
			});
			mockGh.myPrsAll.mockReturnValue(pending);

			const fetchPromise = usePrStore.getState().fetchMyPrs("/test");
			expect(usePrStore.getState().myPrs.loading).toBe(true);

			// biome-ignore lint/style/noNonNullAssertion: assigned in Promise callback above
			resolvePromise!([]);
			await fetchPromise;
			expect(usePrStore.getState().myPrs.loading).toBe(false);
		});
	});

	describe("clear", () => {
		it("resets both sections", () => {
			usePrStore.setState({
				review: { prs: [makePr()], loading: true, error: "oops" },
				myPrs: { prs: [makePr({ number: 2 })], loading: true, error: "fail" },
			});
			usePrStore.getState().clear();

			expect(usePrStore.getState().review).toEqual({
				prs: [],
				loading: false,
				error: null,
			});
			expect(usePrStore.getState().myPrs).toEqual({
				prs: [],
				loading: false,
				error: null,
			});
		});
	});

	describe("hydrateFromWorkspace", () => {
		it("restores cached PRs after a prior fetch for that workspace", async () => {
			const aPrs = [makePr({ number: 11 })];
			mockGh.reviewRequestsAll.mockResolvedValue(aPrs);

			useWorkspaceStore.setState({ activeWorkspaceId: "ws-A" });
			await usePrStore.getState().fetchReviewPrs("/repo-a");

			// Simulate switching to another workspace and that workspace fetching
			useWorkspaceStore.setState({ activeWorkspaceId: "ws-B" });
			const bPrs = [makePr({ number: 22 })];
			mockGh.reviewRequestsAll.mockResolvedValue(bPrs);
			await usePrStore.getState().fetchReviewPrs("/repo-b");
			expect(usePrStore.getState().review.prs).toEqual(bPrs);

			// Switch back: hydrate from ws-A's cache should restore aPrs
			useWorkspaceStore.setState({ activeWorkspaceId: "ws-A" });
			usePrStore.getState().hydrateFromWorkspace("ws-A");
			expect(usePrStore.getState().review.prs).toEqual(aPrs);
		});

		it("shows empty sections for a workspace with no cached data", () => {
			usePrStore.setState({
				review: { prs: [makePr()], loading: false, error: null },
				myPrs: { prs: [makePr({ number: 9 })], loading: false, error: null },
			});

			usePrStore.getState().hydrateFromWorkspace("never-fetched");
			expect(usePrStore.getState().review).toEqual({
				prs: [],
				loading: false,
				error: null,
			});
			expect(usePrStore.getState().myPrs).toEqual({
				prs: [],
				loading: false,
				error: null,
			});
		});

		it("clears the singleton when called with null", () => {
			usePrStore.setState({
				review: { prs: [makePr()], loading: false, error: null },
			});
			usePrStore.getState().hydrateFromWorkspace(null);
			expect(usePrStore.getState().review.prs).toEqual([]);
		});

		it("writes cache against the workspaceId captured at fetch start, not the current one", async () => {
			let resolveA: (prs: PullRequest[]) => void = () => {};
			mockGh.reviewRequestsAll.mockReturnValueOnce(
				new Promise<PullRequest[]>((res) => {
					resolveA = res;
				}),
			);

			useWorkspaceStore.setState({ activeWorkspaceId: "ws-A" });
			const aFetch = usePrStore.getState().fetchReviewPrs("/repo-a");

			// User switches before the in-flight fetch completes
			useWorkspaceStore.setState({ activeWorkspaceId: "ws-B" });

			const aPrs = [makePr({ number: 99 })];
			resolveA(aPrs);
			await aFetch;

			// A's late response must NOT be written into the singleton while B is
			// the active workspace — that would contaminate B's panel.
			expect(usePrStore.getState().review.prs).not.toEqual(aPrs);

			// Hydrating ws-A should still recover aPrs even though it was no longer
			// active when the response arrived.
			usePrStore.getState().hydrateFromWorkspace("ws-A");
			expect(usePrStore.getState().review.prs).toEqual(aPrs);
		});
	});

	describe("PR notifications", () => {
		// Helper to simulate a loading -> loaded transition
		function simulateReviewLoad(prs: PullRequest[]) {
			usePrStore.setState((s) => ({
				review: { ...s.review, loading: true },
			}));
			usePrStore.setState({
				review: { prs, loading: false, error: null },
			});
		}

		function simulateMyPrsLoad(prs: PullRequest[]) {
			usePrStore.setState((s) => ({
				myPrs: { ...s.myPrs, loading: true },
			}));
			usePrStore.setState({
				myPrs: { prs, loading: false, error: null },
			});
		}

		beforeEach(() => {
			vi.spyOn(document, "hasFocus").mockReturnValue(false);
		});

		it("does not notify on first load", () => {
			simulateReviewLoad([makePr({ number: 1 })]);
			simulateMyPrsLoad([makePr({ number: 2 })]);

			expect(mockSendNotification).not.toHaveBeenCalled();
		});

		it("notifies on new review-requested PR", () => {
			simulateReviewLoad([makePr({ number: 1, title: "First PR" })]);

			simulateReviewLoad([
				makePr({ number: 1, title: "First PR" }),
				makePr({ number: 2, title: "New PR" }),
			]);

			expect(mockSendNotification).toHaveBeenCalledWith({
				title: "Abundio",
				body: "Review requested: New PR (#2)",
				extra: { type: "pr", workspaceId: "ws-1" },
			});
		});

		it("notifies when reviewDecision changes on my PR", () => {
			simulateMyPrsLoad([
				makePr({ number: 10, title: "My PR", reviewDecision: "" }),
			]);

			simulateMyPrsLoad([
				makePr({ number: 10, title: "My PR", reviewDecision: "APPROVED" }),
			]);

			expect(mockSendNotification).toHaveBeenCalledWith({
				title: "Abundio",
				body: "#10 My PR — approved",
				extra: { type: "pr", workspaceId: "ws-1" },
			});
		});

		it("notifies when reviewDecision changes to CHANGES_REQUESTED", () => {
			simulateMyPrsLoad([
				makePr({ number: 10, title: "My PR", reviewDecision: "" }),
			]);

			simulateMyPrsLoad([
				makePr({
					number: 10,
					title: "My PR",
					reviewDecision: "CHANGES_REQUESTED",
				}),
			]);

			expect(mockSendNotification).toHaveBeenCalledWith({
				title: "Abundio",
				body: "#10 My PR — has changes requested",
				extra: { type: "pr", workspaceId: "ws-1" },
			});
		});

		it("notifies when CI status changes on my PR", () => {
			simulateMyPrsLoad([
				makePr({
					number: 5,
					title: "CI PR",
					statusCheckRollup: "PENDING",
				}),
			]);

			simulateMyPrsLoad([
				makePr({
					number: 5,
					title: "CI PR",
					statusCheckRollup: "SUCCESS",
				}),
			]);

			expect(mockSendNotification).toHaveBeenCalledWith({
				title: "Abundio",
				body: "#5 CI PR — CI passed",
				extra: { type: "pr", workspaceId: "ws-1" },
			});
		});

		it("notifies CI failed", () => {
			simulateMyPrsLoad([
				makePr({
					number: 5,
					title: "CI PR",
					statusCheckRollup: "PENDING",
				}),
			]);

			simulateMyPrsLoad([
				makePr({
					number: 5,
					title: "CI PR",
					statusCheckRollup: "FAILURE",
				}),
			]);

			expect(mockSendNotification).toHaveBeenCalledWith({
				title: "Abundio",
				body: "#5 CI PR — CI failed",
				extra: { type: "pr", workspaceId: "ws-1" },
			});
		});

		it("does not notify for new PRs appearing in my PRs list", () => {
			simulateMyPrsLoad([makePr({ number: 10, title: "Existing" })]);

			simulateMyPrsLoad([
				makePr({ number: 10, title: "Existing" }),
				makePr({ number: 11, title: "Brand New" }),
			]);

			expect(mockSendNotification).not.toHaveBeenCalled();
		});

		it("does not notify when app is focused", () => {
			vi.spyOn(document, "hasFocus").mockReturnValue(true);

			simulateReviewLoad([makePr({ number: 1 })]);
			simulateReviewLoad([
				makePr({ number: 1 }),
				makePr({ number: 2, title: "New" }),
			]);

			expect(mockSendNotification).not.toHaveBeenCalled();
		});

		it("does not notify when blurred for less than the threshold", () => {
			focusMock.blurredMs = 1500;

			simulateReviewLoad([makePr({ number: 1 })]);
			simulateReviewLoad([
				makePr({ number: 1 }),
				makePr({ number: 2, title: "New" }),
			]);

			expect(mockSendNotification).not.toHaveBeenCalled();
			focusMock.blurredMs = 10_000;
		});

		it("notifies when blurred for more than the threshold", () => {
			focusMock.blurredMs = 4000;

			simulateReviewLoad([makePr({ number: 1 })]);
			simulateReviewLoad([
				makePr({ number: 1 }),
				makePr({ number: 2, title: "New" }),
			]);

			expect(mockSendNotification).toHaveBeenCalledWith(
				expect.objectContaining({ body: "Review requested: New (#2)" }),
			);
			focusMock.blurredMs = 10_000;
		});

		it("does not notify when review view changes", () => {
			simulateReviewLoad([makePr({ number: 1 })]);

			// Change view, then fetch (separate setState calls, like the real code)
			usePrStore.setState({ reviewView: "review-repo" as const });
			usePrStore.setState((s) => ({
				review: { ...s.review, loading: true },
			}));
			usePrStore.setState({
				review: {
					prs: [makePr({ number: 99, title: "Repo Only" })],
					loading: false,
					error: null,
				},
			});

			expect(mockSendNotification).not.toHaveBeenCalled();
		});

		it("resets notification state on clear so next load does not notify", () => {
			simulateReviewLoad([makePr({ number: 1 })]);
			simulateMyPrsLoad([makePr({ number: 2 })]);

			// Clear (workspace switch)
			usePrStore.getState().clear();

			// Next load should be treated as first load — no notification
			simulateReviewLoad([makePr({ number: 99, title: "After Clear" })]);

			expect(mockSendNotification).not.toHaveBeenCalled();
		});
	});
});
