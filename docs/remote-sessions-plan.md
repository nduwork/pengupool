# Plan: remote sessions in isolated environments

Status: **final plan (rev 3), uncommitted.** Target: PenguPool (VS Code/Cursor extension + the
`pengupool` Python CLI). Nothing below is implemented.

This is the consolidated plan after design review. It supersedes rev 1 (which put the relay in phase
0) and rev 2: environments are **isolated** in phase 0, cross-host talk is an explicit later phase with
entry criteria, and the cross-machine address gap is already fixed on `main` (`0c4819d`).

Rev 2 records a phase-0 decision: **environments are isolated**, and cross-host session talk (the
relay/bridge) is deferred to a later phase with explicit entry criteria. An adversarial review of
rev 1 (Codex job `review-mum5e5v6-7l9yak`) raised three high findings; all three are findings about
the *bridge*, so isolation in phase 0 removes them from scope rather than leaving them open.

## 1. Goal

1. The editor runs **locally**; each session is either **local or on a remote host**.
2. Sessions on different hosts can eventually **message each other** ("cross-computer session
   talks") — deferred, see phase 2.
3. Remote sessions are hosted by a `pengupool` on that host (its own tmux, its own state), and the
   local editor opens/views/controls them.

## 2. Verified current state (recon, with anchors)

Everything runs on the extension-host machine; there is no network layer anywhere.

| Fact | Evidence |
|---|---|
| `extensionKind: ["workspace"]` — in a Remote-SSH window the extension host, and therefore the backend, runs on the remote | `extension/package.json:21` |
| The backend is a **child of the extension host**: `spawn(cmd, ['serve'])` | `extension/src/serveClient.ts:69-80` |
| Every mutation is a one-shot child process: `execFile(cmd, ['ctl', ...args])` | `extension/src/util.ts:14` |
| Terminals are created by the extension host from `ctl attach --json` output | `extension/src/terminals.ts:135-137` |
| `serve` is NDJSON snapshots on stdout, idle ticks skipped | `pengupool/serve.py:60-77` |
| Two harnesses only; each has its own tmux server; they never share a tree; `resolve()` only ever matches sessions of the sender's harness | `pengupool/harness.py:15,18`; `pengupool/routing.py:69-80` |
| Grouping candidates are filtered to the same harness | `extension/src/commands.ts:110-118` |
| Per-harness UI split already exists (cc/pi tabs, shown only while both run) | `extension/src/harness.ts` (`splitByHarness`, `HarnessTabs`, `bothHarnesses`), `extension/src/terminals.ts:29-32` |
| State is per machine and env-overridable | `pengupool/model.py:17-18` |
| tmux interaction is host-local and tty-keyed (grouped `pv-ext-*` views, `window-size latest`, pre-size before `select-window`) | `pengupool/tmux.py:34,136-153,155-205` |
| **Messages are delivered by the harness, not by PenguPool.** PenguPool authorizes (a `PreToolUse` hook denies non-adjacent Claude `SendMessage`; the pi extension gates pi-intercom sends) and observes (transcript parsing) | `pengupool/routing.py:160-200,210-223`; `pengupool/pi_extension.ts:96-103`; `pengupool/model.py:582-623` |
| Claude's `SendMessage` is local unix-socket IPC; pi-intercom is documented same-machine only | `pengupool/model.py:641-653,726-727`; `pi-intercom/skills/pi-intercom/SKILL.md:13,365` |
| A pane-typing primitive exists (`send-keys -l` + Enter), unused; `slash()` is live (used by `ctl` rename) | `pengupool/tmux.py:361-371`, `pengupool/ctl.py:249-260` |
| Nothing in the repo mentions ssh, remote, host, peer or transport (grep) | — |

## 3. Environment model (rev 2)

An **environment** is the unit of isolation: `env = (host, harness)`.

- Every env has its own tmux servers, its own `~/.pengupool`, its own session tree, its own
  graph/log, its own `serve` stream and its own `ctl`.
- Envs do not mix: no grouping across envs, no messages across envs, no shared terminals.
  **Phase 0 adds no way for one env to reach another.**
- This is exactly today's `harness` isolation rule, parameterised by host: the existing
  same-harness filters (`routing.py:69-80`, `commands.ts:110-118`) become same-env filters.
- The UI already has the pattern for it: today cc/pi are switched with tabs
  (`extension/src/harness.ts`); the env switcher generalises that key from `harness` to
  `(host, harness)`.
- Consequence for phase 0: **no new session-to-session trust surface.** One session can never address
  another env's session, and they cannot be grouped. The hub does reach a remote — to view it, to
  control it, and (0d) to install the backend on it, acting as the user through their own ssh
  credentials — but that is the editor talking to a host, not a session talking to a session.
- **Detection is automatic; linking is not.** An env's sessions appear from that env's own `serve`
  snapshot: discovery is the existing `model.load_sessions` (Claude session files + registry + the
  process scan), pi registers itself at `session_start` (`pengupool/pi_extension.ts:68-78`), and the
  hooks are installed by `pengupool setup`/`install-hook`. **No per-session registration exists
  anywhere in phase 0**, and none is added. The only manual cross-env act in the whole plan is phase
  2's link — auto-detecting a session must never imply auto-trusting it.

Local machine is the **hub** (the only place with the editor, the ssh keys and the full-mesh view),
but the hub is an aggregator of isolated envs, not a router between them.

Transport per target: one `ssh` connection per target, shared by the snapshot stream and every
`ctl`: `-o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=auto
-o ControlPersist=60s -o ControlPath=<run>/pengupool-<hash>`.

## 4. Phase 0 — isolated remote environments (view, control, provision)

**0a. Remote prerequisites and honesty** (small, first; also the Remote-SSH path's polish):
- `pengupool doctor [--json]`: the machine-readable half of this table — tmux (and its version),
  harness CLIs, hooks wired, state dir writable, resolved backend path, version.
- The remote footprint is small, but it is more than tmux. What a host needs, and what `doctor` asserts:

  | Needed | Why | Only if |
  |---|---|---|
  | `pengupool` + Python 3.11+ | discovery, `serve`, `ctl`, all tmux management; pure stdlib (`dependencies = []`, `requires-python = ">=3.11"`) | always |
  | tmux 3.2+ | hosts the panes; the shipped binds use `window-size latest`, `copy-mode -M`, `send-keys -X select-word`, `if-shell -F` (documented minimum `README.md:17`, `extension/README.md:11`) | always |
  | sshd | it is the transport | always |
  | `claude` and/or `pi` CLI + credentials on that host | the agent itself; sessions and history are host-local | per harness used |
  | `pengupool setup <harness>` wiring | cc: hooks in `~/.claude/settings.json`; pi: the PenguPool pi extension plus pi-intercom (`install.py:93-104`) | per harness used |
  | `node`/`npm` | pi is a Node CLI; `setup` installs npm in order to install pi | pi only |
  | `git` | the worktree placement for a new session | worktrees only |
  | `wl-copy` or `xclip` | the mouse drag/right-click copy path; `tmux.clip_command()` picks the host's command and leaves copy-mode when there is none | Linux remotes |
  | `uv` / `make` | `install.sh` only | install time |
  | **nothing else** | no editor, no extension, no VS Code server, no extra open ports | |

- Two failure modes to check explicitly: **PATH under non-interactive ssh** (`ssh host pengupool …` does
  not source `~/.zshrc`, so `~/.local/bin` may be absent — resolve the absolute path once and reuse it),
  and **old tmux** (distro packages can be far below 3.2, where the mouse-copy and sizing binds degrade
  silently). `pengupool setup --check` prints this checklist on the host today
  (`pengupool/install.py:120-137,160-163`); `doctor` is its machine-readable form.
- Absolute-path backend resolution when `pengupool` is not on the extension host's PATH (probe
  `~/.local/bin`, `~/.local/share/uv/tools/pengupool/bin`, `/opt/homebrew/bin`, then offer to set
  the command setting).
- Remote-aware failure text when `vscode.env.remoteName` is set.
- **Clipboard (done):** the mouse-copy binds hardcoded `pbcopy`, so on a Linux remote neither drag-select
  nor right-click copy reached anything. `tmux.clip_command()` now picks `pbcopy`, `wl-copy` or
  `xclip -selection clipboard` for the host, and a host with none leaves copy-mode instead of failing.

**0b. Multi-target transport and UI**:
- `sshArgs(target)` in one module; `ServeClient` per target; `runCtl(target, args)`.
- `TerminalManager` slots keyed `(target, harness)`; per-host terminal names; for a remote env the
  terminal is `ssh -t <host> 'exec <command>'` with **no local `cwd`** (the tmux window carries its
  own directory).
- Tree ids namespaced per env (`sessionsTree.ts:26,58` are bare node ids today); env switcher + host
  badge; map/log follow the active env; cc/pi tab logic keyed per env.
- Host-aware "new session": a folder dialog cannot cross ssh (`commands.ts:39,62-65`) — use an input
  box seeded with the remote `$HOME` plus cwds already seen in that env's snapshots.
- Per-env connection state, retry, actionable errors.

**0c. Endpoint registry, bulk add and inventory**:
- One endpoint = one target env: `{name, host (an ssh alias), enabled}`. Add several at once:
  multi-select from `~/.ssh/config` (plus VS Code's `remote.SSH.configFile` when set) or paste a list
  of `user@host` lines. Store the **ssh alias**, not an expanded host/user/port/identity, so the
  user's own config (jump hosts, keys, ports) keeps applying. Wildcard and negated `Host` patterns
  are excluded; entries are deduped by (user, host, port).
- On add, probe each endpoint once with `pengupool doctor --json` and show a readiness row: reachable,
  `pengupool` version, tmux, which harness CLIs are installed, hooks wired, session count. Bounded
  concurrency (4-6), `BatchMode=yes` and a short `ConnectTimeout` so a sleeping host cannot hang the
  UI; an endpoint that needs an interactive ssh is reported as such with a one-click terminal, never
  a background password prompt. `doctor` reports, it does not fix.
- **Tiered streaming, because N endpoints must not mean N processes.** The active env gets the live
  1 Hz `serve` stream and terminal slots; inactive envs are inventoried cheaply (`doctor` cached, and
  `serve --once`, which already exits after one snapshot, `pengupool/serve.py:66-77`) on a slow timer
  (15-60 s), so a bulk add of eight hosts costs eight short-lived commands, not eight resident
  processes plus eight ssh sessions.
- Keep the UI honest: unreachable endpoints show as offline, not as empty. Only the **active** env
  auto-opens a terminal (`extension/src/defaultLayout.ts:23-60` opens one on activation) — otherwise
  bulk detection of many sessions produces a terminal storm.

**Phase 0 deliberately does not include**: relays, twins, any messaging path, any new session kind,
`resolve()`/`authorize_send` changes, an auto-link or auto-pair rule, or a `UserPromptSubmit` hook.

**0d. Set up a host from the hub** — logging in over ssh already grants everything the installer needs,
so provisioning is a phase-0 action, not a documentation link. Laddered, with the command always
visible and nothing installed invisibly:

- `doctor` (0a) decides what is missing; the endpoint row says so and names the fix. The installer path
  itself has already been repaired once, by running it against a stock Debian box: see
  `scripts/ssh-sandbox/README.md` for the four bugs that found.
- **CLI missing or skewed**: the uv one-liner runs in the background into the PenguPool output channel
  because it needs no sudo and no prompts (`ssh <host> 'uv tool install --force pengupool==<version>'`),
  then the endpoint is re-probed. It falls back to the installer below when `uv` or Python is absent.
- **Anything else** (tmux, an agent CLI, hooks, pi-intercom) needs prompts and possibly sudo, so it
  opens a **terminal** running the published installer over ssh, pinned to this extension's own
  release:
  `ssh -t <host> 'export PENGUPOOL_REF=vX.Y.Z; curl -fsSL https://pengupool.nduwork.com/install.sh | bash'`.
  (The `export` matters: an assignment prefixed to `curl` never reaches the `bash` reading the pipe, so
  `PENGUPOOL_REF=vX.Y.Z curl … | bash` looks pinned and silently installs the latest.)
  The installer script itself is served from `main`; the ref pins the payload it installs.
  The user watches it, answers the y/N prompts and can interrupt. That terminal is also where an
  unknown host key gets confirmed: a host whose key is not known is never accepted in the background.
- **Pinned by default.** One tag ships the backend and the extension together (`README.md`, Releasing),
  so a hub provisions remotes at its own version, `doctor` reports skew, and "latest" is an explicit
  choice rather than a fleet-wide default.
- **Not covered, on purpose**: the agent CLI's sign-in (the user's own credentials on that host), a
  distro tmux older than 3.2, and Windows remotes. `doctor` names each instead of guessing.
- After any of these, re-probe and show the transition (missing → ready). The absolute-path resolution
  from 0a is what makes a freshly installed CLI reachable by a non-interactive `ssh`.

## 5. Phase 1 — Remote-SSH-window niceties

Only for the other mode, where the extension itself runs on the remote (Remote-SSH): installing the
VSIX into a remote window's `~/.vscode-server` via the remote-cli shim, or publishing to the
Marketplace so VS Code's "Install in SSH: host" is one click. Phase 0 needs none of it — the backend
is provisioned over ssh (0d) and the extension stays local.

## 6. Phase 2 — the env bridge (cross-host talk), with entry criteria

Only after phase 0 is in real use. The bridge makes one env reachable from another as an explicit,
addressable relationship:

- A cross-env relationship is represented by **two relay nodes, one per side**, each bound to the
  session it fronts ("twin pair"), so the boundary is a visible, stateful tree edge and link health
  is a session state (`linked` / `down`).
- One **duplex channel per peer**: `ssh <peer> pengupool relay --peer <name>` carrying NDJSON both
  ways, so the remote can reply over the connection the hub opened (no inbound ssh to the local
  machine). The channel also carries peer rosters. `relay` is a separate process from `serve`.
- Relays **do not think**: no LLM in the message path; hop metadata is generated by PenguPool, not
  written by an agent.
- Safety mechanics: reuse `hop_limit` + a visited-hosts list (`pengupool/context.py:25-28`), message
  ids, offline queue per twin, `ctl link remove` revocation, default-deny until paired, every hop
  logged with provenance.

**Entry criteria from the rev-1 adversarial review (all three must be resolved before this phase is
implemented):**

1. **[high] The relay entry path must be explicit.** `resolve()` only matches sessions of the
   sender's harness (`routing.py:69-80`), so a cc/pi sender cannot resolve a relay of a different
   kind, and `authorize_send()` passes unknown names through to the harness, whose native messaging
   has no relay endpoint. The plan must specify a relay-aware send path (authorization *and*
   interception before native delivery), not "existing authorization applies unchanged".
2. **[high] Do not deliver by typing into the interactive input buffer.** `tmux.send()` appends to
   and submits whatever draft the user has in the pane. Delivery must go through a harness hook/API
   that creates a separate message turn.
3. **[high] Do not promise exactly-once injection.** If injection succeeds and the ack is lost, a
   retry after a dedupe window can inject again. Define durable per-message delivery state with
   retention tied to outstanding retries, and state the ambiguous-outcome behaviour honestly
   (at-least-once with a visible "may have been delivered" outcome) instead of promising single
   injection.

Open sub-decisions for phase 2: whether relays are **harness-scoped** (cc bridges to cc, pi to pi,
preserving today's harness isolation) — the natural reading of "isolated like cc and pi" — and
whether the channel is held by the editor or by an always-on launchd/systemd agent.

Prior art, and a gap the bridge must close rather than add to:

- pi-intercom (the installed version) already has an SSH cross-machine path with **`name@machine`**
  addressing, a versioned JSON envelope and `trust: "ssh-asserted"`
  (`pi-intercom/cross-machine-transport.ts:80-89`). The addressing syntax the bridge wants is
  therefore already in the wild, and pi's own remote path is send-only (no ask, reply or
  attachments).
- **CONFIRMED (research_agent, 2026-09-29) and fixed.** `routing.resolve()` matches only live local
  sessions of the sender's harness (`routing.py:56-60`), so `other@workstation` resolved to nothing and
  `authorize_send()` fell through its unknown-name branch as *allowed* (`routing.py:172-176`): the same
  name refused locally was allowed with an `@machine` suffix, and pi-intercom accepts that form and
  relays it over SSH — its `uds:` case was the only unmappable address refused. Reproduced on a
  synthetic tree (`other` REFUSED, `other@workstation` ALLOWED). It was latent only because `herdr`,
  which supplies pi-intercom's saved machines, is not installed; the hole opened the moment one was
  saved. Now fixed: any unmappable address containing `@` is refused alongside `uds:`, while a session
  actually named `x@y` still resolves by name and a plain typo still passes to the harness.
- Phase 2 must still claim that path (policy for cross-machine links), but it no longer starts from a
  silent bypass.

## 7. Testing

- **A real Linux box on this machine**: `scripts/ssh-sandbox/` runs sshd + tmux + python3 + uv in a
  container on `127.0.0.1:2222`, with a pinned host key and its own ssh alias, so the transport,
  the prerequisites and the provisioning path can be exercised for real. It has already found four
  provisioning bugs (see its README).
- **Fake `ssh`** on PATH (strips the host arg, execs locally, forwards stdio) makes the transport
  testable with no network. The JS tests already stub exactly this seam
  (`extension/tests/session-lifecycle.test.cjs:41`).
- **Two-host rig on one machine**: `PENGUPOOL_HOME=/tmp/hostA` plus a per-host tmux socket name, so
  two isolated envs run side by side and the extension's env switching, isolation and (later) relay
  chains are testable in CI with **no ssh at all**. Needs `harness.SOCK` (`harness.py:18`) to be
  env-overridable.
- The pty harness (`tests/test_tmux_integration.py`) covers a client wrapped in an ssh-like shim, to
  confirm the no-repaint-on-switch behaviour (`tmux.py:174-205`) still holds when the client's size
  arrives over ssh.

## 8. Risks and unknowns

1. **Env-keyed UI is a real refactor** even without messaging: tree ids, terminal slots, the cc/pi
   tab split, map/log state and command routing all become per-env.
2. **Not verified:** whether a remote extension host's PATH contains `~/.local/bin`; the WAN latency
   of a 1 Hz stream plus `ctl` calls; the ssh transport in general — key auth to loopback is denied
   on this machine and I did not modify `~/.ssh/authorized_keys`, so nothing here has been executed
   over ssh yet.
3. **Remote prerequisites are on the user**: tmux, the agent CLIs and their credentials, and
   `pengupool setup` on that host. `doctor` reports, it does not fix.
4. **`window-size latest` with ssh-sized clients** needs a manual check: the anti-repaint pre-size
   (`tmux.py:174-205`) assumes sizes known before the switch, and a slow pty resize over ssh is a new
   timing case.
5. **Phase 2 carries the remaining design risk** (see entry criteria), plus prompt-injection blast
   radius once a peer can reach a local session.
6. **Bulk endpoints are a resource decision, not just a UI one.** Every enabled endpoint can hold an
   ssh connection and a remote `pengupool` process; the tiering in 0c is what keeps that bounded, and
   the defaults need a real number of hosts to tune against (one remote and ten remotes are different
   products).
7. **Bulk add must stay a pick list.** A blind `~/.ssh/config` import would add hosts the user cannot
   reach or does not want touched, and the first bulk action should not be a trust decision for
   phase 2's bridge.

## 9. Non-goals

Bridging harness-native IPC between machines; Windows remotes (tmux is Unix); syncing
`~/.claude`/`~/.pengupool` between hosts; cross-env grouping; cross-env routing through agents.

## 10. Decisions

Resolved (final plan):

1. **Env switcher: a picker for the host, the existing cc/pi tabs inside it.** Tabs do not scale past a
   couple of hosts, and the tab strip already means "harness", so host selection moves to the control
   that does scale.
2. **Assume a small fleet (2-6 endpoints).** The endpoint list lives in extension state, not settings,
   so bulk add/remove/disable is a UI action. Inventory cadence: live only for the active env, 15-60 s
   for the rest.
3. **Phase 2 relays are harness-scoped** (cc bridges to cc, pi to pi), preserving today's isolation and
   matching pi-intercom's own addressing. **Channels are held on demand** for outbound and kept alive
   while any hub-side process wants inbound; an always-on launchd/systemd agent is an opt-in follow-up
   (`pengupool relay install-agent`), not a prerequisite.
4. **No blocking `ask` across the bridge in v1**: send with a delivery outcome, and say plainly when the
   outcome is unknown.

Still open: where this document lives (this repo's `docs/`, which is the published site, or beside
`docs/group-session-framework.md` in the PenguPool repo).
