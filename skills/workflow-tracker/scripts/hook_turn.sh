#!/usr/bin/env bash
# The tracker's guard for harnesses with Claude-style hooks (Claude Code, Codex): progress must not
# depend on the agent remembering to run steps.sh. Wired for:
#   PostToolUse      → steps.sh tick: counts the agent's work; every few calls, a reminder in context
#   Stop             → steps.sh audit: an active chain that saw work but never moved blocks the turn
#                      end once, with the reason, so the agent updates the tracker before it stops
#   UserPromptSubmit → (codex) the chain line or the nudge to set one, as hook_prompt.sh gives Claude
#
#   hook_turn.sh claude|codex   (the event JSON on stdin; prints the hook's JSON answer, never fails)
#
# Keying: the tracker must be the one the agent's own steps.sh calls use. Claude's SessionStart hook
# exports its session id to the agent's tools, so the payload's session_id is that key. Codex can't
# export to its tools, so its agent keys by PenguPool's id or the shared tracker, and so does this hook.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${1:-claude}"
INPUT="$(cat 2>/dev/null || true)"
IFS=$'\t' read -r EVENT CWD SESSION TOOL <<<"$(STEP_INPUT="$INPUT" python3 -c 'import json,os
try:
    d = json.loads(os.environ["STEP_INPUT"] or "{}")
    t = json.dumps(d.get("tool_input") or "")[:2000].replace("\t", " ")
    print("\t".join([d.get("hook_event_name") or "", d.get("cwd") or "", d.get("session_id") or "", t]))
except Exception:
    print("\t\t\t")' 2>/dev/null || true)"
[[ -n "$CWD" ]] && cd "$CWD" 2>/dev/null || exit 0
[[ "$HARNESS" == claude && -n "$SESSION" ]] && export STEP_STATUS_SESSION="$SESSION"
STEPS="$HERE/steps.sh"

# answer <json-object-python-expr> <text>: print the hook's JSON with the text safely quoted
answer() { STEP_TEXT="$2" python3 -c "import json,os; t=os.environ['STEP_TEXT']; print(json.dumps($1))"; }

case "$EVENT" in
  PostToolUse)
    out="$(bash "$STEPS" tick "$TOOL" 2>/dev/null)"
    [[ -n "$out" ]] && answer '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": t}}' "$out" ;;
  Stop)
    out="$(bash "$STEPS" audit 2>/dev/null)"
    [[ $? -eq 2 && -n "$out" ]] && answer '{"decision": "block", "reason": t}' "$out" ;;
  UserPromptSubmit)
    [[ "$HARNESS" == codex ]] || exit 0   # Claude has hook_prompt.sh wired for this
    out="$(STEP_HOOK_KEYED=1 bash "$HERE/hook_prompt.sh" <<<"$INPUT" 2>/dev/null)"
    [[ -n "$out" ]] && answer '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": t}}' "$out" ;;
esac
exit 0
