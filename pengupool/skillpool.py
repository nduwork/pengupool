"""Skill-repo pool: the repos PenguPool manages, their pengupool/* worktrees, and their releases.

~/.pengupool/skill-pool.json = {"schema": 1, "repos": ["/abs/top", …]}. A worktree's branch is merged when
its GitHub PR is MERGED: repos squash-merge, so git's own ancestry check cannot tell."""
from __future__ import annotations

import json
import os
import subprocess

from . import model


class Refused(Exception):
    """A check failed; the message is shown to the user as-is."""


class Unmerged(Refused):
    """The branch's PR is not merged; the caller may ask to merge it."""


def _pool_file():
    return model.PENGU / "skill-pool.json"


def _run(cwd: str, *cmd: str, timeout: float = 300) -> str:
    try:
        r = subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Refused(f"{cmd[0]}: {e}") from None
    if r.returncode != 0:
        raise Refused((r.stderr or r.stdout).strip() or f"{' '.join(cmd[:2])} failed")
    return r.stdout.strip()


def _git(cwd: str, *args: str) -> str:
    return _run(cwd, "git", *args)


def _main_top(d: str) -> str:
    """The main checkout of the repo `d` is in, even when `d` is a linked worktree."""
    try:
        common = _git(d, "rev-parse", "--path-format=absolute", "--git-common-dir")
    except Refused:
        raise Refused(f"not a git repo: {d}") from None
    return os.path.realpath(os.path.dirname(common))


def load() -> list[str]:
    try:
        d = json.loads(_pool_file().read_text())
    except (OSError, ValueError):
        return []
    return [r for r in d.get("repos", []) if isinstance(r, str)] if isinstance(d, dict) else []


def _save(repos: list[str]) -> None:
    p = _pool_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"schema": 1, "repos": repos}, indent=2))
    tmp.replace(p)


def add(d: str) -> str:
    top = _main_top(d)
    try:
        url = _git(top, "config", "--get", "remote.origin.url")
    except Refused:
        url = ""
    if "github.com" not in url:
        raise Refused(f"{top} has no GitHub origin; merging and releasing need one")
    repos = load()
    if top not in repos:
        _save(repos + [top])
    return top


def remove(d: str) -> str:
    p = os.path.realpath(d)   # the repo may be gone, so no git lookup
    _save([r for r in load() if r != p])
    return p


def worktrees(top: str) -> list[dict]:
    out, path = [], ""
    for line in _git(top, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line.startswith("branch refs/heads/pengupool/"):
            out.append({"path": os.path.realpath(path), "branch": line[len("branch refs/heads/"):]})
    return out


def ls() -> list[dict]:
    out = []
    for r in load():
        e = {"repo": r, "name": os.path.basename(r), "worktrees": []}
        try:
            e["worktrees"] = worktrees(r)
        except Refused:
            e["missing"] = True
        out.append(e)
    return out
