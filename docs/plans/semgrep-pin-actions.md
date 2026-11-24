# Semgrep findings from PR #280: pin actions, silence false alarms

Semgrep's differential scan on #280 (Remote Hosts) reported 10 findings:
5 warnings, 5 notes, no errors.

## Findings

**Warnings — `github-actions-mutable-action-tag`** (`build.yml` lines 70,
119, 132, 157, 172). A step written `actions/checkout@v4` follows a tag the
action's owner can move; `dtolnay/rust-toolchain@stable` follows a branch.
If one of those actions were taken over, the new code would run in the
release build, which holds the updater signing key. The scan only looks at
changed lines; the same problem was on every `uses:` line in all workflows.

**Notes — false alarms.**

- `temp-dir`, `control_protocol.rs` (3 test functions): a scratch folder
  with a random name for a test. No security decision rests on it.
- `args`, `abundio-server/src/main.rs`: reads options only and skips
  `argv[0]`, the part the rule warns about.
- `current-exe`, `server_binary.rs` `dev_build`: finds the development
  server next to the app. Both callers run it only under
  `cfg!(debug_assertions)`; release builds use the bundled server.

## Plan

One branch, `chore/pin-actions`.

1. **Pin every action to a commit SHA** in all workflows, with the version
   as a comment (`actions/checkout@<sha> # v4.4.0`). SHAs come from
   `git ls-remote`, following annotated tags to the commit.
   `dtolnay/rust-toolchain` is pinned to a commit of its `stable` branch
   and given `toolchain: stable`, since the branch name was what chose the
   toolchain.
2. **Keep Dependabot security-only** (decided). It already covers
   `github-actions` and updates SHA pins with their comments, but only for
   security fixes. Routine action updates are done by hand.
3. **Silence the 5 notes** with `// nosemgrep: <rule-id> -- <reason>` on
   the line above each, so a new real use of these calls is still flagged.
4. **Verify**: run Semgrep locally on the changed files (expect 0
   findings), `cargo check --workspace`, and let `test.yml` and the Semgrep
   workflow run on the PR. `build.yml` runs only on a version tag, so the
   next release is its full test.
