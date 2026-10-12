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
//  - every intercom send/ask goes through `pengupool ctl authorize` first; a non-adjacent target blocks it;
//    PenguPool failing to answer does not (the same rule Claude's SendMessage guard applies)
//  - omp has no --name flag: `ctl new` passes the name in PENGUPOOL_SESSION_NAME and the first start sets it
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

export default function (pi: ExtensionAPI) {
  const live: Record<string, unknown> = {
    pid: process.pid, kind: "interactive", status: "idle", startedAt: Date.now(), procStart: procStart(),
  }
  const update = (patch: Record<string, unknown>) => {
    Object.assign(live, patch, { updatedAt: Date.now() })
    if (live.sessionId) writeJson(LIVE, live)
  }
  const saveContext = (ctx: any) => {
    const pct = ctx.getContextUsage?.()?.percent
    if (live.sessionId && typeof pct === "number") {
      writeJson(path.join(HOME, "context", `${live.sessionId}.json`), { pct, ts: Date.now() / 1000 })
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // also fires after /new, /resume and /fork: the same process now hosts a different session
    const sessionId = ctx.sessionManager.getSessionId()
    process.env.PENGUPOOL_SESSION = sessionId  // tools this session runs inherit it: ctl knows who is calling
    const wanted = process.env.PENGUPOOL_SESSION_NAME
    delete process.env.PENGUPOOL_SESSION_NAME  // only the session ctl started: a later /new is not named alike
    if (wanted && !pi.getSessionName()) pi.setSessionName(wanted)
    await run(["ctl", "register", sessionId, ctx.cwd, "--key-stdin"], `${GRANT_KEY}\n`)  // before the first prompt
    update({ sessionId, cwd: ctx.cwd, name: pi.getSessionName() || "", status: "idle",
             sessionFile: ctx.sessionManager.getSessionFile() })
    try {
      fs.mkdirSync(HOME, { recursive: true })
      fs.appendFileSync(path.join(HOME, "registry.jsonl"), JSON.stringify({
        sessionId, cwd: ctx.cwd, tmuxPane: process.env.TMUX_PANE || "", ts: Math.floor(Date.now() / 1000), harness: "pi",
      }) + "\n")
    } catch {}
  })
  // omp sends no session_info_changed, so a rename shows up when the run ends
  pi.on("agent_start", async () => update({ status: "busy" }))
  pi.on("turn_end", async (_event, ctx) => saveContext(ctx))
  pi.on("agent_end", async (event: any, ctx) => {
    if (event?.willContinue) return  // omp is about to run the next step: still busy
    update({ status: "idle", name: pi.getSessionName() || "" })
    saveContext(ctx)
  })
  pi.on("before_agent_start", async (event) => {
    if (!live.sessionId) return
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
    if (event.toolName !== "intercom" || !["send", "ask"].includes(input.action) || !live.sessionId) return
    // A send by cwd alone names no session: authorize gets "" and refuses it for a grouped session.
    const r = await run(["ctl", "authorize", String(live.sessionId), String(input.to || "")])
    // only a checked refusal (exit 3) blocks: a PenguPool fault or timeout never cuts sessions off
    if (r.code === 3) return { block: true, reason: r.err }
  })
  const gone = () => { try { fs.unlinkSync(LIVE) } catch {} }
  // omp gives no shutdown reason; after /new or /resume, session_start writes the live file again
  pi.on("session_shutdown", async () => gone())
  process.once("exit", gone)
}
