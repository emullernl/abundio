# Unread PR markers

Show which PRs in the **Pull Requests** section have activity the user hasn't read yet. See **Unread PR** in `CONTEXT.md`.

## Decisions

1. **GitHub owns "read".** A PR is unread when its GitHub notification thread is unread. Abundio keeps no "last seen" state, so reading a PR on github.com, in the GitHub inbox or on another device clears it here too.
2. **Any unread activity counts** — pushes, merges and review requests as well as comments and reviews. Narrowing to comments/reviews would need extra GraphQL fields plus a `last_read_at` comparison, and would sometimes disagree with the GitHub inbox.
3. **Where it shows:** an accent dot and a bold title on the row, and `N · M unread` in each sub-section header. Row order is unchanged (no jumping rows), and the Overview bar chips are unchanged.
4. **Opening a PR from Abundio marks it read.** The marker clears at once in every Window, and Abundio sends `PATCH /notifications/threads/{id}` rather than relying on GitHub's mark-on-view.
5. **No OS notifications** for unread activity: it would fire on every push. The existing review / CI notifications cover the important cases.
6. **Failure is visible but quiet.** If the notifications call fails (for example a fine-grained `GH_TOKEN`, which cannot read notifications), the PR lists still show, and a muted "Unread markers unavailable" line with the reason in a tooltip keeps "no markers" from passing for "all read".

## Implementation

- `gh_commands.rs` — `fetch_unread_pr_threads()` runs `gh api notifications --paginate` with a `--jq` filter that prints one JSON object per unread PR thread. `apply_unread()` stamps `unread_thread_id` onto PRs, matched on lowercased `owner/repo` + number. `mark_thread_read()` sends the PATCH and refuses non-numeric ids (the id goes into a URL path).
- `pr_poller.rs` — after the GraphQL fetch, the poll also fetches unread threads; a failure fills `unread_error` and never fails the lists. `pr_mark_read` clears the id in both cached payloads, rebroadcasts `pr-state` (so every Window clears), then PATCHes.
- Frontend — `PullRequest.unreadThreadId`, `PrStatePayload.unreadError`, `prStore.markRead` (optimistic clear) and `unreadCount`. `PullRequestItem` draws the dot and bold title and calls `markRead` from its open button. `PullRequestsSection` shows the header count and the note.

## Known limitation

A poll that is already in flight when the user opens a PR can bring the marker back until the next poll. This is rare and fixes itself, so it is not guarded against.
