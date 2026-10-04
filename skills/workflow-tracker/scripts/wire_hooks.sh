#!/usr/bin/env bash
# Wire (or unwire) the workflow-tracker hooks in Claude Code settings.json.
#
#   wire_hooks.sh              register SessionStart (keys the session) + UserPromptSubmit (injects the chain)
#   wire_hooks.sh --unwire     remove exactly those entries
#   wire_hooks.sh --selfcheck
#
# The chain shows in the conversation and on the PenguPool map, so the tracker no longer owns a status
# line. Both modes also take down the status line older versions wired (`bash "<here>/statusline.sh"
# [-- '<inner>']`), putting the inner command back, so an upgrade never leaves settings pointing at a
# deleted script. Settings path: $CLAUDE_SETTINGS (default ~/.claude/settings.json). Never rewrites a
# file it could not parse, and leaves every entry it did not write alone.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOME_DIR="${STEP_STATUS_HOME:-$HOME/.claude/step-status}"
case "${1-}" in
  "") MODE=wire ;; --unwire) MODE=unwire ;; --selfcheck) MODE=selfcheck ;;
  *) echo "usage: wire_hooks.sh [--unwire|--selfcheck]" >&2; exit 2 ;;
esac

selfcheck() {
  local d s; d="$(mktemp -d)"; s="${BASH_SOURCE[0]}"
  export STEP_STATUS_HOME="$d/home"
  fail() { echo "FAIL $1"; cat "$d"/*.json 2>/dev/null; exit 1; }
  # 1. malformed settings are never rewritten
  printf '{ "model": "opus", broken' > "$d/bad.json"; cp "$d/bad.json" "$d/bad.before"
  CLAUDE_SETTINGS="$d/bad.json" bash "$s" >/dev/null 2>&1 && fail "malformed accepted"
  cmp -s "$d/bad.json" "$d/bad.before" || fail "malformed rewritten"
  # 2. wire → idempotent → unwire is an exact round trip, and PenguPool's hooks on the same events stay
  python3 -c "import json;e={'hooks':[{'type':'command','command':'python -m pengupool.context'}]};json.dump({'permissions':{'allow':['Bash']},'statusLine':{'type':'command','command':'echo X'},'hooks':{'SessionStart':[e],'UserPromptSubmit':[e]}},open('$d/s.json','w'))"
  cp "$d/s.json" "$d/s.before"; export CLAUDE_SETTINGS="$d/s.json"
  bash "$s" | grep -q "SessionStart hook added" || fail wire
  bash "$s" | grep -q "already wired" || fail idempotent
  python3 -c "import json;d=json.load(open('$d/s.json'));h=d['hooks'];assert len(h['SessionStart'])==2 and len(h['UserPromptSubmit'])==2;assert h['SessionStart'][1]['matcher']=='startup|resume|clear|compact';assert 'matcher' not in h['UserPromptSubmit'][1];assert d['statusLine']['command']=='echo X'" || fail wired-shape
  bash "$s" --unwire | grep -q "removed 2 hook" || fail unwire
  python3 -c "import json,sys;sys.exit(json.load(open('$d/s.json'))!=json.load(open('$d/s.before')))" || fail round-trip
  # 3. a non-object entry in a hook-event list is left alone, not a crash
  printf '{"hooks":{"SessionStart":["junk",{"hooks":[]}]}}' > "$d/n.json"; export CLAUDE_SETTINGS="$d/n.json"
  bash "$s" --unwire >/dev/null 2>&1 || fail unwire-nonobject-crash
  python3 -c "import json;assert 'junk' in json.load(open('$d/n.json'))['hooks']['SessionStart']" || fail unwire-nonobject-preserved
  # 4. the status line an older version wired comes down: wrapped → its inner command, standalone → gone
  HERE="$HERE" python3 -c "import json,os;json.dump({'statusLine':{'type':'command','command':'bash \"'+os.environ['HERE']+'/statusline.sh\" -- \'echo X\'','padding':0}},open('$d/w.json','w'))"
  mkdir -p "$STEP_STATUS_HOME"; echo '{}' > "$STEP_STATUS_HOME/prev-statusline.json"
  CLAUDE_SETTINGS="$d/w.json" bash "$s" | grep -q "status line restored: echo X" || fail old-wrapped
  python3 -c "import json;assert json.load(open('$d/w.json'))['statusLine']=={'type':'command','command':'echo X'}" || fail old-wrapped-shape
  [[ -e "$STEP_STATUS_HOME/prev-statusline.json" ]] && fail prev-left
  HERE="$HERE" python3 -c "import json,os;json.dump({'statusLine':{'type':'command','command':'bash \"'+os.environ['HERE']+'/statusline.sh\"'}},open('$d/t.json','w'))"
  CLAUDE_SETTINGS="$d/t.json" bash "$s" --unwire | grep -q "status line removed" || fail old-standalone
  [[ "$(python3 -c "import json;print(json.load(open('$d/t.json')))")" == "{}" ]] || fail old-standalone-clean
  # 5. another install's status line is not ours
  printf '{"statusLine":{"type":"command","command":"bash \\"/elsewhere/bin/statusline.sh\\""}}' > "$d/f.json"; cp "$d/f.json" "$d/f.before"
  CLAUDE_SETTINGS="$d/f.json" bash "$s" --unwire >/dev/null || fail foreign
  python3 -c "import json,sys;sys.exit(json.load(open('$d/f.json'))!=json.load(open('$d/f.before')))" || fail foreign-touched
  rm -rf "$d"; echo "selfcheck OK"
}
[[ "$MODE" == selfcheck ]] && { selfcheck; exit 0; }

HERE="$HERE" SETTINGS="$SETTINGS" MODE="$MODE" PREV="$HOME_DIR/prev-statusline.json" python3 - <<'PY'
import json, os, shlex, sys
settings, here, mode, prev = (os.environ[k] for k in ("SETTINGS", "HERE", "MODE", "PREV"))
data = {}
if os.path.exists(settings):
    with open(settings) as f: raw = f.read()
    if raw.strip():
        try: data = json.loads(raw)
        except Exception as e: sys.exit(f"workflow-tracker: refusing to rewrite {settings}: not valid JSON ({e})")
if not isinstance(data, dict): sys.exit(f"workflow-tracker: {settings} is not a JSON object")
hooks = data.get("hooks")
if not isinstance(hooks, dict): hooks = {}
data["hooks"] = hooks
notes = []
HOOKS = (("SessionStart", "hook_session_start.sh", "startup|resume|clear|compact"), ("UserPromptSubmit", "hook_prompt.sh", None))
def ours(cmd, script): return f'"{here}/{script}"' in cmd          # exactly this install (AGENTS.md: only touch our own entries)

# The status line older versions wired: only a command that starts with our own script is ours.
sl = data.get("statusLine")
cmd = sl.get("command") if isinstance(sl, dict) else None
if isinstance(cmd, str) and cmd.startswith(f'bash "{here}/statusline.sh"'):
    parts = shlex.split(cmd)
    inner = parts[parts.index("--") + 1] if "--" in parts[:-1] else ""
    if inner:
        data["statusLine"] = {"type": "command", "command": inner}; notes.append(f"status line restored: {inner}")
    else:
        del data["statusLine"]; notes.append("status line removed")
if os.path.exists(prev): os.remove(prev)

if mode == "wire":
    for event, script, matcher in HOOKS:
        groups = hooks.get(event) if isinstance(hooks.get(event), list) else []
        hooks[event] = groups
        mine = [g for g in groups if isinstance(g, dict) and any(isinstance(h, dict) and ours(h.get("command") or "", script) for h in g.get("hooks", []))]
        for g in mine:          # upgrade the matcher of our existing hook without duplicating it
            if matcher: g["matcher"] = matcher
        if not mine:
            entry = {"hooks": [{"type": "command", "command": f'bash "{here}/{script}"', "timeout": 10}]}
            groups.append({"matcher": matcher, **entry} if matcher else entry)
            notes.append(f"{event} hook added")
    notes = notes or ["already wired"]
else:
    removed = 0
    for ev in list(hooks):
        kept_groups = []
        for g in hooks[ev] if isinstance(hooks[ev], list) else []:
            if not isinstance(g, dict): kept_groups.append(g); continue   # leave foreign entries untouched
            kept = [h for h in g.get("hooks", []) if not (isinstance(h, dict) and any(ours(h.get("command") or "", s) for _, s, _ in HOOKS))]
            removed += len(g.get("hooks", [])) - len(kept)
            if kept: g["hooks"] = kept; kept_groups.append(g)
        if kept_groups: hooks[ev] = kept_groups
        else: del hooks[ev]
    notes.append(f"removed {removed} hook(s)")
if not hooks: data.pop("hooks", None)
os.makedirs(os.path.dirname(settings) or ".", exist_ok=True)
tmp = settings + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2); f.write("\n")
os.replace(tmp, settings)
print("workflow-tracker: " + "; ".join(notes))
PY
