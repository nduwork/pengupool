"""Skill-repo pool: the repos PenguPool manages, their pengupool/* worktrees, and their releases.

~/.pengupool/skill-pool.json = {"schema": 1, "repos": ["/abs/top", …]}. A worktree's branch is merged when
its GitHub PR is MERGED: repos squash-merge, so git's own ancestry check cannot tell."""
from __future__ import annotations

import datetime
import glob
import json
import os
import re
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


def clone(src: str, parent: str) -> str:
    """Clone a GitHub repo (owner/repo, https or ssh URL) into `parent`/<repo> and add it to the pool."""
    m = re.fullmatch(r"(?:(?:https://|git@)?github\.com[/:])?([\w.-]+)/([\w.-]+?)(?:\.git)?/?", src.strip())
    if not m:
        raise Refused(f"{src} is not a GitHub repo; use owner/repo or a github.com URL")
    dest = os.path.join(os.path.realpath(parent), m[2])
    if os.path.exists(dest):
        raise Refused(f"{dest} already exists; add it as a local folder instead")
    _git(parent, "clone", "-q", f"https://github.com/{m[1]}/{m[2]}", dest)
    return add(dest)


def remove(d: str) -> str:
    """Drop a repo from the pool; a subfolder or worktree drops its repo. A repo that is gone is matched by path."""
    try:
        p = _main_top(d)
    except Refused:
        p = os.path.realpath(d)
    _save([r for r in load() if r != p])
    return p


def pull(d: str) -> str:
    """Fast-forward a pool repo's main checkout. Local changes refuse it, so work in progress in
    that checkout is never touched."""
    top = _main_top(d)
    _in_pool(top)
    if _git(top, "status", "--porcelain"):
        raise Refused(f"{os.path.basename(top)} has uncommitted changes; pull it by hand")
    before = _git(top, "rev-parse", "HEAD")
    _git(top, "pull", "-q", "--ff-only")
    after = _git(top, "rev-parse", "HEAD")
    if after == before:
        return f"{os.path.basename(top)} is up to date"
    return f"{os.path.basename(top)}: {_git(top, 'rev-list', '--count', f'{before}..{after}')} new commit(s)"


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
        e = {"repo": r, "name": os.path.basename(r), "worktrees": [], "skill": _is_skill(r)}
        try:
            e["worktrees"] = worktrees(r)
            e["version"] = _last_tag(r)
        except Refused:
            e["missing"] = True
        out.append(e)
    return out


def _last_tag(top: str) -> str:
    try:
        return _git(top, "describe", "--tags", "--abbrev=0", "--match", "v*")
    except Refused:   # no release yet
        return ""


def _pr(cwd: str, branch: str) -> tuple[str, str]:
    """(state, head commit) of the PR gh finds for this branch name — MERGED / OPEN / CLOSED — or ('', '')
    when there is none or gh cannot say (missing, logged out). The name can be reused, so the PR found may
    be an older one: callers compare its head with the branch."""
    try:
        out = _run(cwd, "gh", "pr", "view", branch, "--json", "state,headRefOid", "-q", '.state + " " + .headRefOid', timeout=60)
    except Refused:
        return "", ""
    state, _, oid = out.partition(" ")
    return state, oid


def _pr_merged(path: str, branch: str) -> bool:
    """The branch's PR is merged AND carries every commit on the branch: no work was added after it."""
    state, oid = _pr(path, branch)
    if state != "MERGED" or not oid:
        return False
    tip = _git(path, "rev-parse", branch)
    try:
        return tip == oid or _git(path, "merge-base", "--is-ancestor", tip, oid) == ""
    except Refused:   # not an ancestor, or the PR's head is not known locally
        return False


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
    if _pr(path, branch)[0] != "OPEN":   # none, or an older merged/closed PR from a reused branch name
        _run(path, "gh", "pr", "create", "--fill", "--head", branch)
    _run(path, "gh", "pr", "merge", branch, "--squash")
    if not _pr_merged(path, branch):   # queued or awaiting checks: not on main yet
        raise Refused(f"{branch}: merge requested but the PR is not merged yet; remove it once it is")


def worktree_rm(path: str, merge: bool = False) -> str:
    """Remove a pengupool/* worktree and its branch once its PR is merged. With `merge`, an unmerged
    branch is squash-merged first and the repo released after; every refusal leaves everything in place."""
    path = os.path.realpath(path)
    top = _main_top(path)
    if path == top:
        raise Refused("that is the repo's main checkout, not a worktree")
    if merge:
        _in_pool(top)
        _skill_repo(top)
    branch = _git(path, "branch", "--show-current")
    if not branch.startswith("pengupool/"):
        raise Refused(f"{branch or 'a detached HEAD'} is not a pengupool/* branch")
    if _git(path, "status", "--porcelain"):
        raise Refused("the worktree has uncommitted changes")
    # `git worktree remove` deletes ignored files too, and a skill repo's owner MEMORY.md is gitignored.
    ignored = [ln[3:] for ln in _git(path, "status", "--porcelain", "--ignored").splitlines()
               if ln.startswith("!! ") and os.path.basename(ln[3:].rstrip("/")) != ".DS_Store"]
    if ignored:
        raise Refused("removing it would delete ignored files: " + ", ".join(ignored) + "; move them out first")
    live = [s.get("name") or s.get("sessionId", "?") for s in model.load_sessions() if _inside(s.get("cwd", ""), path)]
    if live:
        raise Refused("a live session runs there: " + ", ".join(live))
    merged_now = False
    if not (_pr_merged(path, branch) or _landed(path, branch)):
        if not merge:
            _skill_repo(top, f"{branch} is not merged to main, and ")   # a plain repo is never asked to merge
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


def _is_skill(top: str) -> bool:
    return bool(glob.glob(os.path.join(glob.escape(top), "skills", "*", "SKILL.md")))


def _skill_repo(top: str, lead: str = "") -> None:
    """Only skill repos are merged and released by PenguPool. Any other pool repo (an ops or app repo
    whose PRs its owner merges on GitHub) keeps sessions and merged-worktree removal, nothing more."""
    if not _is_skill(top):
        raise Refused(f"{lead}{os.path.basename(top)} is not a skill repo (no skills/*/SKILL.md): PenguPool "
                      "never merges or releases it; merge its PR on GitHub, then remove the worktree")


def _in_pool(top: str) -> None:
    """Merging and releasing act on a repo's main; only repos the user put in the pool get that."""
    if top not in load():
        raise Refused(f"{top} is not in the skill pool; merging and releasing are only for pool repos")


def _today() -> datetime.date:
    return datetime.date.today()


def _tags(top: str) -> set[str]:
    local = set(_git(top, "tag", "--list", "v*").split())
    remote = {ln.split("refs/tags/", 1)[1].removesuffix("^{}")
              for ln in _git(top, "ls-remote", "--tags", "origin").splitlines() if "refs/tags/" in ln}
    return local | remote


def _changelog(top: str, version: str, day: str, notes: list[str]) -> None:
    """Add the release's section in the file's own style: Keep a Changelog (`## [0.4.0] - day`, taking over the
    curated Unreleased notes when there are any) or plain (`## 0.4 — day`). Headings drop the tag's `v`."""
    p = os.path.join(top, "CHANGELOG.md")
    try:
        with open(p) as f:
            text = f.read()
    except FileNotFoundError:
        text = "# Changelog\n"
    name, bullets = version[1:], "".join(f"- {n}\n" for n in notes)
    kac = re.search(r"^## \[Unreleased\][^\n]*\n", text, re.M)
    if kac:
        rest = text[kac.end():]
        nxt = re.search(r"^## ", rest, re.M)
        body = rest[:nxt.start()] if nxt else rest
        section = f"## [{name}] - {day}\n\n" + (body.lstrip("\n") if body.strip() else bullets + "\n")
        text = text[:kac.end()] + "\n" + section + rest[len(body):]
    else:
        section = f"## {name} — {day}\n\n" + bullets
        i = text.find("\n## ")
        text = text[:i + 1] + section + "\n" + text[i + 1:] if i >= 0 else text.rstrip("\n") + "\n\n" + section
    with open(p, "w") as f:
        f.write(text)


def _next_version(last: str, day: datetime.date, tags: set[str]) -> str:
    """Keep the repo's scheme: semver tags get the next minor in the same number of parts (v0.2 → v0.3,
    v0.3.0 → v0.4.0); no tags or date tags get today's date, suffixed -1, -2 … when taken."""
    if not last or re.fullmatch(r"v\d{4}\.\d{2}\.\d{2}(-\d+)?", last):
        version = base = f"v{day:%Y.%m.%d}"
        n = 0
        while version in tags:
            n += 1
            version = f"{base}-{n}"
        return version
    m = re.fullmatch(r"v(\d+)\.(\d+)(\.\d+)?", last)
    if not m:
        raise Refused(f"cannot tell the version scheme from tag {last}; tag this release by hand")
    version = f"v{m[1]}.{int(m[2]) + 1}" + (".0" if m[3] else "")
    if version in tags:
        raise Refused(f"{version} already exists on origin or locally; tag this release by hand")
    return version


def _package_json(top: str, version: str) -> bool:
    """Set package.json's version to the release (semver, so v0.3 → 0.3.0); False when there is none."""
    p = os.path.join(top, "package.json")
    try:
        with open(p) as f:
            text = f.read()
    except FileNotFoundError:
        return False
    v = version[1:] + (".0" if version[1:].count(".") == 1 else "")
    text, n = re.subn(r'("version"\s*:\s*")[^"]*(")', lambda m: m[1] + v + m[2], text, count=1)
    if n:
        with open(p, "w") as f:
            f.write(text)
    return bool(n)


def release(d: str) -> str:
    """Release a skill repo from its main checkout: next version in the repo's own scheme (`_next_version`),
    CHANGELOG section and package.json version, commit, tag, push, GitHub release. PenguPool owns this for
    every pool repo."""
    top = _main_top(d)
    _in_pool(top)
    _skill_repo(top)
    if _git(top, "branch", "--show-current") != "main":
        raise Refused("release from main: the main checkout is on another branch")
    if _git(top, "status", "--porcelain"):
        raise Refused("the main checkout has uncommitted changes")
    _git(top, "pull", "-q", "--ff-only", "origin", "main")
    last = _last_tag(top)
    notes = [s for s in _git(top, "log", "--format=%s", f"{last}..HEAD" if last else "HEAD").splitlines() if s]
    if not notes:
        raise Refused(f"nothing to release since {last or 'the start'}")
    day = _today()
    version = _next_version(last, day, _tags(top))
    _changelog(top, version, day.isoformat(), notes)
    _git(top, "add", "CHANGELOG.md", *(["package.json"] if _package_json(top, version) else []))
    _git(top, "commit", "-q", "-m", f"chore: release {version}")
    _git(top, "tag", version)
    try:
        _git(top, "push", "-q", "--atomic", "origin", "main", version)
    except Refused as e:   # nothing reached origin: undo our commit and tag so the release can be retried
        _git(top, "tag", "-d", version)
        _git(top, "reset", "-q", "--hard", "HEAD~1")
        raise Refused(f"push refused, release undone: {e}") from None
    try:
        _run(top, "gh", "release", "create", version, "--title", version, "--notes", "\n".join(f"- {n}" for n in notes))
    except Refused as e:
        raise Refused(f"{version} is tagged and pushed, but the GitHub release failed: {e}; "
                      f"finish it with `gh release create {version} --generate-notes`") from None
    return version
