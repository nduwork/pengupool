// workflow-tracker for pi: injects this session's chain into the system prompt.
// The chain is shown in PenguPool's map, so it is deliberately not drawn in pi's footer.
// Installed by `make install-tracker` into ~/.pi/agent/extensions/workflow-tracker.ts.
//
//  - the session id keys the tracker's state, so two sessions in one repo do not share a chain:
//    exported for the session's own tools (steps.sh reads STEP_STATUS_SESSION) and passed to the hook
//  - before each prompt, hook_prompt.sh's line (this session's chain, or the nudge to set one) is
//    appended to the system prompt, like the UserPromptSubmit/SessionStart hooks
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import * as path from "node:path"

const BIN = process.env.STEP_STATUS_BIN || "__STEP_STATUS_BIN__"  // baked by make install-tracker
const sh = (script: string, args: string[], cwd: string, input = "") => new Promise<string>((resolve) => {
  const child = execFile("bash", [path.join(BIN, script), ...args], { cwd, timeout: 10000 },
    (e, out) => resolve(e ? "" : String(out).trim()))  // the tracker is optional: never break the turn
  child.stdin?.end(input)
})

// pi's session id, or "" when the context cannot say (an older pi, a test double). Without it the
// tracker falls back to the repo's shared chain, which is what it did before session keying.
function sessionIdOf(ctx: any): string {
  try { return String(ctx?.sessionManager?.getSessionId?.() || "") } catch { return "" }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = sessionIdOf(ctx)
    // pi spawns the session's tools from this process, so their bash inherits this env var: every
    // steps.sh call the agent makes then lands in this session's tracker, not the shared one
    if (sessionId) process.env.STEP_STATUS_SESSION = sessionId
    const line = await sh("hook_prompt.sh", [], ctx.cwd, JSON.stringify({ cwd: ctx.cwd, session_id: sessionId }))
    if (line) return { systemPrompt: `${event.systemPrompt}\n\n${line}` }
  })
}
