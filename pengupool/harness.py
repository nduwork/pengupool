"""The few things that differ between agent harnesses: Claude Code ("cc") and pi ("pi"), which PenguPool
runs as oh-my-pi (`omp`), a pi fork that loads pi extensions and keeps pi's session layout.

Everything else is shared: a pi session is made to look like a Claude one. The PenguPool pi
extension (pi-extension/) writes a live-session file in the same shape as Claude Code's
`~/.claude/sessions/*.json`, the same `context/<sid>.json` and the same registry line, so discovery,
liveness, state and ctx % reuse the Claude code paths. Harnesses never mix: each has its own tmux
server and a session may only be grouped with sessions of its own harness.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

HARNESSES = ("cc", "pi")
CLI = {"cc": "claude", "pi": "omp"}
LABEL = {"cc": "Claude Code", "pi": "oh-my-pi"}
SOCK = {"cc": "pengupool", "pi": "pengupool-pi"}  # one tmux sessions server (-L) per harness
TOOL = {"cc": "SendMessage", "pi": "the intercom tool (action send or ask)"}
# slash command that renames a live session; pi-intercom's /alias sets the name intercom addresses
RENAME = {"cc": "/rename", "pi": "/alias"}
# names the rename command reads as something else: pi-intercom's `/alias`, `/alias menu` open its dialog
RENAME_RESERVED = {"cc": (), "pi": ("", "menu")}
# slash command that restarts a live session's conversation under a new id, in the same process
CLEAR = {"cc": "/clear", "pi": "/new"}

PI = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".omp" / "agent"))
# plain pi's dir, where sessions started before 1.3.0 keep their transcripts; omp resumes them by path
LEGACY_PI = Path.home() / ".pi" / "agent"


def pi_extension() -> Path:
    return PI / "extensions" / "pengupool.ts"


def wired(h: str) -> bool:
    """omp without the PenguPool extension starts fine but never registers itself, so its card stays a
    'waiting' pane placeholder that nothing can group or message (`pengupool setup pi` installs it)."""
    return h != "pi" or pi_extension().is_file()


def check(h: str) -> str:
    """Validate a harness name from argv or JSON; raise so ctl reports it instead of guessing."""
    if h not in HARNESSES:
        raise ValueError(f"unknown harness {h!r} (expected one of {', '.join(HARNESSES)})")
    return h


def of(s: dict) -> str:
    """A session's harness; records written before harnesses existed are Claude's."""
    h = s.get("harness")
    return h if h in HARNESSES else "cc"


# PenguPool hosts every session in tmux, where Claude's "auto" teammateMode splits agent-team teammates
# into panes that pop open over the work pane. Keep them in-process, as Claude does outside tmux.
CC_FLAGS = ["--teammate-mode", "in-process"]


def argv_new(h: str, name: str) -> list[str]:
    # omp has no --name: the PenguPool extension names the session from this env var on its first start
    return [CLI["cc"], *CC_FLAGS, "--name", name] if check(h) == "cc" else \
        ["env", f"PENGUPOOL_SESSION_NAME={name}", CLI["pi"]]


def argv_resume(h: str, name: str, sid: str) -> list[str]:
    # omp keeps the session's name in the session file itself
    if check(h) == "cc":
        return [CLI["cc"], *CC_FLAGS, "--name", name, "--resume", sid]
    hit = _pi_file(sid)
    return [CLI["pi"], "--resume", str(hit) if hit and not hit.is_relative_to(PI) else sid]


def _slug(text: str) -> str:
    return re.sub(r"[/\\:]", "-", text)


def _abs_dir_name(cwd: str) -> str:
    """`--<cwd without leading slash, / \\ : → ->--`: omp's folder name for a cwd under neither home nor
    the temp root, and every version of pi's own name for any cwd."""
    return "--" + _slug(re.sub(r"^[/\\]", "", cwd)) + "--"


def _inside(cwd: str, root: str) -> str | None:
    """`cwd` relative to `root` when it sits inside it (the root itself counts, as omp's
    isRelativeWithin does), else None."""
    rel = os.path.relpath(cwd, root)
    if rel == os.curdir:
        return ""  # the root itself: omp's path.relative gives "" and counts as inside
    return None if rel.startswith(os.pardir) else rel


def _rel_dir_name(prefix: str, relative: str) -> str:
    """omp's encodeRelativeSessionDirName: the scope prefix, then the slugged relative path, joined with
    a dash unless the prefix already ends in one."""
    slug = _slug(relative)
    if not slug:
        return prefix
    return prefix + slug if prefix.endswith("-") else f"{prefix}-{slug}"


def _tmp_root() -> str:
    """The temp root omp scopes a cwd under: $TMPDIR, which Node's os.tmpdir() reads."""
    return os.environ.get("TMPDIR") or "/tmp"


def pi_dir_names(cwd: str) -> list[str]:
    """omp's session folder for `cwd`, best first: a cwd under the temp root is `-tmp-<relative>`, one
    under $HOME is `-<relative>`, anything else is `--<absolute>--`; last comes the `--<absolute>--`
    name omp migrates away from, which an install it has not migrated yet still holds. Mirrors omp's
    getDefaultSessionDirName (`src/session/session-paths.ts`, omp 18.10)."""
    # omp compares against the canonical roots: macOS's $TMPDIR /var/folders/… is /private/var/folders/…
    home = _inside(cwd, os.path.realpath(os.path.expanduser("~")))
    temp = _inside(cwd, os.path.realpath(_tmp_root()))
    names: list[str] = []
    if temp is not None:
        names.append(_rel_dir_name("-tmp", temp))
        if home is not None:  # the temp root nests inside home on Windows
            names.append(_rel_dir_name("-", home))
    elif home is not None:
        names.append(_rel_dir_name("-", home))
    absolute = _abs_dir_name(cwd)
    return names if absolute in names else [*names, absolute]


def pi_dir(cwd: str) -> Path:
    """omp's per-cwd session folder, the one it writes today."""
    return PI / "sessions" / pi_dir_names(cwd)[0]


def pi_dirs(cwd: str) -> list[Path]:
    """Every folder the cwd's sessions can live in, best first: omp's — for the cwd as given and as
    resolved, since omp names the folder after the canonical path (`/tmp/x` becomes `/private/tmp/x`) —
    then plain pi's from before 1.3.0, which always used the absolute name."""
    names = pi_dir_names(cwd)
    real = os.path.realpath(cwd)
    if real != cwd:
        names += [n for n in pi_dir_names(real) if n not in names]
    dirs = [PI / "sessions" / name for name in names]
    if LEGACY_PI != PI:
        dirs += [LEGACY_PI / "sessions" / name for name in dict.fromkeys([_abs_dir_name(cwd), _abs_dir_name(real)])]
    return dirs


def pi_roots() -> list[Path]:
    return [PI] if LEGACY_PI == PI else [PI, LEGACY_PI]


def _newest(paths) -> Path | None:
    """Files are named `<timestamp>_<uuid>.jsonl`; omp's own copy wins over a plain-pi one."""
    hits = sorted(paths, key=lambda p: (p.is_relative_to(PI), p.name))
    return hits[-1] if hits else None


def pi_transcript(cwd: str, sid: str) -> Path | None:
    return _newest(f for d in pi_dirs(cwd) for f in d.glob(f"*_{sid}.jsonl"))


def _pi_file(sid: str) -> Path | None:
    return _newest(f for root in pi_roots() for f in (root / "sessions").glob(f"*/*_{sid}.jsonl"))
