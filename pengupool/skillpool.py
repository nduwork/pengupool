"""Skill-repo pool: the repos PenguPool manages, their pengupool/* worktrees, and their releases.

~/.pengupool/skill-pool.json = {"schema": 1, "repos": ["/abs/top", …]}. A worktree's branch is merged when
its GitHub PR is MERGED: repos squash-merge, so git's own ancestry check cannot tell."""
from __future__ import annotations

import datetime
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


def _pr_state(cwd: str, branch: str) -> str:
    """MERGED / OPEN / CLOSED, or '' when there is no PR or gh cannot say (missing, logged out)."""
    try:
        return _run(cwd, "gh", "pr", "view", branch, "--json", "state", "-q", ".state", timeout=60)
    except Refused:
        return ""


def _landed(path: str, branch: str) -> bool:
    """Fallback when gh has no PR to report (missing, logged out, or no PR): the branch's changes are already
    in origin/main when replaying it there leaves main's tree unchanged — true after a squash merge too."""
    try:
        _git(path, "fetch", "-q", "origin", "main")
        tree = _git(path, "merge-tree", "--write-tree", "origin/main", branch).split("\n", 1)[0]
        return tree == _git(path, "rev-parse", "origin/main^{tree}")
    except Refused:   # a conflict, or git < 2.38 without --write-tree: not proven merged
        return False


def _inside(cwd: str, path: str) -> bool:
    c = os.path.realpath(cwd) if cwd else ""
    return c == path or c.startswith(path + os.sep)


def _merge(path: str, branch: str) -> None:
    """Push the branch, open its PR if it has none, squash-merge it. The user confirmed this."""
    _git(path, "push", "-q", "-u", "origin", branch)
    if not _pr_state(path, branch):
        _run(path, "gh", "pr", "create", "--fill", "--head", branch)
    _run(path, "gh", "pr", "merge", branch, "--squash")
    if _pr_state(path, branch) != "MERGED":   # queued or awaiting checks: not on main yet
        raise Refused(f"{branch}: merge requested but the PR is not merged yet; remove it once it is")


def worktree_rm(path: str, merge: bool = False) -> str:
    """Remove a pengupool/* worktree and its branch once its PR is merged. With `merge`, an unmerged
    branch is squash-merged first and the repo released after; every refusal leaves everything in place."""
    path = os.path.realpath(path)
    top = _main_top(path)
    if path == top:
        raise Refused("that is the repo's main checkout, not a worktree")
    branch = _git(path, "branch", "--show-current")
    if not branch.startswith("pengupool/"):
        raise Refused(f"{branch or 'a detached HEAD'} is not a pengupool/* branch")
    if _git(path, "status", "--porcelain"):
        raise Refused("the worktree has uncommitted changes")
    live = [s.get("name") or s.get("sessionId", "?") for s in model.load_sessions() if _inside(s.get("cwd", ""), path)]
    if live:
        raise Refused("a live session runs there: " + ", ".join(live))
    merged_now = False
    state = _pr_state(path, branch)
    if state != "MERGED" and not (state == "" and _landed(path, branch)):
        if not merge:
            raise Unmerged(f"{branch} is not merged to main")
        _merge(path, branch)
        merged_now = True
    _git(top, "worktree", "remove", path)
    _git(top, "branch", "-D", branch)
    _git(top, "worktree", "prune")
    msg = f"removed {path}"
    if merged_now:
        try:
            msg += f"; released {release(top)}"
        except Refused as e:
            msg += f"; release skipped: {e} (run `pengupool ctl release {top}`)"
    return msg


def _today() -> datetime.date:
    return datetime.date.today()


def _tags(top: str) -> set[str]:
    local = set(_git(top, "tag", "--list", "v*").split())
    remote = {ln.split("refs/tags/", 1)[1].removesuffix("^{}")
              for ln in _git(top, "ls-remote", "--tags", "origin").splitlines() if "refs/tags/" in ln}
    return local | remote


def _changelog(top: str, version: str, day: str, notes: list[str]) -> None:
    p = os.path.join(top, "CHANGELOG.md")
    try:
        with open(p) as f:
            text = f.read()
    except FileNotFoundError:
        text = "# Changelog\n"
    section = f"## {version} — {day}\n\n" + "".join(f"- {n}\n" for n in notes)
    i = text.find("\n## ")
    text = text[:i + 1] + section + "\n" + text[i + 1:] if i >= 0 else text.rstrip("\n") + "\n\n" + section
    with open(p, "w") as f:
        f.write(text)


def release(d: str) -> str:
    """Release a skill repo from its main checkout: date version, CHANGELOG section from the commit
    subjects since the last tag, commit, tag, push, GitHub release. PenguPool owns this for every pool repo."""
    top = _main_top(d)
    if _git(top, "branch", "--show-current") != "main":
        raise Refused("release from main: the main checkout is on another branch")
    if _git(top, "status", "--porcelain"):
        raise Refused("the main checkout has uncommitted changes")
    _git(top, "pull", "-q", "--ff-only", "origin", "main")
    try:
        last = _git(top, "describe", "--tags", "--abbrev=0", "--match", "v*")
    except Refused:
        last = ""
    notes = [s for s in _git(top, "log", "--format=%s", f"{last}..HEAD" if last else "HEAD").splitlines() if s]
    if not notes:
        raise Refused(f"nothing to release since {last or 'the start'}")
    tags, day = _tags(top), _today()
    version = base = f"v{day:%Y.%m.%d}"
    n = 0
    while version in tags:
        n += 1
        version = f"{base}-{n}"
    _changelog(top, version, day.isoformat(), notes)
    _git(top, "add", "CHANGELOG.md")
    _git(top, "commit", "-q", "-m", f"chore: release {version}")
    _git(top, "tag", version)
    _git(top, "push", "-q", "origin", "main", version)
    _run(top, "gh", "release", "create", version, "--title", version, "--notes", "\n".join(f"- {n}" for n in notes))
    return version
