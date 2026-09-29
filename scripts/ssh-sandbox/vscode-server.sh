#!/usr/bin/env bash
# Install the VS Code server and the PenguPool extension *inside* the sandbox, so a Remote-SSH window
# has both already and the test needs no install step in the UI.
#
# Why not `code --remote ssh-remote+pengupool-sandbox --install-extension <vsix>`: that flag combination
# installs the VSIX on the *local* machine and silently skips the remote, so the remote window would find
# nothing. This script does what the Remote-SSH window would do, in the documented manual layout.
#
#   scripts/ssh-sandbox/vscode-server.sh [path/to/pengupool.vsix]
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
alias_name=pengupool-sandbox
code=/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
vsix=${1:-$HOME/Downloads/pengupool.vsix}

[ -x "$code" ] || { echo "vscode-server: no VS Code CLI at $code" >&2; exit 1; }
[ -f "$vsix" ] || { echo "vscode-server: no VSIX at $vsix (gh release download vX.Y.Z -p pengupool.vsix)" >&2; exit 1; }

commit=$("$code" --version | sed -n 2p)
case "$(uname -m)" in arm64) flavor=linux-arm64 ;; *) flavor=linux-x64 ;; esac

echo "installing the VS Code server for commit $commit into the sandbox"
ssh "$alias_name" "set -e
  mkdir -p ~/.vscode-server/bin/$commit
  if [ ! -x ~/.vscode-server/bin/$commit/bin/code-server ]; then
    curl -fsSL https://update.code.visualstudio.com/commit:$commit/server-$flavor/stable \\
      | tar -xz --strip-components=1 -C ~/.vscode-server/bin/$commit
  fi"

echo "copying $(basename "$vsix") in and installing it there"
ssh "$alias_name" 'cat > /tmp/pengupool.vsix' < "$vsix"
ssh "$alias_name" "~/.vscode-server/bin/$commit/bin/code-server --install-extension /tmp/pengupool.vsix --force 2>&1 | tail -2
  ls -d ~/.vscode-server/extensions/*/ 2>/dev/null"

cat <<EOF

Ready. Connect a window to the sandbox:
  Cmd/Ctrl+Shift+P → Remote-SSH: Connect to Host… → $alias_name
The extension is installed remotely, so the PenguPool view appears without an install step.
EOF
