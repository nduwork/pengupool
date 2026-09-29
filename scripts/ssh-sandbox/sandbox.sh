#!/usr/bin/env bash
# Throwaway Linux "remote" for testing PenguPool over ssh.
#
#   scripts/ssh-sandbox/sandbox.sh up        # build + start, pin the host key, add the ssh alias
#   scripts/ssh-sandbox/sandbox.sh harness pi  # install + wire a harness inside it (interactive)
#   scripts/ssh-sandbox/sandbox.sh ssh       # open a shell in it
#   scripts/ssh-sandbox/sandbox.sh status    # what is running
#   scripts/ssh-sandbox/sandbox.sh down      # stop it (volumes kept)
#   scripts/ssh-sandbox/sandbox.sh down --purge   # remove everything this created, including the alias
#
# What it touches outside Docker: a sandbox-only key pair, a known_hosts file, and one Include line
# in ~/.ssh/config so `ssh pengupool-sandbox` works. `down --purge` removes all three.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
alias_name=pengupool-sandbox
key="$HOME/.ssh/${alias_name}_ed25519"
known="$HOME/.ssh/${alias_name}.known_hosts"
hook="$HOME/.ssh/${alias_name}.conf"
ssh_config="$HOME/.ssh/config"
compose=(docker compose -f "$here/compose.yaml")
port=2222

die() { echo "sandbox: $*" >&2; exit 1; }

ensure_key() {
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  [ -f "$key" ] || ssh-keygen -q -t ed25519 -N "" -C "$alias_name (throwaway)" -f "$key"
}

ensure_alias() {
  cat > "$hook" <<EOF
# PenguPool ssh sandbox (scripts/ssh-sandbox/sandbox.sh). Safe to delete.
Host $alias_name
  HostName 127.0.0.1
  Port $port
  User sandbox
  IdentityFile ~/.ssh/${alias_name}_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/${alias_name}.known_hosts
EOF
  chmod 600 "$hook"
  if [ ! -f "$ssh_config" ]; then
    printf '# Created by scripts/ssh-sandbox/sandbox.sh; safe to delete.\nInclude ~/.ssh/%s.conf\n' "$alias_name" > "$ssh_config"
    chmod 600 "$ssh_config"
  elif ! grep -qF "Include ~/.ssh/${alias_name}.conf" "$ssh_config"; then
    printf '# PenguPool ssh sandbox (delete this line to unhook it).\nInclude ~/.ssh/%s.conf\n\n' "$alias_name" | cat - "$ssh_config" > "$ssh_config.tmp"
    mv "$ssh_config.tmp" "$ssh_config"
    chmod 600 "$ssh_config"
  fi
}

pin_host_key() {
  # Read the host key out of the container we just built and pin it, instead of accepting whatever
  # answers on the port: the same verification the extension will have to get right.
  local pub
  pub=$("${compose[@]}" exec -T sshd cat /etc/ssh/hostkeys/ssh_host_ed25519_key.pub | awk '{print $1" "$2}')
  [ -n "$pub" ] || die "could not read the sandbox host key"
  touch "$known" && chmod 600 "$known"
  grep -v "^\[127.0.0.1\]:$port " "$known" > "$known.tmp" || true
  printf '[127.0.0.1]:%s %s\n' "$port" "$pub" >> "$known.tmp"
  mv "$known.tmp" "$known"
}

wait_for_sshd() {
  for _ in $(seq 1 30); do
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "$alias_name" true 2>/dev/null; then return 0; fi
    sleep 1
  done
  die "sshd did not answer on $alias_name:$port"
}

case "${1:-help}" in
  up)
    ensure_key; ensure_alias
    PUBLIC_KEY="$(cat "$key.pub")" "${compose[@]}" up -d --build
    pin_host_key
    wait_for_sshd
    echo
    echo "sandbox up: ssh $alias_name"
    echo "  $(ssh "$alias_name" 'uname -sr; tmux -V; python3 -V; command -v pengupool || { [ -x ~/.local/bin/pengupool ] && echo "pengupool installed, not on PATH (see: sandbox.sh checks)"; } || echo "pengupool: not installed (that is the point)"')"
    ;;
  down)
    "${compose[@]}" down
    if [ "${2:-}" = "--purge" ]; then
      "${compose[@]}" down -v >/dev/null 2>&1 || true
      rm -f "$key" "$key.pub" "$known" "$hook"
      echo "purged: key, known_hosts and ~/.ssh/${alias_name}.conf removed (left ~/.ssh/config alone)"
    fi
    ;;
  checks)
    # Repeatable version of the plan's assumptions, run on the sandbox itself.
    ssh "$alias_name" 'bash -s' <<'REMOTE'
set -u
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
echo "ssh transport: $(uname -sr), $(hostname)"
v=$(tmux -V 2>/dev/null | grep -oE '[0-9]+\.[0-9a-z]+' | head -1)
case "$v" in 3.[2-9]*|[4-9]*) ok "tmux $v (the plan needs 3.2+)" ;; *) bad "tmux ${v:-absent}, too old" ;; esac
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  && ok "python $(python3 -V | awk '{print $2}')" || bad "python older than 3.11"
if command -v pengupool >/dev/null 2>&1; then ok "pengupool $(pengupool --version) on PATH"
elif [ -x "$HOME/.local/bin/pengupool" ]; then
  bad "pengupool installed but NOT on PATH — non-interactive ssh never sources your shell rc"
else warn "pengupool not installed: uv tool install /src"; fi
command -v pbcopy >/dev/null 2>&1 && ok "pbcopy present" \
  || bad "pbcopy absent, so mouse drag/right-click copy fails here (xclip: $(command -v xclip || echo none))"
tmux new-session -d -s sandbox-probe >/dev/null 2>&1 && ok "tmux starts a session" || bad "tmux cannot start a session"
tmux kill-session -t sandbox-probe 2>/dev/null
for h in claude pi; do command -v $h >/dev/null 2>&1 && ok "$h present" || warn "$h absent (only needed for live sessions)"; done
REMOTE
    ;;
  harness)
    # Install a harness CLI *inside the container* through the real path (`pengupool setup`), rather
    # than baking one into the image: the sandbox stays a fresh box. Interactive — the y/N prompts are
    # the point, including the apt install of node/npm that pi needs.
    h="${2:-pi}"
    ssh -t "$alias_name" "~/.local/bin/pengupool setup $h"
    ;;
  ssh) exec ssh "$alias_name" ;;
  status)
    "${compose[@]}" ps
    ssh -o ConnectTimeout=3 -o BatchMode=yes "$alias_name" 'echo "ssh ok: $(hostname) $(tmux -V)"' || true
    ;;
  help|*) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
