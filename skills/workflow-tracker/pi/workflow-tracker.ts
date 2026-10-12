// workflow-tracker for pi (run as oh-my-pi): injects this session's chain into the system prompt.
// The chain is shown in PenguPool's map, so it is deliberately not drawn in pi's footer.
// Installed by `make install-tracker` into ~/.omp/agent/extensions/workflow-tracker.ts.
//
//  - the session id keys the tracker's state, so two sessions in one repo do not share a chain:
//    exported for the session's own tools (steps.sh reads STEP_STATUS_SESSION) and passed to the hook.
//    omp swaps the session under a live process (/new, /resume, /fork, a fork branch), so the key is
//    rebound on each of those events — that is when omp reads the env its tools spawn with
//  - before each prompt, hook_prompt.sh's line (this session's chain, or the nudge to set one) is
//    appended to the system prompt, like the UserPromptSubmit/SessionStart hooks
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
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
  // omp keeps the process and swaps the session under it on /new, /resume, /fork (`session_switch`) and
  // on a fork branch (`session_branch`); it captures the env its tools spawn with right after those
  // events. Setting the key only before a prompt would be too late for that capture, and the session's
  // own steps.sh calls would keep keying the previous session's tracker.
  const bind = (ctx: unknown): string => {
    const sessionId = sessionIdOf(ctx)
    if (sessionId) process.env.STEP_STATUS_SESSION = sessionId
    return sessionId
  }
  pi.on("session_start", async (_event, ctx) => { bind(ctx) })
  pi.on("session_switch", async (_event, ctx) => { bind(ctx) })
  pi.on("session_branch", async (_event, ctx) => { bind(ctx) })
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = bind(ctx)
    const line = await sh("hook_prompt.sh", [], ctx.cwd, JSON.stringify({ cwd: ctx.cwd, session_id: sessionId }))
    if (!line) return
    const sp: unknown = event.systemPrompt  // omp: string[] parts; plain pi: one string
    return { systemPrompt: Array.isArray(sp) ? [...sp, line] : `${sp}\n\n${line}` } as any
  })
}
