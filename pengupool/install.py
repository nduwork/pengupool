"""`pengupool setup auto|cc|pi|both` / `pengupool teardown …` / `pengupool setup --check …`.

`auto` (the default) means every harness whose CLI is installed, or Claude Code when neither is.

Setup makes sure everything the chosen harnesses need is present and wired: tmux, the agent CLI
(`claude`, `pi`), and PenguPool's own plugins — the Claude Code lifecycle hooks, or for pi the
pi-intercom package plus the PenguPool pi extension. A missing tmux or CLI is installed only after
a y/N prompt (declining prints the manual command and fails); PenguPool's own wiring needs no prompt.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import harness, hook, model

PI_PKG = "@earendil-works/pi-coding-agent"
# pi's own `engines`: node >=22.19.0. Debian 13 ships 20 and Ubuntu 24.04 ships 18, so a distro npm
# produces a pi that dies on import (`enableCompileCache` is a 22.3 API) if we install without looking.
PI_NODE = (22, 19)
CLI_INSTALL = {  # official installers (pi's is built by `_pi_install`: it may need a user prefix)
    "cc": "curl -fsSL https://claude.ai/install.sh | bash",
    "pi": f"npm install -g --ignore-scripts {PI_PKG}",
}


def _cli_install(h: str) -> str:
    """The install command to offer for a harness CLI."""
    return _pi_install() if h == "pi" else CLI_INSTALL[h]
# Which system package provides a tool, per manager. Debian and Arch have no package called `node`:
# they ship `nodejs` and `npm` separately, so `apt-get install -y node` fails with "Unable to locate
# package node" — which is what a Debian remote reported when `setup pi` offered to install npm.
PKG: dict[str, dict[str, str]] = {
    "brew": {"node": "node", "tmux": "tmux"},
    "apt-get": {"node": "nodejs npm", "tmux": "tmux"},
    "dnf": {"node": "nodejs", "tmux": "tmux"},
    "pacman": {"node": "nodejs npm", "tmux": "tmux"},
}
INTERCOM = "npm:pi-intercom"
EXTENSION = Path(__file__).with_name("pi_extension.ts")


def _settings() -> Path:
    return Path(os.environ.get("CLAUDE_SETTINGS", str(model.CLAUDE / "settings.json")))


def _pi_extension() -> Path:
    return harness.PI / "extensions" / "pengupool.ts"


def _confirm(question: str) -> bool:
    try:
        return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:  # non-interactive (CI, piped): never install system software unasked
        return False


def _npm_global_writable() -> bool:
    """Whether `npm install -g` can write to its global prefix. False on Debian/Ubuntu, where the
    system npm owns /usr/local, and on any host where npm has not been set up for this user."""
    try:
        probe = subprocess.run(["npm", "prefix", "-g"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    prefix = probe.stdout.strip() if probe.returncode == 0 else ""
    return bool(prefix) and os.access(prefix, os.W_OK)


def _pi_install() -> str:
    """`npm install -g <pi>` — into the user's own prefix when the global one needs root, which is the
    difference between `setup pi` working and ending in EACCES on a Debian or Ubuntu remote."""
    prefix = "" if _npm_global_writable() else '--prefix "$HOME/.local" '
    return f"npm install -g {prefix}--ignore-scripts {PI_PKG}"


def _node_version() -> tuple[int, int] | None:
    """(major, minor) of the node on PATH, or None when there is none to ask."""
    try:
        out = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v?(\d+)\.(\d+)", out.strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def _node_ok() -> bool:
    """Whether the node on PATH is new enough to run pi."""
    v = _node_version()
    return bool(v) and v >= PI_NODE


def _node_label() -> str:
    v = _node_version()
    return f"{v[0]}.{v[1]}" if v else "no node"


def _cli(h: str) -> str | None:
    """Path to a harness CLI: PATH first, then the user-global npm prefix, where pi lands when the
    global one is root-owned. Without this second look, `setup` would report pi missing and then fail
    to run it right after installing it."""
    name = harness.CLI[h]
    on_path = shutil.which(name)
    if on_path:
        return on_path
    fallback = Path.home() / ".local" / "bin" / name
    return str(fallback) if fallback.exists() else None


def _pkg_install(pkg: str) -> str:
    """Install command for a system package via the first package manager found ('' = none)."""
    for pm, cmd in (("brew", "brew install {}"), ("apt-get", "sudo apt-get install -y {}"),
                    ("dnf", "sudo dnf install -y {}"), ("pacman", "sudo pacman -S --noconfirm {}")):
        if shutil.which(pm):
            command = cmd.format(PKG[pm].get(pkg, pkg))
            # `apt-get install` never refreshes its package lists and a fresh box or slim container has
            # none, so it answers "Unable to locate package" for any name. Refresh first, best-effort:
            # a broken repo should not stop an install that cached lists could still satisfy. (dnf
            # refreshes metadata on its own; pacman's -Sy is discouraged, so neither is changed.)
            if pm == "apt-get":
                command = "sudo apt-get update -qq || true; " + command
            return command
    return ""


def ensure(name: str, binary: str, command: str) -> bool:
    """True when `binary` is on PATH, installing it with `command` after a y/N prompt if missing."""
    if shutil.which(binary):
        print(f"✓ {name}")
        return True
    print(f"checking {name}… missing")
    if not command:
        print(f"  install {name} with your package manager, then re-run")
        return False
    if _confirm(f"  install {name} with `{command}`?") and subprocess.run(["bash", "-c", command]).returncode == 0:
        if shutil.which(binary):
            print(f"✓ {name} installed")
        else:  # e.g. Claude's installer puts it in ~/.local/bin, which this shell may not have yet
            print(f"✓ {name} installed; open a new shell if `{binary}` is not on your PATH yet")
        return True
    print(f"  install it manually: {command}")
    return False


def _has_intercom() -> bool:
    exe = _cli("pi")
    if not exe:
        return False
    try:
        out = subprocess.run([exe, "list"], capture_output=True, text=True, timeout=30).stdout
    except OSError:
        return False
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "pi-intercom" in out


def _extension_source() -> str:
    """The pi extension with the absolute `pengupool` path baked in: pi may run without uv's tool bin
    on PATH (the Claude hook pins its interpreter the same way)."""
    cli = shutil.which("pengupool") or str(Path(sys.executable).with_name("pengupool"))
    return EXTENSION.read_text().replace('|| "pengupool"', "|| " + json.dumps(cli), 1)


def _unbaked(source: str) -> str:
    """The extension as shipped: whichever `pengupool` path setup baked in is not a difference."""
    return re.sub(r'(PENGUPOOL_CLI \|\| )"[^"]*"', r'\1"pengupool"', source, count=1)


def wire(h: str) -> bool:
    if h == "cc":
        hook.install(_settings())
        return True
    if not _has_intercom():
        print(f"installing pi-intercom ({INTERCOM}) — PenguPool sessions message each other through it")
        try:  # `pi` may sit in ~/.local/bin rather than on PATH: resolve it, do not assume
            rc = subprocess.run([_cli("pi") or harness.CLI["pi"], "install", INTERCOM]).returncode
        except OSError:
            rc = 1
        if rc != 0:
            print(f"  could not install pi-intercom: run `pi install {INTERCOM}` and re-run")
            return False
    target = _pi_extension()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_extension_source())
    print(f"installed PenguPool pi extension → {target}")
    return True


def unwire(h: str) -> None:
    if h == "cc":
        hook.uninstall(_settings())
        return
    target = _pi_extension()
    if target.exists():
        target.unlink()
        print(f"removed PenguPool pi extension → {target}")
    print(f"left pi-intercom installed (other tools may use it); remove it with `pi remove {INTERCOM}`")


def check(h: str) -> bool:
    exe = _cli(h)
    ok = bool(exe)
    where = "on PATH" if exe and shutil.which(harness.CLI[h]) else (f"at {exe}" if exe else "missing")
    print(f"{'✓' if ok else '✗'} {harness.CLI[h]} {where}")
    if h == "cc":
        try:
            text = _settings().read_text()
            wired = "pengupool.context" in text and "pengupool.routing" in text
        except OSError:
            wired = False
        print(f"{'✓' if wired else '✗'} Claude Code lifecycle hooks and SendMessage guard in {_settings()}")
        return ok and wired
    wired = _pi_extension().is_file() and _unbaked(_pi_extension().read_text()) == EXTENSION.read_text()
    print(f"{'✓' if wired else '✗'} PenguPool pi extension at {_pi_extension()}"
          + ("" if wired or not _pi_extension().is_file() else " (outdated: re-run setup)"))
    intercom = ok and _has_intercom()
    print(f"{'✓' if _node_ok() else '✗'} node {_node_label()} for pi (needs {PI_NODE[0]}.{PI_NODE[1]}+)")
    print(f"{'✓' if intercom else '✗'} pi-intercom installed")
    return ok and wired and intercom


def _harnesses(arg: str) -> list[str]:
    if arg in ("both", "all"):
        return list(harness.HARNESSES)
    if arg == "auto":  # a pi user who just runs `make install` must not end up with pi unwired
        return [h for h in harness.HARNESSES if _cli(h)] or ["cc"]
    return [harness.check(arg)]


def main(args: list[str]) -> int:
    verb, rest = args[0], args[1:]
    checking = "--check" in rest
    rest = [a for a in rest if a != "--check"]
    try:
        hs = _harnesses(rest[0] if rest else "auto")
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2
    if verb == "teardown":
        for h in hs:
            unwire(h)
        return 0
    if checking:
        ok = bool(shutil.which("tmux"))
        print(f"{'✓' if ok else '✗'} tmux on PATH")
        return 0 if all([check(h) for h in hs]) and ok else 1
    if not ensure("tmux", "tmux", _pkg_install("tmux")):
        return 1
    ok = True
    for h in hs:
        exe = _cli(h)                        # installed but off PATH (~/.local/bin) still counts
        if h == "pi" and not exe and not _node_ok():
            # Better to stop than to install a pi that cannot start: the npm install would "succeed"
            # and every later `pi` call would die with a SyntaxError about enableCompileCache.
            print(f"✗ pi needs node {PI_NODE[0]}.{PI_NODE[1]}+ and this host has {_node_label()}")
            print("  install a newer node (nvm, fnm, volta or NodeSource), then re-run: pengupool setup pi")
            ok = False
            continue
        if h == "pi" and exe and not _node_ok():
            print(f"  ! node {_node_label()} is older than {PI_NODE[0]}.{PI_NODE[1]}; "
                  "`pi --version` will say whether this build still runs")
        if h == "pi" and not exe \
                and not ensure("npm (needed to install pi)", "npm", _pkg_install("node")):
            ok = False
            continue
        if exe or ensure(f"{harness.LABEL[h]} ({harness.CLI[h]})", harness.CLI[h], _cli_install(h)):
            ok = wire(h) and ok
        else:
            ok = False
    return 0 if ok else 1
