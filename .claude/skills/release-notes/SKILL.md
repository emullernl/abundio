---
name: release-notes
description: Write the GitHub release notes for the Abundio version that was just tagged, put them on the GitHub release once CI has made it, then ask the user whether to publish it. Use when the user says "/release-notes", "write the release notes", "release notes for the new version", or has just run `pnpm run release` and pushed the tag.
---

# Release notes for the latest tag

The release flow is: `pnpm run release X.Y.Z` makes the commit and the `vX.Y.Z` tag, `git push --follow-tags` starts `.github/workflows/build.yml`, and that workflow creates a **draft** GitHub release named "Abundio vX.Y.Z" and uploads the builds to it. This skill writes the notes, puts them on that draft, and publishes only when the user says yes.

Run every step in order. Do not skip the final question.

## 1. Find the tags

```bash
git fetch --tags --quiet
TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)
PREV=$(git tag --list 'v*' --sort=-v:refname | sed -n 2p)
```

Tell the user in one line which range you are covering (`$PREV..$TAG`). If `$TAG` is not on the remote yet (`git ls-remote --tags origin "$TAG"` prints nothing), stop and tell them to run `git push --follow-tags` first.

## 2. Gather the changes

```bash
git log --no-merges --format='%h %s' "$PREV..$TAG"
```

For each PR number in the subjects (`(#123)`), read its title and body for the user-facing story:

```bash
gh pr view 123 --json title,body,labels
```

Leave out purely internal commits: the `release:` commit itself, `build:` / `ci:` / `chore:` chores, refactors, tests, docs and generated files. Only changes a user can notice go in.

## 3. Write the notes in the house style

- Sections: `## ✨ New Features & Improvements` and `## 🐛 Bug Fixes`. For a big release you may split into `## ✨ New Features`, `## ✨ Improvements`, `## 🐛 Bug Fixes`, with platform sub-headings (`### macOS`, `### Windows`, `### Linux`) when that helps. Drop an empty section.
- Each item: a **bold lead sentence** with the user-facing change, then 1–3 plain sentences, ending with the PR numbers in parentheses: `(#133)` or `(#137, #139)`. Combine closely related PRs into one item.
- Tone: light and a little witty, one small twist per item (a dry aside, a small personification), but never at the cost of saying clearly what changed. Not too funny.
- Plain English, short sentences, no deep implementation detail.

To match the voice, read the last two releases first:

```bash
gh release view "$PREV" --json body --jq .body
```

Write the notes to the session scratchpad (never a shared `$TMPDIR/<common-name>` path), e.g. `<scratchpad>/release-notes-$TAG.md`. Show the draft to the user and take any changes they ask for before going on.

## 4. Wait for the release to exist

The draft release appears when the `build` job of `build.yml` finishes, which takes a while. Check:

```bash
gh release view "$TAG" --json isDraft,name,assets --jq '{isDraft, name, assets: [.assets[].name]}'
```

If it does not exist yet, find the run and wait for it instead of polling by hand:

```bash
RUN=$(gh run list --workflow build.yml --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --exit-status
```

Run `gh run watch` in the background (`run_in_background: true`) and continue when it exits. If the run fails, stop and report the failed jobs (`gh run view "$RUN" --log-failed | tail -50`); do not publish.

## 5. Put the notes on the release

```bash
gh release edit "$TAG" --notes-file "<scratchpad>/release-notes-$TAG.md"
```

Only change the notes. Never touch its assets, name or tag, and do not pass `--draft=false` here.

Before asking about publishing, make sure the whole workflow is done, not just the job that made the draft: the `server-assets` job attaches the `abundio-server` downloads and `SHA256SUMS` after it. `gh run view "$RUN" --json status,conclusion` must show `completed` / `success`. Then list the release's assets for the user.

## 6. Ask whether to publish

Use `AskUserQuestion`: "The notes are on the draft release <TAG> (<URL>). Publish it now?", with the options **Publish now** and **Keep as draft**.

- **Publish now:** `gh release edit "$TAG" --draft=false`, then confirm with `gh release view "$TAG" --json isDraft,url` and give the user the URL. Publishing makes the release public and lets the app's updater offer it, so never do it without this yes.
- **Keep as draft:** leave it, and tell the user the release URL so they can publish it themselves later.
