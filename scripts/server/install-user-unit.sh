#!/bin/sh
# Install tars-server as a systemd user unit for the current, non-root user,
# after scripts/server/build.sh. What needs root is printed, never run.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the server's own user, not as root." >&2
  exit 1
fi
NODE=$(command -v node) || { echo "node is not on PATH (Node 22.12 or later)." >&2; exit 1; }
[ -f "$ROOT/electron/dist/server/cli.js" ] || { echo "Build first: $ROOT/scripts/server/build.sh" >&2; exit 1; }

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s|@NODE@|$NODE|g" -e "s|@ROOT@|$ROOT|g" -e "s|@PATH@|$PATH|g" \
  "$ROOT/scripts/server/tars-server.service" > "$UNIT_DIR/tars-server.service"
systemctl --user daemon-reload
systemctl --user enable --now tars-server.service

echo "Installed and started. Check: node $ROOT/electron/dist/server/cli.js status --json"
echo "To keep it running after you log out, run once as root: loginctl enable-linger $(id -un)"
