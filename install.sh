#!/usr/bin/env bash
# One-command PenguPool install: the CLI, wiring for every installed harness (Claude Code, pi), the
# workflow tracker, and the editor extension (with its logo) in every VS Code / Cursor found.
#
#   curl -fsSL https://pengupool.nduwork.com/install.sh | bash
#   bash install.sh                      # from a checkout: installs that tree
#
# PENGUPOOL_REF=vX.Y.Z pins a release (default: the latest). HARNESS=cc|pi|both overrides detection.
# Needs python3 and make (offered y/N through brew/apt-get/dnf/pacman when missing) and installs uv; tmux
# and the agent CLIs are offered by `pengupool setup` (y/N each). The editor extension is required: the
# install fails, with what to do, when no VS Code, Cursor or VSCodium is found.
set -euo pipefail
REPO=nduwork/pengupool
need() { command -v "$1" >/dev/null || { echo "PenguPool needs $1: $2" >&2; exit 1; }; }
gh_ok() { command -v gh >/dev/null && gh auth status >/dev/null 2>&1; }  # installed AND signed in

# pkg_cmd <package>: the install command via the first package manager found (empty when there is none)
pkg_cmd() {
  if command -v brew >/dev/null; then echo "brew install $1"
  elif command -v apt-get >/dev/null; then echo "sudo apt-get update && sudo apt-get install -y $1"
  elif command -v dnf >/dev/null; then echo "sudo dnf install -y $1"
  elif command -v pacman >/dev/null; then echo "sudo pacman -S --needed --noconfirm $1"; fi
}

# offer <command> <package> <hint>: install a missing system tool after a y/N prompt, else stop with how to
offer() {
  command -v "$1" >/dev/null && return 0
  local cmd a=""
  cmd=$(pkg_cmd "$2")
  if [ -n "$cmd" ]; then
    printf 'PenguPool needs %s. Install it with `%s`? [y/N] ' "$1" "$cmd"
    read -r a <"$answers" || true
    case "$a" in y|Y|yes) bash -c "$cmd" && command -v "$1" >/dev/null && return 0 ;; esac
  fi
  echo "PenguPool needs $1: $3${cmd:+ (\`$cmd\`)}, then re-run." >&2; exit 1
}

# editor_clis: every editor CLI that can install the extension, one per line. PATH first, then macOS apps,
# then Flatpak VS Code (through a wrapper, since its CLI runs inside the sandbox).
editor_clis() {
  local pair c app e found
  for pair in "code:Visual Studio Code" "code-insiders:Visual Studio Code - Insiders" "cursor:Cursor" "codium:VSCodium"; do
    c=${pair%%:*}; app=${pair#*:}.app/Contents/Resources/app/bin/$c; found=""
    for e in "$(command -v "$c" || true)" "/Applications/$app" "$HOME/Applications/$app"; do
      if [ -n "$e" ] && [ -x "$e" ]; then echo "$e"; found=1; break; fi
    done
    if [ -z "$found" ] && [ "$c" = code ] && command -v flatpak >/dev/null && flatpak info com.visualstudio.code >/dev/null 2>&1; then
      printf '#!/bin/sh\nexec flatpak run --command=code com.visualstudio.code "$@"\n' > "$tmp/code-flatpak"
      chmod +x "$tmp/code-flatpak"; echo "$tmp/code-flatpak"
    fi
  done
}

no_editor() {
  local appimage
  appimage=$(ls "$HOME"/Applications/[Cc]ursor*.AppImage "$HOME"/[Cc]ursor*.AppImage "$HOME"/Downloads/[Cc]ursor*.AppImage 2>/dev/null | head -1 || true)
  echo "PenguPool's CLI and harness wiring are installed, but the editor extension is not: it needs VS Code," >&2
  echo "Cursor or VSCodium, and none was found." >&2
  if [ -n "$appimage" ]; then
    echo "Found the Cursor AppImage $appimage: in Cursor, run \"Shell Command: Install 'cursor' command\"," >&2
    echo "or point EDITOR_CLI at a cursor CLI, then re-run." >&2
  else
    echo "Install VS Code (https://code.visualstudio.com/download; Linux: .deb, .rpm or Snap put \`code\` on PATH)" >&2
    echo "or Cursor, or set EDITOR_CLI=/path/to/code-or-cursor, then re-run." >&2
  fi
  exit 1
}

# fetch <release asset|source> <ref> <dest>: gh's REST API when signed in (no anonymous rate limit; REST,
# because `gh release download` goes through GraphQL), falling back to anonymous curl if gh fails
fetch() {
  if gh_ok; then
    if [ "$1" = source ]; then gh api "repos/$REPO/tarball/$2" > "$3" && return 0
    else
      local url
      url=$(gh api "repos/$REPO/releases/tags/$2" --jq ".assets[] | select(.name == \"$1\") | .url") &&
        [ -n "$url" ] && gh api -H "Accept: application/octet-stream" "$url" > "$3" && return 0
    fi
  fi
  if [ "$1" = source ]; then curl -fsSL "https://github.com/$REPO/archive/$2.tar.gz" -o "$3"  # tag, branch or SHA
  else curl -fsSL "https://github.com/$REPO/releases/download/$2/$1" -o "$3"; fi
}

# verify <asset> <ref> <file>: check a release asset against the release's SHA256SUMS. Releases from before
# SHA256SUMS existed only warn; a mismatch always stops the install.
verify() {
  local sums="$tmp/SHA256SUMS" want got
  if ! fetch SHA256SUMS "$2" "$sums" 2>/dev/null; then
    echo "Note: $2 publishes no SHA256SUMS; installing $1 unverified." >&2; return 0
  fi
  want=$(awk -v f="$1" '$2 == f { print $1 }' "$sums")
  got=$( { command -v sha256sum >/dev/null && sha256sum "$3" || shasum -a 256 "$3"; } | awk '{ print $1 }')
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "PenguPool: $1 from $2 does not match its SHA256SUMS; not installing it." >&2; exit 1
  fi
}

latest() {
  { gh_ok && gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null; } ||
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' || true
}

self=${BASH_SOURCE[0]:-}  # empty when piped into bash: then there is no checkout, whatever the cwd

# Everything runs from main, called on the last line: a download cut off mid-transfer defines nothing
# and runs nothing, instead of running half an installer.
main() {
  # Where the y/N prompts read from. Never `exec </dev/tty` here: under `curl … | bash` bash reads this
  # script from stdin, so swapping stdin makes it wait for the rest of the script on the keyboard.
  answers=/dev/null                                               # no terminal (CI): prompts default to No
  if [ -t 0 ]; then answers=/dev/stdin
  elif (: </dev/tty) 2>/dev/null; then answers=/dev/tty; fi      # piped from curl: ask on the terminal
  [ -z "${PENGUPOOL_PRINT_ANSWERS:-}" ] || { echo "answers=$answers"; exit 0; }  # test hook

  if [ "$(uname)" = Darwin ]; then  # macOS ships both with the Command Line Tools
    need python3 "run xcode-select --install"
    need make "run xcode-select --install"
  else
    offer python3 python3 "install Python 3"
    offer make make "install make"
  fi
  if ! command -v uv >/dev/null; then  # user-space installer, no sudo
    echo "Installing uv…"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    need uv "the uv installer finished but uv is not on PATH; open a new shell and re-run"
  fi
  local bindir
  bindir=$(uv tool dir --bin)
  export PATH="$bindir:$PATH"  # make install runs the freshly installed `pengupool` from here

  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  local here="" src ref
  [ -f "$self" ] && here=$(cd "$(dirname "$self")" && pwd)
  if [ -z "${PENGUPOOL_REF:-}" ] && [ -n "$here" ] && [ -f "$here/Makefile" ] && [ -d "$here/pengupool" ]; then
    src=$here; ref=""
  else
    ref=${PENGUPOOL_REF:-$(latest)}
    [ -n "$ref" ] || { echo "Could not find the latest PenguPool release (rate-limited? run 'gh auth login' or set PENGUPOOL_REF=vX.Y.Z)." >&2; exit 1; }
    echo "Installing PenguPool $ref"
    fetch source "$ref" "$tmp/src.tar.gz"
    mkdir "$tmp/src" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components 1
    src=$tmp/src
  fi

  make -C "$src" install HARNESS="${HARNESS:-auto}" <"$answers"

  editors=${EDITOR_CLI:-}  # EDITOR_CLI picks one; unset = every VS Code / Cursor / VSCodium found
  [ -n "$editors" ] || editors=$(editor_clis)
  [ -n "$editors" ] || no_editor
  editors+=$'\n'
  vsix=$tmp/pengupool.vsix
  if [ -n "$ref" ] && fetch pengupool.vsix "$ref" "$vsix" 2>/dev/null; then verify pengupool.vsix "$ref" "$vsix"
  elif command -v npm >/dev/null; then  # a checkout, or a release without the asset: build it
    (cd "$src/extension" && npm ci --silent && npm run --silent compile && npm run --silent package -- --out "$vsix" >/dev/null) </dev/null
  else
    echo "No prebuilt extension for ${ref:-this checkout} and no npm to build one: the editor extension is not" >&2
    echo "installed. Install Node.js (npm) or use a release (PENGUPOOL_REF=vX.Y.Z), then re-run." >&2
    exit 1
  fi
  local failed=0
  while IFS= read -r ed; do
    if "$ed" --install-extension "$vsix" --force </dev/null; then echo "Extension installed in $ed"
    else echo "Could not install the extension in $ed" >&2; failed=1; fi
  done <<< "${editors%$'\n'}"
  [ "$failed" = 0 ] || exit 1
  echo "Done. Reload your editor window, then open the PenguPool view (penguin icon in the Activity Bar)."
}

main "$@"
