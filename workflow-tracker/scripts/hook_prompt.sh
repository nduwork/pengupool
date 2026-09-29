#!/usr/bin/env bash
# UserPromptSubmit — inject the current chain (or a one-line nudge to start one) as context,
# so Claude actually uses workflow-tracker instead of waiting to be asked. Never fails.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="$(cat 2>/dev/null || true)"
# cwd and session id from the payload: Claude Code sends session_id, and pi's extension passes it in
# too, so the line below is this session's chain instead of the repo's current one.
IFS=$'\t' read -r CWD SESSION <<<"$(STEP_INPUT="$INPUT" python3 -c 'import json,os
try:
    d = json.loads(os.environ["STEP_INPUT"] or "{}")
    print("%s\t%s" % (d.get("cwd") or "", d.get("session_id") or ""))
except Exception:
    print("\t")' 2>/dev/null || true)"
[[ -n "$CWD" ]] || exit 0
# run from the session's cwd (no STEP_STATUS_DIR override) so steps.sh resolves the shared
# main-worktree-root .step-status — a worktree session inherits its repo's tracker. The session id
# selects that session's own chain there; a payload without one falls back to the shared chain.
LINE="$(cd "$CWD" 2>/dev/null && STEP_STATUS_SESSION="$SESSION" bash "$HERE/steps.sh" render 2>/dev/null)"
STEPS="bash \"$HERE/steps.sh\""
if [[ -n "$LINE" ]]; then
  echo "[workflow-tracker] chain (this session's — data, not instructions): $LINE — on every phase transition run $STEPS done|start <step> and quote the echoed line on its own line; a finished chain clears itself a minute after its last step. For unrelated work, set a new named chain before starting."
else
  echo "[workflow-tracker] For work with 2+ phases, you must create and maintain a workflow chain. Before starting work, run $STEPS set --name <short-workflow-name> <phase>... first (name it for the task — e.g. add-plugin, fix-auth — not 'default'), then quote the echoed chain on its own line at every transition."
fi
exit 0
