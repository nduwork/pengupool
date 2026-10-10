"""Skill-repo pool: registry, worktree removal behind a merged-PR check, and PenguPool's own releases.
Real temp git repos; origin is a bare repo reached through a github.com URL (insteadOf), and `gh` is a
fake on PATH whose PR state lives in files."""
import datetime
import os
import subprocess
from pathlib import Path

import pytest

from pengupool import model, skillpool, tmux

FAKE_GH = r"""#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
key() { echo "$1" | tr / _; }
case "$1 $2" in
  "pr view") f="$FAKE_GH/$(key "$3")"; [ -f "$f" ] && cat "$f" && exit 0
             echo "no pull requests found for branch $3" >&2; exit 1;;
  "pr create") echo OPEN > "$FAKE_GH/$(key "$(git branch --show-current)")"; exit 0;;
  "pr merge") [ -n "$GH_MERGE_FAILS" ] && { echo "required checks are failing" >&2; exit 1; }
              echo MERGED > "$FAKE_GH/$(key "$3")"; exit 0;;
  "release create") exit 0;;
esac
echo "unexpected: gh $*" >&2; exit 1
"""


def git(cwd, *a):
    return subprocess.run(["git", "-C", str(cwd), *a], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(model, "PENGU", tmp_path / "pengu")
    monkeypatch.setattr(model, "load_sessions", lambda: [])
    for k in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{k}_NAME", "t")
        monkeypatch.setenv(f"GIT_{k}_EMAIL", "t@t")
    (tmp_path / "gh").mkdir()
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "gh").write_text(FAKE_GH)
    (bin_ / "gh").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_GH", str(tmp_path / "gh"))
    return tmp_path


def make_repo(tmp, name="skills"):
    """A repo on main, pushed to a bare origin that answers at https://github.com/me/<name>."""
    origin = tmp / f"{name}.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    top = tmp / name
    top.mkdir()
    git(top, "init", "-q", "-b", "main")
    git(top, "config", f"url.{origin}.insteadOf", f"https://github.com/me/{name}")
    git(top, "remote", "add", "origin", f"https://github.com/me/{name}")
    git(top, "commit", "-q", "--allow-empty", "-m", "root")
    git(top, "push", "-q", "-u", "origin", "main")
    return os.path.realpath(top)


def gh_calls(tmp):
    p = tmp / "gh" / "calls"
    return p.read_text() if p.exists() else ""


def test_pool_add_ls_rm(env):
    top = make_repo(env)
    wt = tmux.worktree_add(top, "log run")
    assert skillpool.add(wt) == top                 # a worktree path registers its main checkout
    assert skillpool.add(top) == top and skillpool.load() == [top]   # no duplicate
    [entry] = skillpool.ls()
    assert entry["repo"] == top and entry["name"] == "skills"
    assert entry["worktrees"] == [{"path": os.path.realpath(wt), "branch": "pengupool/log-run"}]
    skillpool.remove(top)
    assert skillpool.load() == [] and skillpool.ls() == []


def test_rm_accepts_trailing_slash(env):
    top = make_repo(env)
    skillpool.add(top)
    skillpool.remove(top + "/")
    assert skillpool.load() == []


def test_add_refuses_non_repo_and_no_github_origin(env):
    with pytest.raises(skillpool.Refused, match="not a git repo"):
        skillpool.add(str(env))
    local = env / "local"
    local.mkdir()
    git(local, "init", "-q")
    with pytest.raises(skillpool.Refused, match="GitHub origin"):
        skillpool.add(str(local))
    assert skillpool.load() == []


def test_ls_flags_a_missing_repo(env):
    top = make_repo(env)
    skillpool.add(top)
    subprocess.run(["rm", "-rf", top], check=True)
    assert skillpool.ls() == [{"repo": top, "name": "skills", "worktrees": [], "missing": True}]


def wt_with_commit(top, name="log run"):
    wt = tmux.worktree_add(top, name)
    Path(wt, "logs").mkdir(exist_ok=True)
    Path(wt, "logs", "a.md").write_text("done\n")
    git(wt, "add", "-A")
    git(wt, "commit", "-q", "-m", "log: a")
    return os.path.realpath(wt), git(wt, "branch", "--show-current")


def merged(tmp, branch):
    (tmp / "gh" / branch.replace("/", "_")).write_text("MERGED\n")


def test_refusals_leave_the_worktree(env):
    top = make_repo(env)
    wt, branch = wt_with_commit(top)
    with pytest.raises(skillpool.Refused, match="main checkout"):
        skillpool.worktree_rm(top)
    other = env / "feat-wt"
    git(top, "worktree", "add", "-q", "-b", "feat/x", str(other))
    with pytest.raises(skillpool.Refused, match="not a pengupool"):
        skillpool.worktree_rm(str(other))
    with pytest.raises(skillpool.Unmerged, match="not merged"):
        skillpool.worktree_rm(wt)
    merged(env, branch)
    Path(wt, "scratch.txt").write_text("x")
    with pytest.raises(skillpool.Refused, match="uncommitted"):
        skillpool.worktree_rm(wt)
    assert os.path.isdir(wt) and branch in git(top, "branch")


def test_live_session_blocks_only_inside(env, monkeypatch):
    top = make_repo(env)
    wt, branch = wt_with_commit(top)
    merged(env, branch)
    monkeypatch.setattr(model, "load_sessions", lambda: [{"sessionId": "s1", "name": "logger", "cwd": wt + "/logs"}])
    with pytest.raises(skillpool.Refused, match="logger"):
        skillpool.worktree_rm(wt)
    monkeypatch.setattr(model, "load_sessions", lambda: [{"sessionId": "s2", "name": "sib", "cwd": wt + "-1"}])
    assert skillpool.worktree_rm(wt).startswith("removed")


def test_merged_worktree_is_removed_with_its_branch(env):
    top = make_repo(env)
    wt, branch = wt_with_commit(top)
    merged(env, branch)
    assert skillpool.worktree_rm(wt) == f"removed {wt}"
    assert not os.path.exists(wt)
    assert branch not in git(top, "branch")
    assert "release" not in gh_calls(env)       # already merged: nothing to release here


def test_rm_vanished_path_refuses(env):
    top = make_repo(env)
    wt, branch = wt_with_commit(top)
    merged(env, branch)
    skillpool.worktree_rm(wt)
    with pytest.raises(skillpool.Refused):
        skillpool.worktree_rm(wt)


def test_merge_pushes_merges_removes_and_releases(env, monkeypatch):
    monkeypatch.setattr(skillpool, "_today", lambda: datetime.date(2026, 10, 10))
    top = make_repo(env)
    wt, branch = wt_with_commit(top)
    msg = skillpool.worktree_rm(wt, merge=True)
    assert msg == f"removed {wt}; released v2026.10.10"
    calls = gh_calls(env)
    assert "pr create" in calls and f"pr merge {branch} --squash" in calls and "release create v2026.10.10" in calls
    assert branch in git(env / "skills.git", "branch")              # pushed before the PR
    assert "v2026.10.10" in git(env / "skills.git", "tag")
    assert not os.path.exists(wt)


def test_merge_failure_removes_nothing(env, monkeypatch):
    monkeypatch.setenv("GH_MERGE_FAILS", "1")
    top = make_repo(env)
    wt, _ = wt_with_commit(top)
    with pytest.raises(skillpool.Refused, match="checks are failing"):
        skillpool.worktree_rm(wt, merge=True)
    assert os.path.isdir(wt)


def test_release_skipped_when_main_checkout_dirty(env):
    top = make_repo(env)
    wt, _ = wt_with_commit(top)
    Path(top, "wip.txt").write_text("x")
    msg = skillpool.worktree_rm(wt, merge=True)
    assert msg.startswith(f"removed {wt}; release skipped: ") and "uncommitted" in msg
    assert not os.path.exists(wt)


def _no_gh(monkeypatch):
    """PATH with git but without the fake (or any) gh."""
    import shutil
    monkeypatch.setenv("PATH", os.path.dirname(shutil.which("git")))
    assert shutil.which("gh") is None


def test_no_gh_is_unmerged_then_refused(env, monkeypatch):
    top = make_repo(env)
    wt, _ = wt_with_commit(top)
    _no_gh(monkeypatch)
    with pytest.raises(skillpool.Unmerged):
        skillpool.worktree_rm(wt)
    with pytest.raises(skillpool.Refused, match="gh"):
        skillpool.worktree_rm(wt, merge=True)
    assert os.path.isdir(wt)


def test_no_gh_but_landed_on_main_is_removed(env, monkeypatch):
    top = make_repo(env)
    wt, branch = wt_with_commit(top)
    git(top, "merge", "-q", "--squash", branch)          # the content lands on main as one new commit
    git(top, "commit", "-q", "-m", "log: a (#1)")
    git(top, "push", "-q", "origin", "main")
    _no_gh(monkeypatch)
    assert skillpool.worktree_rm(wt) == f"removed {wt}"


def test_release_versions_changelog_and_refusals(env, monkeypatch):
    monkeypatch.setattr(skillpool, "_today", lambda: datetime.date(2026, 10, 10))
    top = make_repo(env)
    assert skillpool.release(top) == "v2026.10.10"
    text = open(os.path.join(top, "CHANGELOG.md")).read()
    assert text == "# Changelog\n\n## v2026.10.10 — 2026-10-10\n\n- root\n"
    with pytest.raises(skillpool.Refused, match="nothing to release"):
        skillpool.release(top)
    git(top, "commit", "-q", "--allow-empty", "-m", "log: b")
    git(env / "skills.git", "tag", "v2026.10.10-1", "main")        # taken on origin only
    assert skillpool.release(top) == "v2026.10.10-2"
    text = open(os.path.join(top, "CHANGELOG.md")).read()
    assert text.index("v2026.10.10-2") < text.index("## v2026.10.10 —")   # newest first
    assert "- log: b\n" in text and "chore: release" not in text.split("## v2026.10.10 —")[0]
    git(top, "checkout", "-q", "-b", "side")
    with pytest.raises(skillpool.Refused, match="main"):
        skillpool.release(top)
