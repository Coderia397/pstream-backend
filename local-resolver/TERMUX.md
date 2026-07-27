# Running the resolver 24/7 on your Pixel (Termux)

Your phone is on ~24/7 and carries its own mobile internet everywhere — so it,
not the laptop, is the right always-on host. This runs the same `server.mjs`
directly on the phone and exposes it at `https://resolver.pstream.watch` through
a Cloudflare Tunnel.

> Honest note: this is documented, well-trodden, but **not five-nines**. A dead
> signal, a reboot, or heavy phone use can blip it. That's fine — the site's
> embed fallback covers every blip, so playback just briefly reverts to slow
> mode. Nothing breaks.

---

## Phase 1 — Prove it on your phone (~10 min, no account, no domain)

Do this first. If it works, you'll have a public URL that resolves streams from
your phone. If it doesn't, you've spent 10 minutes, not an afternoon.

1. **Install Termux** from **F-Droid** (NOT the Play Store version — it's
   outdated). Also install **Termux:API** and **Termux:Boot** from F-Droid.

2. Open Termux and run the setup script:
   ```bash
   pkg install -y curl
   curl -fsSL https://raw.githubusercontent.com/Promarcos397/pstream-backend/main/local-resolver/termux-setup.sh -o setup.sh
   bash setup.sh
   ```
   It installs Node + cloudflared, downloads the resolver, and starts it. Leave
   it running.

3. **New Termux session** (swipe from the left edge → New session) and test:
   ```bash
   curl "localhost:8790/api/stream?tmdbId=550&type=movie&title=Fight+Club&year=1999"
   ```
   You should see `"success":true` with a VixSrc/LookMovie URL. That's your
   phone resolving a stream over your mobile IP. 🎉

4. **Expose it publicly** (temporary URL). In that second session:
   ```bash
   cloudflared tunnel --url http://localhost:8790
   ```
   It prints a `https://<random>.trycloudflare.com` URL. Open
   `https://<random>.trycloudflare.com/api/ping` in a browser on any device —
   if you get `{"ok":true}`, the whole chain works from your phone. Done proving.

> Gotcha: if cloudflared errors with a DNS/SRV lookup failure on Termux, add
> `--edge-ip-version 4` to the command.

---

## Phase 2 — Make it permanent

### 2a. Keep it alive
```bash
termux-wake-lock                 # CPU stays awake with screen off
```
Then, in Android: **Settings → Apps → Termux → Battery → Unrestricted** (do the
same for Termux:API). Pixel/stock Android needs only this — no vendor toggles.
Keep the phone **on the charger** while it's serving.

### 2b. Stable address on your domain
A quick tunnel's URL changes every run, so the frontend can't hardcode it. Bind
a **named tunnel** to your domain (already on Cloudflare):
```bash
cloudflared tunnel login                                   # opens browser → pick pstream.watch
cloudflared tunnel create pstream-resolver
cloudflared tunnel route dns pstream-resolver resolver.pstream.watch
cloudflared tunnel run --url http://localhost:8790 pstream-resolver
```
Now `https://resolver.pstream.watch` permanently points at your phone — and it
survives your mobile IP changing (which it will).

### 2c. Auto-start on reboot
So a phone restart brings everything back without you:
```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/pstream.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/pstream
node server.mjs &
cloudflared tunnel run --url http://localhost:8790 pstream-resolver &
EOF
chmod +x ~/.termux/boot/pstream.sh
```
(Termux:Boot must be installed and opened once so Android grants it start
permission.)

---

## Phase 3 — Point the site at your phone

In **Cloudflare Pages → your frontend project → Settings → Environment
variables**, set:
```
VITE_GIGA_BACKEND_URL = https://resolver.pstream.watch
```
Redeploy. The player already calls `${VITE_GIGA_BACKEND_URL}/api/stream` and
already falls back to embeds when it returns nothing — so when your phone is off
or offline, the site quietly uses embeds instead of breaking.

That's it: direct 1080p streaming resolved from your phone whenever it's online,
embeds covering the gaps, $0/month.
