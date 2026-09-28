"""Disposable real tmux servers: never connect to the user's named sockets."""
import shutil
import subprocess
import tempfile
import time

import pytest

from pengupool import ctl, harness, model, tmux


@pytest.fixture
def servers(monkeypatch):
    if not shutil.which("tmux"):
        pytest.skip("tmux is not installed")
    # Keep paths below the Unix socket length limit, including on macOS.
    directory = tempfile.TemporaryDirectory(prefix="pp-review-", dir="/tmp")
    sockets = [directory.name + "/shared", directory.name + "/external", directory.name + "/pi"]

    def run(socket, *args):
        return subprocess.run(["tmux", "-S", socket, *args], capture_output=True, text=True, timeout=5)

    try:
        for socket in sockets:
            result = run(socket, "-f", "/dev/null", "new-session", "-d", "-s", "pengupool", "sleep 120")
            if result.returncode or result.stderr:
                pytest.skip(f"cannot start disposable tmux server: {result.stderr.strip()}")
        by_harness = {"cc": sockets[0], "pi": sockets[2]}  # one disposable server per harness, like -L
        monkeypatch.setattr(tmux, "_user", lambda *args, h="cc": ["tmux", "-S", by_harness[h], *args])
        monkeypatch.setattr(tmux, "_CACHE", {})
        yield sockets, run
    finally:
        for socket in sockets:
            run(socket, "kill-server")
        directory.cleanup()


def test_cross_server_collision_cannot_attach_or_kill_unrelated_session(servers, monkeypatch):
    (shared, external, _), run = servers
    pid = int(run(external, "display-message", "-p", "-t", "%0", "#{pane_pid}").stdout)
    monkeypatch.setattr(ctl, "_index", lambda: ({"external": "%0"}, {"external": {"pid": pid}}))
    assert ctl.main(["attach", "external", "worker"]) == 2
    assert ctl.main(["close", "external"]) == 0
    assert run(shared, "has-session", "-t", "=pengupool").returncode == 0


@pytest.mark.parametrize("h, args", [("cc", ["--teammate-mode", "in-process", "--name", "worker", "--resume", "abcdef12-0000"]),
                                     ("pi", ["--session", "abcdef12-0000"])])
def test_adopt_resumes_with_its_harness_on_its_own_server(servers, monkeypatch, tmp_path, capsys, h, args):
    (shared, _, pi), run = servers
    sid = "abcdef12-0000"
    marker = tmp_path / "launch-args.txt"
    launcher = tmp_path / f"fake-{h}"
    launcher.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{marker}'\nsleep 120\n")
    launcher.chmod(0o755)
    monkeypatch.setitem(harness.CLI, h, str(launcher))
    outside = subprocess.Popen(["sleep", "120"])
    monkeypatch.setattr(ctl, "_index", lambda: ({}, {sid: {
        "sessionId": sid, "name": "worker", "cwd": str(tmp_path), "pid": outside.pid, "harness": h,
    }}))
    monkeypatch.setattr(model, "resumable_transcript", lambda *args, **k: True)
    monkeypatch.setattr(tmux, "view_command", lambda pane, name, *a: f"VIEW {pane}")
    try:
        assert ctl.main(["adopt", sid, ""]) == 0
        assert outside.wait(timeout=3) == -15
        for _ in range(20):
            if marker.exists():
                break
            time.sleep(0.1)
        assert marker.read_text().splitlines() == args
        pane = capsys.readouterr().out.strip().split()[-1]
        own, other = (shared, pi) if h == "cc" else (pi, shared)
        assert str(launcher) in run(own, "display-message", "-p", "-t", pane, "#{pane_start_command}").stdout
        assert str(launcher) not in run(other, "list-panes", "-a", "-F", "#{pane_start_command}").stdout
    finally:
        if outside.poll() is None:
            outside.terminate()
            outside.wait(timeout=3)


def test_one_extension_view_switches_between_windows(servers):
    (shared, _, _), run = servers
    second = run(shared, "new-window", "-d", "-P", "-F", "#{pane_id}",
                 "-t", "pengupool:", "sleep 120").stdout.strip()
    run(shared, "new-session", "-d", "-s", "pv-ext-editor-1", "-t", "pengupool")
    assert tmux.select_view(second, "editor-1")
    selected = run(shared, "display-message", "-p", "-t", "pv-ext-editor-1", "#{window_id}").stdout.strip()
    target = run(shared, "display-message", "-p", "-t", second, "#{window_id}").stdout.strip()
    assert selected == target


def test_a_wobbly_click_does_not_copy_but_a_real_selection_does(servers, monkeypatch):
    """A click that moves a pixel is a 1-character drag: it must not replace the user's clipboard."""
    (shared, _, _), run = servers
    monkeypatch.setattr(tmux, "_copy_ready", set())
    tmux.enable_mouse_copy("cc")
    bound = run(shared, "list-keys", "-T", "copy-mode").stdout
    assert "MouseDragEnd1Pane" in bound and "if-shell" in bound and "send-keys -X cancel" in bound
    pane = run(shared, "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "pengupool:",
               "printf 'hello world\\nsecond line\\n'; sleep 120").stdout.strip()

    def copies(*moves):
        run(shared, "copy-mode", "-t", pane)
        run(shared, "send-keys", "-t", pane, "-X", "top-line")
        run(shared, "send-keys", "-t", pane, "-X", "start-of-line")
        run(shared, "send-keys", "-t", pane, "-X", "begin-selection")
        for m in moves:
            run(shared, "send-keys", "-t", pane, "-X", m)
        got = run(shared, "display-message", "-p", "-t", pane, tmux.MIN_SELECTION).stdout.strip()
        run(shared, "send-keys", "-t", pane, "-X", "cancel")
        return got == "1"

    assert not copies()                             # a click that moved inside one character
    assert copies("cursor-right")                   # two characters
    assert copies("cursor-down")                    # across lines
    run(shared, "copy-mode", "-t", pane)
    run(shared, "send-keys", "-t", pane, "-X", "top-line")
    run(shared, "send-keys", "-t", pane, "-X", "end-of-line")
    run(shared, "send-keys", "-t", pane, "-X", "begin-selection")
    run(shared, "send-keys", "-t", pane, "-X", "cursor-left")
    assert run(shared, "display-message", "-p", "-t", pane, tmux.MIN_SELECTION).stdout.strip() == "1"  # leftward


@pytest.fixture
def attached_client():
    """Attach a real tmux client on its own pty, at an exact size. The disposable servers have no
    clients, and a control-mode client reports no height, so a pty is the only honest way to test two
    editor windows of different sizes."""
    pty = pytest.importorskip("pty")
    import fcntl
    import os
    import signal
    import struct
    import termios

    live: list[tuple[int, int]] = []

    def attach(shared: str, session: str, cols: int, rows: int) -> int:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        pid = os.fork()
        if pid == 0:
            os.setsid()
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            os.execvp("tmux", ["tmux", "-S", shared, "attach", "-t", session])
            os._exit(127)  # only reached if execvp failed
        os.close(slave)
        live.append((pid, master))
        return pid

    yield attach
    for pid, master in live:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(master)


def test_a_switch_leaves_a_window_another_client_is_displaying_alone(servers, attached_client, monkeypatch):
    """Grouped views share their windows, so a window another editor displays is off screen only for the
    client that is switching: sizing it to that client would repaint the other editor's terminal."""
    (shared, _, _), run = servers
    for _ in range(3):
        run(shared, "new-window", "-d", "-t", "pengupool:", "sleep", "120")
    windows = {index: win for win, index in (line.split("\t") for line in run(
        shared, "list-windows", "-t", "pengupool", "-F", "#{window_id}\t#{window_index}").stdout.splitlines() if line)}
    shown, target, unseen = windows["1"], windows["2"], windows["3"]
    for view, win in (("editor-a", shown), ("editor-b", target)):
        run(shared, "new-session", "-d", "-s", f"pv-ext-{view}", "-t", "pengupool")
        run(shared, "set-option", "-t", f"pv-ext-{view}", "status", "off")
        run(shared, "select-window", "-t", f"pv-ext-{view}:{win}")
    attached_client(shared, "pv-ext-editor-a", 100, 30)   # the client that switches
    attached_client(shared, "pv-ext-editor-b", 60, 20)    # the client already looking at the target

    def wait_for(view: str, size: str) -> None:
        for _ in range(50):
            if f"{view} {size}" in run(shared, "list-clients", "-F", "#{client_session} #{client_width}x#{client_height}").stdout:
                return
            time.sleep(0.1)
        pytest.fail(f"{view} never attached at {size}")

    wait_for("pv-ext-editor-a", "100x30")
    wait_for("pv-ext-editor-b", "60x20")
    size_of = lambda win: run(shared, "display-message", "-p", "-t", win, "#{window_width}x#{window_height}").stdout.strip()
    pane_of = lambda win: run(shared, "list-panes", "-t", win, "-F", "#{pane_id}").stdout.strip()
    assert size_of(target) == "60x20"              # the client displaying it owns its size

    issued: list[tuple] = []
    real_ok = tmux._ok
    monkeypatch.setattr(tmux, "_ok", lambda *a, **k: (issued.append(a), real_ok(*a, **k))[1])

    def resized() -> list[tuple]:
        got = [call for call in issued if call[0] == "resize-window"]
        issued.clear()
        return got

    assert target in tmux.shown_windows()          # who displays what, read from a live server
    assert tmux.select_view(pane_of(target), "editor-a")
    assert resized() == []                         # B is looking at it: we stay out of the way
    assert run(shared, "display-message", "-p", "-t", "pv-ext-editor-a", "#{window_id}").stdout.strip() == target
    # tmux still sizes the shared window to the switching client here, because A's select makes A the
    # latest client and the window has one size. That is inherent to two clients of different sizes
    # sharing a window — the alternative (`window-size largest`) crops the smaller client instead.

    # A window nobody displays is still sized to the switching client before it appears (PR #37).
    assert tmux.select_view(pane_of(unseen), "editor-a")
    assert [call[1:3] for call in resized()] == [("-t", f"pv-ext-editor-a:{unseen}")]
    assert size_of(unseen) == "100x30"
