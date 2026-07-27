#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# P-Stream resolver — one-shot Termux setup for an Android phone.
# Run INSIDE Termux:   bash termux-setup.sh
#
# Does the automatable parts: installs Node + cloudflared, downloads the
# resolver, acquires a wake-lock, and starts it. The Cloudflare named tunnel and
# auto-start-on-boot are interactive — see TERMUX.md for those.
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "== P-Stream resolver: Termux setup =="

# 1. Packages. termux-api provides termux-wake-lock (needs the Termux:API app).
echo "[1/4] Installing nodejs, cloudflared, termux-api ..."
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs cloudflared termux-api

# 2. Keep the CPU awake when the screen is off — without this the server freezes
#    on lock. (If this errors, install the Termux:API app from F-Droid.)
echo "[2/4] Acquiring wake-lock ..."
termux-wake-lock 2>/dev/null || echo "    (wake-lock needs the Termux:API app — see TERMUX.md)"

# 3. Download the resolver (pure Node, zero dependencies — same file as the repo).
echo "[3/4] Downloading resolver ..."
mkdir -p ~/pstream && cd ~/pstream
curl -fsSL -o server.mjs \
  https://raw.githubusercontent.com/Promarcos397/pstream-backend/main/local-resolver/server.mjs
echo "    server.mjs ready ($(wc -c < server.mjs) bytes)"

# 4. Sanity check + start.
echo "[4/4] Starting resolver on http://localhost:8790 ..."
echo "    Test it in another Termux session with:  curl localhost:8790/api/ping"
echo "    Stop with Ctrl-C. To expose it publicly, see TERMUX.md."
echo
node server.mjs
