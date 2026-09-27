# Contributing to PenguPool

Thanks for helping improve PenguPool. Contributions go through a fork and pull request: fork this repository, make a focused change on your fork, and open a PR against `main`. The maintainer reviews and merges changes. Direct write access is not offered to contributors.

The maintainer merges every PR with squash and merge, so `main` gets one commit per pull request and the branch's individual commits do not land. The PR title becomes the commit subject, so keep it Conventional Commit style.

Merging does not cut a release. Releases are made deliberately when a change warrants one; docs, chore and CI changes land without a version bump.

Before opening a PR, run `uv run pytest -q` and, for extension changes, `cd extension && npm test && npm run compile`. Include a short description of the behavior change and any relevant test results. Use a Conventional Commit style PR title such as `fix: handle stale sessions`.

By submitting a contribution, you agree to license it under this repository's [MIT license](../LICENSE). You must have the right to submit the code and any included assets.
