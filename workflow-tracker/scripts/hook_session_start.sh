#!/usr/bin/env bash
# SessionStart: keep the tracking instructions in the session's context, and tell the session's own
# tools which session they are, so the tracker's state stays per session. Never erases a chain.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="$(cat 2>/dev/null || true)"
# Claude Code hands hooks $CLAUDE_ENV_FILE: an export appended there reaches this session's Bash tool,
# which is how steps.sh calls made by the agent itself get the session key (pi doesn't need this: its
# extension puts the key in the environment the tools inherit).
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  SID="$(STEP_INPUT="$INPUT" python3 -c 'import json,os
try: print(json.loads(os.environ["STEP_INPUT"] or "{}").get("session_id") or "")
except Exception: print("")' 2>/dev/null || true)"
  case "$SID" in *[!A-Za-z0-9._-]*) SID="" ;; esac   # the id becomes a shell word and a directory name
  SID="${SID:0:64}"
  # append once per session id: resume/clear re-run this hook, and the file must not grow forever
  if [[ -n "$SID" ]] && { [[ ! -f "$CLAUDE_ENV_FILE" ]] || ! grep -qF "export STEP_STATUS_SESSION=$SID" "$CLAUDE_ENV_FILE" 2>/dev/null; }; then
    printf 'export STEP_STATUS_SESSION=%s\n' "$SID" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true
  fi
fi
exec bash "$HERE/hook_prompt.sh" <<<"$INPUT"
