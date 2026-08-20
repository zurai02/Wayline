#!/usr/bin/env bash
# Wayline Browser — launcher
# Usage: ./start.sh [port]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but wasn't found. Install it from https://nodejs.org/ and re-run this script." >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies…"
  npm install
fi

if [ "${1:-}" != "" ]; then
  export PORT="$1"
fi

echo "Starting Wayline…"
npm start
