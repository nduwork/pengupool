"""Exercise the installed tracker hook contract with real shell scripts."""
import json
import os
import subprocess
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'workflow-tracker/scripts'
# PenguPool exports a session id for the tools it manages, and the tracker falls back to it, so a test
# that inherited this session's id would key the fixtures to it. Tests start from a clean env.
CLEAN = {k: v for k, v in os.environ.items() if k not in ('PENGUPOOL_SESSION', 'STEP_STATUS_SESSION')}


def test_session_start_preserves_chain_and_reinjects_instructions(tmp_path):
    state = tmp_path / '.step-status'
    state.mkdir()
    (state / 'current').write_text('fix')
    (state / 'fix.state').write_text('active\tdiagnose\t\nplanned\tverify\t\n')
    for source in ('startup', 'resume', 'compact', 'clear'):
        result = subprocess.run(['bash', str(SCRIPTS / 'hook_session_start.sh')],
                                input=json.dumps({'cwd': str(tmp_path), 'source': source}),
                                text=True, capture_output=True, check=True, env=CLEAN)
        assert (state / 'fix.state').exists()
        assert 'diagnose' in result.stdout
        assert 'clear` when finished' not in result.stdout


def _tracked(tmp_path, session=None, chain='fix', step='diagnose'):
    """A repo with one chain: the shared tracker, or <session>'s own tracker when given."""
    state = tmp_path / '.step-status'
    if session:
        state = state / 'sessions' / session
    state.mkdir(parents=True)
    (state / 'current').write_text(chain)
    (state / f'{chain}.state').write_text(f'active\t{step}\t\nplanned\tverify\t\n')
    return state


def _hook(script, payload, env=None):
    return subprocess.run(['bash', str(SCRIPTS / script)], input=json.dumps(payload), text=True,
                          capture_output=True, check=True, env=env or CLEAN)


def test_prompt_hook_injects_the_sessions_own_chain(tmp_path):
    """Two sessions in one repo: each prompt line names that session's chain, not the other's."""
    _tracked(tmp_path, chain='shared-work', step='shared-step')
    _tracked(tmp_path, session='sess-1', chain='mine', step='my-step')
    mine = _hook('hook_prompt.sh', {'cwd': str(tmp_path), 'session_id': 'sess-1'}).stdout
    assert '[mine] my-step ●' in mine and 'shared-work' not in mine
    # no session id (a script, an older harness): the shared chain, as before session keying
    keyless = _hook('hook_prompt.sh', {'cwd': str(tmp_path)}).stdout
    assert '[shared-work] shared-step ●' in keyless and '[mine]' not in keyless


def test_session_start_exports_the_session_key(tmp_path, monkeypatch):
    """Claude Code's Bash tool only learns the session through $CLAUDE_ENV_FILE."""
    env_file = tmp_path / 'claude-env'
    env = {**os.environ, 'CLAUDE_ENV_FILE': str(env_file)}
    _tracked(tmp_path, session='sess-1', chain='mine', step='my-step')
    for _ in range(2):  # resume/clear re-run the hook: one line, not a growing file
        out = _hook('hook_session_start.sh', {'cwd': str(tmp_path), 'session_id': 'sess-1'}, env=env).stdout
        assert '[mine] my-step ●' in out
    assert env_file.read_text() == 'export STEP_STATUS_SESSION=sess-1\n'
    # a hostile id is never written into a file that gets sourced
    _hook('hook_session_start.sh', {'cwd': str(tmp_path), 'session_id': 'x; rm -rf /'}, env=env)
    _hook('hook_session_start.sh', {'cwd': str(tmp_path), 'session_id': '../evil'}, env=env)
    assert env_file.read_text() == 'export STEP_STATUS_SESSION=sess-1\n'


def test_the_pengupool_session_id_keys_a_harness_that_sends_none(tmp_path):
    """A pi extension that predates this tracker sends no session id. PenguPool's extension exports the
    same id for the session's tools, so the tracker still keys correctly; --shared still wins."""
    _tracked(tmp_path, chain='shared-work', step='shared-step')
    _tracked(tmp_path, session='sess-1', chain='mine', step='my-step')
    env = {**CLEAN, 'PENGUPOOL_SESSION': 'sess-1'}
    out = _hook('hook_prompt.sh', {'cwd': str(tmp_path)}, env=env).stdout
    assert '[mine] my-step ●' in out and 'shared-work' not in out
    env.pop('PENGUPOOL_SESSION')
    assert '[shared-work] shared-step ●' in _hook('hook_prompt.sh', {'cwd': str(tmp_path)}, env=env).stdout


def test_statusline_shows_the_sessions_chain(tmp_path):
    _tracked(tmp_path, chain='shared-work', step='shared-step')
    _tracked(tmp_path, session='sess-1', chain='mine', step='my-step')
    payload = {'workspace': {'current_dir': str(tmp_path)}, 'session_id': 'sess-1'}
    assert '[mine] my-step ●' in _hook('statusline.sh', payload).stdout
    payload.pop('session_id')
    assert '[shared-work] shared-step ●' in _hook('statusline.sh', payload).stdout
