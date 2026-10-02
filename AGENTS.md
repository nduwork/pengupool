# Working in this repository

Notes for agent sessions. The contributor-facing rules are in
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md); this file covers how an agent should behave here.

## Merging

- **Merge only with approval.** Open the PR, let the checks run, and stop there. Green checks are not a
  go-ahead, and `gh pr merge --admin` does not happen on your own initiative.
- Squash-and-merge is the policy, so the PR title becomes the commit subject. Keep it Conventional
  Commit style.
- A merge does not cut a release. Run `scripts/release.sh` only when asked.
- Never force-push `main`. Branch protection declines it; a revert is the way back.

## Pull requests

- **One PR per theme.** When a test run or a sandbox turns up a series of related failures, sweep that
  area and ship one PR with a test for each fix. A string of ten-line PRs costs a review round each and
  reads worse.
- Run the checks the change needs before pushing: `make test` runs both suites (`uv run pytest -q`, and
  `make ext-test` for `extension/`). A fresh clone or git worktree has no `extension/node_modules`, so run
  `make ext-deps` once first, or the extension tests fail with `Cannot find module 'typescript'`.
- Leave unrelated edits out of the diff, so a reviewer sees one intent.
