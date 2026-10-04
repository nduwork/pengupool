"""`pengupool install-hook`: register pengupool.context on Claude lifecycle events, the
pengupool.routing guard on `SendMessage`, and wrap the statusLine with pengupool.statusline so the list
and map show Claude's ctx % the way the pi extension reports pi's."""
from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path

from .model import CLAUDE, write_json

# never let a broken/uninstalled PenguPool surface as a hook error in every Claude session, or block a
# message: the SendMessage guard denies only a send it checked (docs/group-session-framework.md)
CMD = f"{shlex.quote(sys.executable)} -m pengupool.context 2>/dev/null || true"
GUARD = f"{shlex.quote(sys.executable)} -m pengupool.routing || true"
LEGACY = "pengupool/session_start.sh"


def _without_ours(entries: list) -> list:
    kept = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
            kept.append(entry)
            continue
        remaining = [h for h in entry["hooks"] if not (
            isinstance(h, dict) and (LEGACY in str(h.get("command", ""))
                                    or "pengupool.context" in str(h.get("command", ""))
                                    or "pengupool.routing" in str(h.get("command", ""))))]
        if remaining or not entry["hooks"]:
            kept.append({**entry, "hooks": remaining})
    return kept


def _status(inner: str) -> str:
    """The wrapper command around `inner` ('' = standalone). It runs `inner` itself when the pinned
    interpreter is gone (a deleted venv), so the user's status line never goes blank over PenguPool."""
    py = shlex.quote(sys.executable)
    run = f"{py} -P -m pengupool.statusline"   # -P: a pengupool/ folder in the project cannot shadow ours
    return f"[ -x {py} ] && exec {run} -- {shlex.quote(inner)} || eval {shlex.quote(inner)}" if inner \
        else f"[ -x {py} ] && exec {run} || true"


def _inner_status(command: str) -> str | None:
    """The status line our wrapper runs ('' = standalone), or None when `command` is not ours."""
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if argv[:2] == ["[", "-x"] and argv[3:6] == ["]", "&&", "exec"]:
        argv = argv[6:]  # the guarded form _status writes
    elif "&&" in argv:
        return None
    if argv[1:2] == ["-P"]:
        del argv[1]
    if argv[1:3] != ["-m", "pengupool.statusline"]:
        return None  # someone else's, including another wrapper around ours
    return argv[argv.index("--") + 1] if "--" in argv[:-1] else ""


def _wrappable(line) -> bool:
    return isinstance(line, dict) and line.get("type", "command") == "command" \
        and isinstance(line.get("command"), str) and bool(line["command"].strip())


def status_wrapped(cfg: dict) -> bool:
    """The statusLine runs our wrapper (also inside another tool's wrapper, e.g. the workflow tracker's), or
    is one install leaves alone on purpose."""
    line = cfg.get("statusLine")
    return line is not None and (not _wrappable(line) or "pengupool.statusline" in line["command"])


def _wrap_status(cfg: dict) -> None:
    line = cfg.get("statusLine")
    if line is None:
        cfg["statusLine"] = {"type": "command", "command": _status("")}
        return
    if not _wrappable(line):
        return  # not a command we can wrap: leave it be rather than lose it
    inner = _inner_status(line["command"])
    if inner is None:
        inner = line["command"]
    line["command"] = _status(inner)  # re-pins a stale interpreter


def _unwrap_status(cfg: dict) -> None:
    line = cfg.get("statusLine")
    if not isinstance(line, dict) or not isinstance(line.get("command"), str):
        return
    inner = _inner_status(line["command"])
    if inner is None:
        return
    if inner:
        line["command"] = inner
    else:
        del cfg["statusLine"]


def uninstall(settings: Path = CLAUDE / "settings.json") -> None:
    if not settings.exists():
        return
    try:
        cfg = json.loads(settings.read_text())
    except ValueError as e:
        raise SystemExit(f"{settings} is not valid JSON ({e})")
    if not isinstance(cfg, dict):
        raise SystemExit(f"{settings} is not a JSON object")
    hooks = cfg.get("hooks", {})
    if not isinstance(hooks, dict):
        raise SystemExit(f"{settings}: 'hooks' is not an object")
    for event, entries in list(hooks.items()):
        if not isinstance(entries, list):
            continue
        kept = _without_ours(entries)
        if kept != entries:
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
    if not hooks:
        cfg.pop("hooks", None)
    _unwrap_status(cfg)
    write_json(settings, cfg)
    print(f"removed PenguPool lifecycle hooks → {settings}")


def install(settings: Path = CLAUDE / "settings.json") -> None:
    try:
        cfg = json.loads(settings.read_text()) if settings.is_file() else {}
    except ValueError as e:
        raise SystemExit(f"{settings} is not valid JSON ({e}); fix it before installing the hook")
    if not isinstance(cfg, dict):
        raise SystemExit(f"{settings} is not a JSON object")
    hooks = cfg.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SystemExit(f"{settings}: 'hooks' is not an object")
    for event in ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"):
        entries = hooks.get(event) if isinstance(hooks.get(event), list) else []
        # drop the old shell hook and any stale pengupool command (e.g. from another venv path)
        kept = _without_ours(entries)
        kept.append({"hooks": [{"type": "command", "command": CMD}]})
        if event == "PreToolUse":
            kept.append({"matcher": "SendMessage", "hooks": [{"type": "command", "command": GUARD}]})
        hooks[event] = kept
    _wrap_status(cfg)
    write_json(settings, cfg)  # atomic: a torn settings.json would break every Claude session
    print(f"installed session lifecycle hooks → {settings}\n  {CMD}")
    if "/.venv/" in sys.executable or "/venv/" in sys.executable:
        print("warning: the hook points at a project virtualenv; install with `make install` so it survives")
