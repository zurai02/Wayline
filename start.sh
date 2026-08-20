#!/usr/bin/env bash
cd "$(dirname "$0")"
PORT="${1:-4173}"

if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

echo "🚀 Starting Wayline on port $PORT..."
node server.js "$PORT"
