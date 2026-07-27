#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# P-Stream resolver — one-shot Termux setup for an Android phone.
# Run INSIDE Termux:
#   curl -sL https://raw.githubusercontent.com/Promarcos397/pstream-backend/main/local-resolver/termux-setup.sh | bash
#
# Idempotent and re-runnable. Installs Node + cloudflared, downloads the
# resolver, holds a wake-lock, starts the resolver DETACHED (survives the
# screen locking), verifies it, then opens a public quick-tunnel and prints the
# URL. For the permanent named tunnel + auto-start on boot, see TERMUX.md.
# ─────────────────────────────────────────────────────────────────────────────

echo "== P-Stream resolver: Termux setup =="
DIR=~/pstream
mkdir -p "$DIR"

echo "[1/5] Installing packages (nodejs, cloudflared, termux-api) ..."
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs cloudflared termux-api || { echo "  package install failed — check your connection and re-run"; exit 1; }

echo "[2/5] Holding wake-lock (stops Android killing it on lock) ..."
termux-wake-lock 2>/dev/null || echo "  (also tap 'Acquire wakelock' in the Termux notification)"

echo "[3/5] Downloading resolver ..."
curl -fsSL -o "$DIR/server.mjs" \
  https://raw.githubusercontent.com/Promarcos397/pstream-backend/main/local-resolver/server.mjs || { echo "  download failed"; exit 1; }

echo "[4/5] Starting resolver (detached) ..."
pkill -f "node .*server.mjs" 2>/dev/null || true
sleep 1
cd "$DIR"
nohup node server.mjs > "$DIR/node.log" 2>&1 &
sleep 3
if curl -s -m 5 http://localhost:8790/api/ping | grep -q '"ok":true'; then
  echo "  ✅ resolver UP on :8790"
else
  echo "  ❌ resolver did not start. Log:"; cat "$DIR/node.log"; exit 1
fi

echo "[5/5] Opening public tunnel ..."
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1
nohup cloudflared tunnel --url http://localhost:8790 --edge-ip-version 4 --no-autoupdate > "$DIR/cf.log" 2>&1 &
URL=""
for i in $(seq 1 25); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$DIR/cf.log" | head -1)
  [ -n "$URL" ] && break
  sleep 2
done

echo
echo "════════════════════════════════════════════════════════"
if [ -n "$URL" ]; then
  echo " ✅ YOUR RESOLVER IS LIVE:"
  echo "   $URL"
  echo
  echo " Send that URL back to continue."
else
  echo " Resolver is running but the tunnel URL didn't appear."
  echo " Run:  cat ~/pstream/cf.log   and send the last few lines."
fi
echo
echo " Keep Termux open, and tap 'Acquire wakelock' in the"
echo " Termux notification so it keeps running when locked."
echo "════════════════════════════════════════════════════════"
