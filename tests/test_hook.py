"""PenguPool and workflow-tracker hooks coexist on shared Claude events."""
import json
import subprocess

from pengupool import hook


def _tracker(script: str, matcher: str | None = None) -> dict:
    entry = {"hooks": [{"type": "command", "command": f'bash "/stable/{script}"'}]}
    if matcher:
        entry["matcher"] = matcher
    return entry


def test_install_preserves_tracker_hooks_and_is_idempotent(tmp_path):
    settings = tmp_path / "settings.json"
    tracker_start = _tracker("hook_session_start.sh", "startup|clear")
    tracker_prompt = _tracker("hook_prompt.sh")
    settings.write_text(json.dumps({"hooks": {
        "SessionStart": [tracker_start],
        "UserPromptSubmit": [tracker_prompt],
    }}))

    hook.install(settings)
    hook.install(settings)

    installed = json.loads(settings.read_text())["hooks"]
    for event in ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
                  "PermissionRequest", "Stop"):
        commands = [h.get("command", "") for group in installed[event]
                    for h in group.get("hooks", [])]
        assert sum("pengupool.context" in command for command in commands) == 1
    assert tracker_start in installed["SessionStart"]
    assert tracker_prompt in installed["UserPromptSubmit"]


def test_uninstall_preserves_other_hooks_in_shared_group(tmp_path):
    settings = tmp_path / 'settings.json'
    foreign = {'type': 'command', 'command': 'echo keep'}
    settings.write_text(json.dumps({'permissions': {'allow': []}, 'hooks': {
        'SessionStart': [{'matcher': 'startup', 'hooks': [
            {'type': 'command', 'command': hook.CMD}, foreign]}]}}))
    hook.uninstall(settings)
    assert json.loads(settings.read_text()) == {'permissions': {'allow': []}, 'hooks': {
        'SessionStart': [{'matcher': 'startup', 'hooks': [foreign]}]}}
    hook.install(settings)
    hook.uninstall(settings)
    assert json.loads(settings.read_text())['hooks']['SessionStart'][0]['hooks'] == [foreign]


def test_hook_round_trip_preserves_settings(tmp_path):
    settings = tmp_path / 'settings.json'
    original = {'statusLine': {'command': 'echo keep'}}
    settings.write_text(json.dumps(original))
    hook.install(settings)
    hook.uninstall(settings)
    hook.uninstall(settings)
    assert json.loads(settings.read_text()) == original


def test_install_wraps_the_status_line_and_uninstall_restores_it(tmp_path):
    settings = tmp_path / 'settings.json'
    original = {'type': 'command', 'command': "npx -y ccstatusline@latest", 'padding': 0, 'refreshInterval': 10}
    settings.write_text(json.dumps({'statusLine': original}))
    hook.install(settings)
    hook.install(settings)  # idempotent: never wraps its own wrapper
    line = json.loads(settings.read_text())['statusLine']
    assert line == {**original, 'command': hook._status('npx -y ccstatusline@latest')}
    hook.uninstall(settings)
    assert json.loads(settings.read_text())['statusLine'] == original


def test_install_adds_a_silent_status_line_when_none_is_set(tmp_path):
    settings = tmp_path / 'settings.json'
    hook.install(settings)
    assert json.loads(settings.read_text())['statusLine'] == {'type': 'command', 'command': hook._status('')}
    hook.uninstall(settings)
    assert 'statusLine' not in json.loads(settings.read_text())


def test_install_repins_a_stale_wrapper_and_leaves_an_outer_wrapper_alone(tmp_path):
    settings = tmp_path / 'settings.json'
    stale = "/old/venv/bin/python -m pengupool.statusline -- 'echo hi'"
    settings.write_text(json.dumps({'statusLine': {'type': 'command', 'command': stale}}))
    hook.install(settings)
    assert json.loads(settings.read_text())['statusLine']['command'] == hook._status('echo hi')
    outer = f'bash "/stable/statusline.sh" -- {hook.shlex.quote(hook._status(""))}'
    settings.write_text(json.dumps({'statusLine': {'type': 'command', 'command': outer}}))
    hook.uninstall(settings)
    assert json.loads(settings.read_text())['statusLine']['command'] == outer


def test_the_wrapper_falls_back_to_the_users_line_when_its_interpreter_is_gone(tmp_path, monkeypatch):
    for py, ok in ((hook.sys.executable, True), ('/gone/venv/bin/python', False)):
        monkeypatch.setattr(hook.sys, 'executable', py)
        out = subprocess.run(['sh', '-c', hook._status('cat; echo " | $HOME"')], input='{}',
                                  capture_output=True, text=True, env={'HOME': '/h', 'PATH': '/usr/bin:/bin',
                                                                       'PENGUPOOL_HOME': str(tmp_path)})
        assert out.stdout == '{} | /h\n', (py, out.stderr)  # same line with or without PenguPool
        assert hook._inner_status(hook._status('cat; echo " | $HOME"')) == 'cat; echo " | $HOME"'


def test_install_leaves_an_empty_or_odd_status_line_alone(tmp_path):
    settings = tmp_path / 'settings.json'
    for odd in ({'type': 'command', 'command': '', 'padding': 2}, 'not-a-dict'):
        settings.write_text(json.dumps({'statusLine': odd}))
        hook.install(settings)
        assert json.loads(settings.read_text())['statusLine'] == odd
        hook.uninstall(settings)
        assert json.loads(settings.read_text())['statusLine'] == odd


def test_a_pengupool_folder_in_the_project_cannot_blank_the_line(tmp_path):
    (tmp_path / 'pengupool').mkdir()
    (tmp_path / 'pengupool' / '__init__.py').write_text('')  # e.g. this repo at a commit before the wrapper
    out = subprocess.run(['sh', '-c', hook._status('echo line')], input='{}', cwd=tmp_path,
                         capture_output=True, text=True, env={'PATH': '/usr/bin:/bin', 'PENGUPOOL_HOME': str(tmp_path)})
    assert out.stdout == 'line\n', out.stderr


def test_setup_check_accepts_a_status_line_install_leaves_alone():
    assert hook.status_wrapped({'statusLine': {'type': 'command', 'command': hook._status('x')}})
    assert hook.status_wrapped({'statusLine': {'type': 'command', 'command': '', 'padding': 2}})
    assert hook.status_wrapped({'statusLine': {'type': 'command', 'command': "/py -m pengupool.statusline -- 'x'"}})
    outer = f'bash "$HOME/.claude/step-status/bin/statusline.sh" -- {hook.shlex.quote(hook._status(""))}'
    assert hook.status_wrapped({'statusLine': {'type': 'command', 'command': outer}})  # the tracker wraps ours
    assert not hook.status_wrapped({'statusLine': {'type': 'command', 'command': 'npx ccstatusline'}})
    assert not hook.status_wrapped({})
