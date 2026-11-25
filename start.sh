#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.6 or newer (Node 22 line) is required."
  echo "Install it from https://nodejs.org/"
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 22 || minor < 6) { console.error("Use Node.js 22.6+ in the Node 22 line."); process.exit(1); }'
if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and configure access code, session secret and team members."
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install
fi
npm start
