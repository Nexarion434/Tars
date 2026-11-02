#!/bin/sh
# Build a Tars server from this checkout (docs/superpowers/plans/2026-11-02-tars-cloud.md).
# The same step for a bare install (then install-user-unit.sh) and for a
# container image (a Dockerfile RUNs it, its entry is `cli.js serve`).
# Run as the server's own user; it installs nothing system-wide.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 12)) { console.error("tars-server needs Node 22.12 or later, found " + process.versions.node); process.exit(1); }'

# node-pty has no Linux prebuild: npm compiles it, which needs these.
missing=""
for tool in make g++ python3; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "Missing:$missing. On Ubuntu, as root: apt-get install -y build-essential python3" >&2
  exit 1
fi

# The server never loads Electron: no need for its 100 MB binary.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npx tsc -p electron/tsconfig.json
# The bundled MCP servers, whichever this checkout has; mcp-shared is a library they share, with nothing to
# build (measured on the VPS trial of 2026-11-02, where `npm run build` stopped the script there).
for dir in mcp-*/; do
  [ -f "${dir}package.json" ] || continue
  (cd "$dir" && npm install && npm run build --if-present)
done

echo "Built. Run in the foreground: node $ROOT/electron/dist/server/cli.js serve"
