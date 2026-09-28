import subprocess
import sys


def run(*args):
    return subprocess.run([sys.executable, "-m", "pengupool.cli", *args], capture_output=True, text=True)


def test_help_prints_usage():
    for flag in ("--help", "-h", "help"):
        r = run(flag)
        assert r.returncode == 0 and "usage: pengupool" in r.stdout and "serve" in r.stdout


def test_bare_command_and_tui_print_usage_and_fail():
    """The terminal UI is gone: neither the bare command nor `tui` launches anything any more."""
    for args in ([], ["tui"]):
        r = run(*args)
        assert r.returncode == 2 and "usage: pengupool" in r.stdout
        assert "terminal UI" not in r.stdout


def test_unknown_command_prints_help_and_fails():
    r = run("bogus")
    assert r.returncode == 2 and "usage: pengupool" in r.stdout
