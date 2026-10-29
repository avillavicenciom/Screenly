#!/usr/bin/env bash
set -euo pipefail

node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
npm --cache /workspace/.cache/npm install --prefix /workspace/.tools bun@1.4.4 --no-audit --no-fund
export PATH=/workspace/.tools/node_modules/.bin:$PATH
export BUN_INSTALL_CACHE_DIR=/workspace/.cache/bun

cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun install --frozen-lockfile
bun run --cwd packages/web-domain build
bun run --cwd packages/recorder-core typecheck
