#!/usr/bin/env bash
# Launch the local resolver and a Cloudflare quick-tunnel together.
# The tunnel URL changes every run — fine for testing. For a STABLE URL that
# your frontend can point at permanently, use a NAMED tunnel (see README.md).
set -e

cd "$(dirname "$0")"
PORT="${PORT:-8790}"

# 1. cloudflared — download the binary next to this script if it isn't around.
if [ ! -x ./cloudflared ] && ! command -v cloudflared >/dev/null 2>&1; then
  echo "Downloading cloudflared..."
  ARCH=$(uname -m); BIN=amd64
  [ "$ARCH" = "aarch64" ] && BIN=arm64
  [ "$ARCH" = "armv7l" ]  && BIN=arm
  curl -sL -o cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${BIN}"
  chmod +x cloudflared
fi
CF=$(command -v cloudflared || echo ./cloudflared)

# 2. resolver
echo "Starting resolver on :$PORT ..."
PORT="$PORT" node server.mjs &
RESOLVER_PID=$!
trap 'kill $RESOLVER_PID 2>/dev/null; exit' INT TERM
sleep 1

# 3. tunnel
echo "Opening Cloudflare tunnel ..."
"$CF" tunnel --url "http://localhost:$PORT" --no-autoupdate
