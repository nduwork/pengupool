// PenguPool pi extension: makes this oh-my-pi (omp) session look to PenguPool exactly like a Claude Code
// session. Installed by `pengupool setup pi` into ~/.omp/agent/extensions/pengupool.ts.
//
//  - ~/.pengupool/pi-sessions/<pid>.json   live-session file, same shape as ~/.claude/sessions/*.json
//  - ~/.pengupool/registry.jsonl           session -> tmux pane line, like the Claude SessionStart hook
//  - ~/.pengupool/context/<sid>.json       % of the context window in use, like Claude's status line
//  - ~/.pengupool/profiles/<sid>.json       workspace profile, via `pengupool ctl register` at start
//  - before each prompt, `pengupool ctl context <sid>` is appended to the system prompt: where this
//    session sits in its PenguPool tree and who it may message with pi-intercom (plus any session the
//    user @-tagged in that prompt)
//  - every intercom send/ask/handover goes through `pengupool ctl authorize` first; a non-adjacent
//    target blocks it; PenguPool failing to answer does not (the same rule Claude's SendMessage guard
//    applies)
//  - omp has no --name flag: `ctl new` passes the name in PENGUPOOL_SESSION_NAME and the first start sets it
//  - a process that comes to host another session (`/new`, `/resume`, `/fork`, a fork branch) is rebound
//    from scratch — live file, profile, registry line, env — so the pool never points at the old one.
//    `/new` is pi's fresh context, like Claude's /clear: `ctl carry` hands the new id the old one's group
//    and role, and the new session takes the old one's name
//  - a subagent (task tool, eval `agent()`, `/tan` clone) runs in the same process, and omp rebinds this
//    extension to its session too. It is not a pool session: it never takes over the live file, registry,
//    profile or env, and its end does not remove them. Its intercom sends are checked as the session's own.
//  - a one-shot run (`omp -p`, `--mode json`) is not a pool session either: it registers nothing. Its
//    intercom sends are checked as the pool session whose process tree it runs in, which `ctl authorize`
//    finds itself: the PENGUPOOL_SESSION it inherited is only a hint, since the agent that started it
//    could have unset or rewritten it.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { execFile } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const HOME = process.env.PENGUPOOL_HOME || path.join(os.homedir(), ".pengupool")
const LIVE = path.join(HOME, "pi-sessions", `${process.pid}.json`)
const CLI = process.env.PENGUPOOL_CLI || "pengupool"
// Proves to `ctl context` that a prompt is the user's (its @tags may grant a direct line). It lives only in
// this process and goes to ctl on stdin, never in env or argv, so tools the agent runs can't see it.
const GRANT_KEY = crypto.randomBytes(24).toString("hex")
const run = (args: string[], input = "") => new Promise<{ code: number; out: string; err: string }>((resolve) => {
  const child = execFile(CLI, args, { timeout: 3000 }, (e: any, out, err) =>
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out).trim(), err: String(err).trim() }))
  // a CLI that exits before reading its input closes the pipe: EPIPE here would be uncaught and end omp.
  // The exit status still reaches the callback above, so the failure is reported there.
  child.stdin?.on("error", () => {})
  child.stdin?.end(input)
})
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function writeJson(file: string, data: unknown): void {
  // atomic, like model.write_json: PenguPool polls these files and must never read a torn one
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${path.dirname(file)}/.${path.basename(file)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  } catch {
    // PenguPool is optional: never break the pi session over its bookkeeping
  }
}

// `ps lstart`-style UTC start time, so PenguPool can tell a recycled pid from this process
function procStart(): string {
  const d = new Date(Date.now() - process.uptime() * 1000)
  const t = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${t} ${d.getUTCFullYear()}`
}

// The parts of omp's ExtensionContext this extension reads, so `bind` is checked: omp resolves the
// session under a live process from the same context. Plain pi sends no `agent`: it has no subagents.
interface AgentCtx {
  agent?: { kind: "main" | "sub" }
  mode?: string
  getContextUsage?(): { percent: number } | undefined
}
interface SessionCtx extends AgentCtx {
  cwd: string
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined }
}

// One live file per process, describing the top-level session the process hosts. omp calls the factory
// below again for every subagent session, so this state is the process's, shared by every binding.
const live: Record<string, unknown> = {
  pid: process.pid, kind: "interactive", status: "idle", startedAt: Date.now(), procStart: procStart(),
}
const update = (patch: Record<string, unknown>) => {
  Object.assign(live, patch, { updatedAt: Date.now() })
  if (live.sessionId) writeJson(LIVE, live)
}
const gone = () => { try { fs.unlinkSync(LIVE) } catch {} }
process.once("exit", gone)
// The pool session whose tool started this process, read before a binding sets the variable to its own.
// Only a hint for `ctl authorize`, which trusts the process tree over it.
const STARTED_BY = process.env.PENGUPOOL_SESSION || ""
// omp sends no event when the session is renamed (omp's /rename, pi-intercom's /alias, PenguPool's
// Rename), so the name the pool session's binding reports is polled, as pi-intercom polls it for its
// presence. Unset between a session's shutdown and the next binding, so the poll never rewrites a live
// file that `gone` removed.
let poolName: (() => string) | undefined
let polling = false
const pollName = () => {
  let name: string
  try { name = poolName?.() ?? "" } catch { return }
  if (poolName && live.sessionId && name && name !== live.name) update({ name })
}

export default function (pi: ExtensionAPI) {
  // A pool session is the top-level session of an interactive run (omp's tui or rpc mode): not a
  // subagent, and not a one-shot print or json run, which ends with its answer.
  const pooled = (ctx: AgentCtx) => ctx.agent?.kind !== "sub" && ctx.mode !== "print" && ctx.mode !== "json"
  const saveContext = (ctx: AgentCtx) => {
    const pct = ctx.getContextUsage?.()?.percent
    if (pooled(ctx) && live.sessionId && typeof pct === "number") {
      writeJson(path.join(HOME, "context", `${live.sessionId}.json`), { pct, ts: Date.now() / 1000 })
    }
  }

  // Everything that follows the session id: the live file PenguPool polls, the cwd→pane registry
  // line and the workspace profile, plus the env var this session's tools inherit so `ctl` knows who
  // is calling. Runs again for every session the process comes to host. `/new` (`reason` "new") is
  // pi's fresh context, like Claude's /clear: the new id takes over the old one's name, group and role.
  const bind = async (ctx: SessionCtx, reason = "") => {
    if (!pooled(ctx)) return
    const sessionId = ctx.sessionManager.getSessionId()
    const wanted = process.env.PENGUPOOL_SESSION_NAME
    delete process.env.PENGUPOOL_SESSION_NAME  // only the session ctl started: one resumed later keeps its own name
    if (wanted && !pi.getSessionName()) pi.setSessionName(wanted)
    process.env.PENGUPOOL_SESSION = sessionId
    const previous = String(live.sessionId || "")
    const moved = sessionId !== previous
    if (moved) await run(["ctl", "register", sessionId, ctx.cwd, "--key-stdin"], `${GRANT_KEY}\n`)  // before the first prompt
    if (moved && previous && reason === "new") {
      // both ids are now registered with this process's key, which is what lets ctl move the seat
      await run(["ctl", "carry", previous, sessionId], `${GRANT_KEY}\n`)
      if (live.name && !pi.getSessionName()) pi.setSessionName(String(live.name))
    }
    update({ sessionId, cwd: ctx.cwd, name: pi.getSessionName() || "", sessionFile: ctx.sessionManager.getSessionFile(),
             ...(moved ? { status: "idle" } : {}) })
    poolName = () => pi.getSessionName() || ""  // this binding's: a subagent's never takes over the poll
    if (!polling) { polling = true; setInterval(pollName, 1000).unref?.() }
    if (!moved) return
    saveContext(ctx)  // a resumed or forked session's window is already in use: show it before its first turn
    try {
      fs.mkdirSync(HOME, { recursive: true })
      fs.appendFileSync(path.join(HOME, "registry.jsonl"), JSON.stringify({
        sessionId, cwd: ctx.cwd, tmuxPane: process.env.TMUX_PANE || "", ts: Math.floor(Date.now() / 1000), harness: "pi",
      }) + "\n")
    } catch {}
  }

  pi.on("session_start", async (_event, ctx) => { await bind(ctx) })
  // omp keeps the process and swaps the session under it on /new, /resume, /fork (`session_switch`)
  // and on a branch that forks (`session_branch`): without rebinding there, PenguPool keeps showing
  // the previous session's id, name and context for this pane. omp's own SESSION_IDENTITY_EVENTS.
  pi.on("session_switch", async (event, ctx) => { await bind(ctx, event.reason) })
  pi.on("session_branch", async (_event, ctx) => { await bind(ctx) })
  pi.on("agent_start", async (_event, ctx) => { if (pooled(ctx)) update({ status: "busy" }) })
  pi.on("turn_end", async (_event, ctx) => saveContext(ctx))
  pi.on("session_compact", async (_event, ctx) => saveContext(ctx))  // a compaction frees the window now
  pi.on("agent_end", async (event: any, ctx) => {
    // omp is about to run the next step, or a subagent finished while the session waits on it: still busy
    if (event?.willContinue || !pooled(ctx)) return
    update({ status: "idle", name: pi.getSessionName() || "" })
    saveContext(ctx)
  })
  pi.on("before_agent_start", async (event, ctx) => {
    if (!live.sessionId || !pooled(ctx)) return  // the tree and its role prompt are the session's alone
    // the user's prompt goes along: its @session tags lift the adjacent rule for those sessions
    const r = await run(["ctl", "context", String(live.sessionId), "--keyed-prompt-stdin"],
                        `${GRANT_KEY}\n${String(event.prompt || "")}`)
    if (r.code || !r.out) return
    // omp passes the system prompt as parts (string[]); plain pi as one string
    const sp: unknown = event.systemPrompt
    return { systemPrompt: Array.isArray(sp) ? [...sp, r.out] : `${sp}\n\n${r.out}` } as any
  })
  pi.on("tool_call", async (event: any) => {
    const input = event.input || {}
    // Every action that delivers to another session, so the adjacent rule cannot be walked around:
    // `handover` summarizes this session and sends it, `send`/`ask` are the plain ones, and
    // `contact_supervisor` sends to the session its env names (pi-intercom tries the id, then the
    // target, so both are checked). A subagent's send is checked as the session's (`live` is the
    // process's, and a subagent never binds it); ctl finds a one-shot run's session itself.
    let targets: string[]
    if (event.toolName === "intercom" && ["send", "ask", "handover"].includes(input.action)) {
      targets = [String(input.to || "")]  // a send by cwd alone names no session: "" is refused when grouped
    } else if (event.toolName === "contact_supervisor") {
      targets = [process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID, process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET]
        .map((t) => String(t || "").trim()).filter(Boolean)
    } else return
    for (const to of targets) {
      const r = await run(["ctl", "authorize", String(live.sessionId || STARTED_BY), to])
      // only a checked refusal (exit 3) blocks: a PenguPool fault or timeout never cuts sessions off
      if (r.code === 3) return { block: true, reason: r.err }
    }
  })
  // omp gives no shutdown reason; after /new, /resume or a fork branch the rebind writes it again.
  // A subagent's session ending is not this process's session ending.
  pi.on("session_shutdown", async (_event, ctx) => { if (pooled(ctx)) { poolName = undefined; gone() } })
}
