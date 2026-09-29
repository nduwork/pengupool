# Working in this repository

Notes for agent sessions. The contributor-facing rules are in
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md); this file is about how an agent should behave here.

## Merging

- **Never merge without the maintainer's explicit approval.** Open the PR, let the checks and
  review-guide run, and stop. No auto-merge, no `gh pr merge --admin` on your own initiative, and
  green checks are not approval.
- Squash-and-merge is the policy, so the PR title becomes the commit subject: keep it Conventional
  Commit style.
- A merge does not cut a release. Run `scripts/release.sh` only when asked.
- Never force-push `main`; the branch protection declines it, and a revert is the way back.

## Pull requests

- **One PR per theme, not per discovery.** When a test run or a sandbox turns up a series of related
  failures, finish sweeping that area and ship one coherent PR with a test for each, instead of a
  string of ten-line PRs — each of which triggers its own review pass and its own review round.
- Run the checks the change needs before pushing: `uv run pytest -q`, and for `extension/` changes
  `cd extension && npm test && npm run compile`.
- Leave unrelated edits out of the diff; a reviewer should see one intent.

## Reviews

- review-guide fires when a PR is created or pushed to. **Run it before merging, not after**: on a
  merged PR its preflight answers `SKIP: PR is MERGED`, so racing the merge produces a review prompt
  that can never do anything.
- Its self-check edits the working tree only. Those edits are committed with the maintainer's
  approval, never pushed on their own.
