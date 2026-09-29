# ssh sandbox

A throwaway Linux "remote" for testing PenguPool over ssh, on this machine. Debian stable with
`sshd`, `tmux`, `python3` and `uv` — the state a fresh box is in — on `127.0.0.1:2222`.

Why a container and not `linuxserver/openssh-server` or `ssh localhost`: the interesting remote
behaviour is Linux-specific (distro tmux versions, `~/.local/bin` PATH under a non-interactive ssh
command, `pbcopy` vs `xclip`, `apt` package installs), and none of that shows up on macOS or on a
minimal Alpine image. `limactl`/Multipass are the right escalation if a full VM with systemd is
wanted later.

## Use

```sh
scripts/ssh-sandbox/sandbox.sh up      # build, start, pin the host key, add the ssh alias
scripts/ssh-sandbox/sandbox.sh checks  # run the plan's assumptions on the box and print them
scripts/ssh-sandbox/sandbox.sh ssh     # shell inside
scripts/ssh-sandbox/sandbox.sh status
scripts/ssh-sandbox/sandbox.sh down            # stop, keep the volumes
scripts/ssh-sandbox/sandbox.sh down --purge    # stop and delete everything this created
```

Requires Docker Desktop running. `up` creates:

| Path | What |
|---|---|
| `~/.ssh/pengupool-sandbox_ed25519(.pub)` | a sandbox-only key pair (never your personal key) |
| `~/.ssh/pengupool-sandbox.known_hosts` | the host key pinned **from the container**, not accepted from the port |
| `~/.ssh/pengupool-sandbox.conf` | the `Host pengupool-sandbox` block |
| `~/.ssh/config` | one `Include` line naming that file (created only if absent) |

The repo is mounted read-only at `/src`, and `/home/sandbox` is a volume, so an install survives a
rebuild. The host key lives in a volume too, so a rebuild does not invalidate the pinned key. The
sandbox user has passwordless `sudo` **inside the container only** (the port is bound to
`127.0.0.1`), so the install path `pengupool setup` drives — apt installs, y/N prompts — is testable.

## What to test with it

```sh
# the whole point: the backend runs on the remote, driven over ssh
ssh pengupool-sandbox 'uv tool install /src && ~/.local/bin/pengupool --version'
ssh pengupool-sandbox 'command -v pengupool'                    # empty: PATH risk, as on a real remote
ssh pengupool-sandbox '~/.local/bin/pengupool setup --check'    # the prerequisites checklist
ssh pengupool-sandbox '~/.local/bin/pengupool serve --once'     # one NDJSON snapshot, no editor needed
ssh -t pengupool-sandbox '~/.local/bin/pengupool ctl tree <sid>'   # over a pty, the way a terminal does
```

Expect, until phase 0 lands: `command -v pengupool` failing is a **finding, not a bug** — it is the
non-interactive-PATH gap the plan's `doctor` and absolute-path resolution exist to fix. Likewise,
mouse drag-select and right-click copy inside a sandbox tmux session should fail today, because the
copy binds hardcode `pbcopy` (macOS) and this box has `xclip`.

A harness CLI (Claude Code, or pi via `npm install -g @earendil-works/pi-coding-agent`) and its
sign-in are deliberately not included: the sandbox proves the transport, the prerequisites and the
tmux layer, not the agents. To add one:

```sh
docker exec -u 0 pengupool-ssh-sandbox apt-get update \
  && docker exec -u 0 pengupool-ssh-sandbox apt-get install -y --no-install-recommends nodejs npm
docker exec -u sandbox pengupool-ssh-sandbox npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## Testing the extension against it

The extension cannot point at a host yet (that is phase 0), but the *other* mode needs no new code: connect
a **Remote-SSH** window to `pengupool-sandbox` and the extension host — hence `pengupool serve` and the
tmux terminals — runs inside the sandbox.

```sh
scripts/ssh-sandbox/vscode-server.sh    # installs the VS Code server + the PenguPool VSIX in the sandbox
```

Then: `Cmd/Ctrl+Shift+P` → **Remote-SSH: Connect to Host…** → `pengupool-sandbox`. The server and the
extension are already there, so the PenguPool view appears with no install step. Dev Containers is also
installed, and reaches the same conclusion from a different direction.

Note: `code --remote ssh-remote+<host> --install-extension <vsix>` looks like it does this and does not —
it installed the VSIX *locally* and silently skipped the remote, which is why `vscode-server.sh` exists.

## Findings this sandbox has already produced

Five bugs, all in the path a hub's *set up this host* action would drive, four found by running `pengupool setup pi` here and one by watching copy fail:

| # | Finding | Fixed by |
|---|---|---|
| 1 | `setup pi` asked apt for a package called `node`, which Debian and Arch do not have (`nodejs` + `npm` do) | `fix(install): ask each package manager for its real node package` (#45) |
| 2 | `apt-get install` never refreshes its lists, so a fresh box answered "Unable to locate package" for names that were correct | `fix(install): refresh apt lists before installing a package` (#46) |
| 3 | `npm install -g` ended in EACCES: Debian's npm prefix is root-owned, so pi could never be installed as the login user | `fix(install): install pi into the user's prefix when npm needs root` (#47) |
| 4 | pi installed and reported success on node 20, which cannot run it (pi needs 22.19+; it dies on import) | `fix(install): refuse to install pi on a node too old to run it` (#48) |
| 5 | mouse copy hardcoded `pbcopy`, which this box does not have, so drag-select and right-click copy went nowhere | `fix(tmux): copy with the host's clipboard command` (#50) |

Plus the transport and prerequisite facts the plan predicted:

| Check | Result |
|---|---|
| `uv tool install /src` on stock Debian | works; `pengupool 0.6.0` |
| `command -v pengupool` over a non-interactive `ssh` | **empty** — installed in `~/.local/bin`, off PATH. The plan's absolute-path resolution is not hypothetical |
| `pengupool serve --once` over ssh | one NDJSON snapshot (`{"rev": 1, …, "roots": []}`) — the transport needs no new code |
| tmux over an ssh pty | works (`tmux 3.5a`, session created) |
| copy on Linux | `pbcopy` absent, `xclip` present — the portability bug is real, not theoretical |

## Getting a harness onto the sandbox

`pengupool setup pi` works once there is a node new enough for pi (the guard refuses otherwise, by design). The sandbox has no root-owned Node, so install one into `$HOME`:

```sh
# node >=22 (pi needs 22.19+; Debian ships 20)
ssh pengupool-sandbox 'base=https://nodejs.org/dist/latest-v22.x; \
  f=$(curl -fsSL $base/SHASUMS256.txt | awk "/linux-arm64.tar.xz$/ {print \$2}" | head -1); \
  mkdir -p ~/.local/node && curl -fsSL $base/$f | tar -xJ -C ~/.local/node --strip-components=1'
# then: sandbox.sh harness pi   (answers the y/N prompts; installs pi + pi-intercom + the extension)
```

Then put the tools where a **non-interactive** ssh can find them — the same PATH problem the plan's `doctor` exists for. Symlinking into `/usr/local/bin` is the sandbox's shortcut:

```sh
ssh pengupool-sandbox 'sudo ln -sf ~/.local/bin/pengupool /usr/local/bin/pengupool; \
  for b in node npm npx pi; do sudo ln -sf ~/.local/node/bin/$b /usr/local/bin/$b 2>/dev/null || sudo ln -sf ~/.local/bin/$b /usr/local/bin/$b; done'
ssh pengupool-sandbox 'pengupool setup --check pi'   # tmux, pi, extension, node, pi-intercom: all ✓
```
