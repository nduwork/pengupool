"""Skill-repo pool: registry, worktree removal behind a merged-PR check, and PenguPool's own releases.
Real temp git repos; origin is a bare repo reached through a github.com URL (insteadOf), and `gh` is a
fake on PATH whose PR state lives in files."""
import os
import subprocess

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
