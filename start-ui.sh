#!/usr/bin/env sh
# macOS / Linux: run with  sh start-ui.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 18 ? 1 : 0)" || { echo "Node.js 18 or newer is needed (https://nodejs.org)."; exit 1; }
[ -d node_modules/puppeteer-core ] || npm install --no-fund --no-audit || exit 1
echo "WhatsApp Manager is starting at http://localhost:3030 — keep this window open."
exec node server.mjs "$@"
