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
//  - the guard, as hook_turn.sh is for Claude and Codex: each tool result ticks steps.sh (a reminder is
//    appended to the result every few calls), and when the agent ends a turn with an active chain that
//    saw work but never moved, steps.sh audit's reason starts one more turn to bring it up to date
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { execFile } from "node:child_process"
import * as path from "node:path"

const BIN = process.env.STEP_STATUS_BIN || "__STEP_STATUS_BIN__"  // baked by make install-tracker
const sh = (script: string, args: string[], cwd: string, input = "") => new Promise<string>((resolve) => {
  const child = execFile("bash", [path.join(BIN, script), ...args], { cwd, timeout: 10000 },
    (e, out) => resolve(e ? "" : String(out).trim()))  // the tracker is optional: never break the turn
  child.stdin?.end(input)
})

// run: steps.sh with its exit code, for the guard (audit answers 2 with the reason on stdout).
const run = (args: string[], cwd: string) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile("bash", [path.join(BIN, "steps.sh"), ...args], { cwd, timeout: 10000 },
    (e: any, out) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out ?? "").trim() }))
})

// pi's session id, or "" when the context cannot say (an older pi, a test double). Without it the
// tracker falls back to the repo's shared chain, which is what it did before session keying.
function sessionIdOf(ctx: any): string {
  try { return String(ctx?.sessionManager?.getSessionId?.() || "") } catch { return "" }
}

// A subagent (omp runs this extension for each, in the session's process) or a one-shot run is not the
// session. Its own id has no chain, so the nudge would have it run `steps.sh set`, and its shell keys the
// session's tracker (omp refreshes the spawn env only for the main agent), so that overwrites the session's chain.
// The same rule as `pooled` in pengupool/pi_extension.ts: the two extensions load apart, so keep them in step.
const ownSession = (ctx: any): boolean => ctx?.agent?.kind !== "sub" && ctx?.mode !== "print" && ctx?.mode !== "json"

export default function (pi: ExtensionAPI) {
  // omp keeps the process and swaps the session under it on /new, /resume, /fork (`session_switch`) and
  // on a fork branch (`session_branch`); it captures the env its tools spawn with right after those
  // events. Setting the key only before a prompt would be too late for that capture, and the session's
  // own steps.sh calls would keep keying the previous session's tracker.
  const bind = (ctx: unknown): string => {
    if (!ownSession(ctx)) return ""
    const sessionId = sessionIdOf(ctx)
    if (sessionId) process.env.STEP_STATUS_SESSION = sessionId
    return sessionId
  }
  pi.on("session_start", async (_event, ctx) => { bind(ctx) })
  pi.on("session_switch", async (_event, ctx) => { bind(ctx) })
  pi.on("session_branch", async (_event, ctx) => { bind(ctx) })
  pi.on("before_agent_start", async (event, ctx) => {
    if (!ownSession(ctx)) return
    const sessionId = bind(ctx)
    const line = await sh("hook_prompt.sh", [], ctx.cwd, JSON.stringify({ cwd: ctx.cwd, session_id: sessionId }))
    if (!line) return
    const sp: unknown = event.systemPrompt  // omp: string[] parts; plain pi: one string
    return { systemPrompt: Array.isArray(sp) ? [...sp, line] : `${sp}\n\n${line}` } as any
  })
  pi.on("tool_result", async (event: any, ctx) => {
    const { out } = await run(["tick", JSON.stringify(event.input ?? "").slice(0, 2000)], ctx.cwd)
    if (out) return { content: [...(event.content ?? []), { type: "text", text: out }] } as any
  })
  pi.on("agent_end", async (_event, ctx: any) => {
    if (ctx?.hasPendingMessages?.()) return  // the owner has queued the next prompt: its turn ends later
    const { code, out } = await run(["audit"], ctx.cwd)
    // omp starts a nextTurn message's turn at once; plain pi queues it for the owner's next prompt and
    // ignores triggerTurn, so `make install-tracker` drops the deliverAs from the plain pi copy.
    if (code === 2 && out) pi.sendMessage({ customType: "workflow-tracker", content: out, display: true } as any, { deliverAs: "nextTurn", triggerTurn: true })
  })
}
