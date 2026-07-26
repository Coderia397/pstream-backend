# P-Stream Local Resolver

A tiny stream resolver you run on a machine with a **residential / mobile IP**
(a home computer, a laptop tethered to a phone). It exists because the providers
(`vixsrc.to`, `lmscript.xyz`) return their data to anyone but **block datacenter
IPs** — so no cloud host (HuggingFace, Deno, Cloudflare Workers) can reach them,
but your own connection can.

## How it fits together

```
 visitor's browser ──HTTPS──▶ Cloudflare ──tunnel──▶ your machine ──▶ provider
        │                                              (your IP)         │
        │◀─────────── resolved .m3u8 URL (JSON) ───────────────────────-┘
        │
        └────────── plays video DIRECT from the CDN (ACAO:*) ──────────▶ CDN
```

- **Hop 1 (browser → you):** allowed because *this* server sends open CORS
  headers. The provider never did — that's why the browser can't call it directly.
- **Hop 2 (you → provider):** works because your IP is residential/mobile, not a
  datacenter.
- **Video:** streams browser → CDN directly. It never touches this machine, so
  this box only ever moves a few KB of JSON per title.

## What it is NOT

- **Not 24/7 by itself.** It's up only while this machine is on and online. When
  it's down the frontend automatically falls back to embeds — the site stays up,
  just slower. (Playback resolution is what pauses, not the site.)
- **Not per-visitor.** Every visitor's request goes out over *this machine's one
  IP* — browsers' CORS rules make true per-visitor resolution impossible. The
  in-memory cache is what keeps that single IP under the providers' rate limits:
  a title hits the provider once, then is served from memory to everyone for 6h.

## Run it

Needs Node 18+ (has built-in `fetch`). No `npm install` — zero dependencies.

### Quick test (temporary URL, no account)
```bash
bash start.sh
```
Prints a `https://<random>.trycloudflare.com` URL. That URL is the resolver,
reachable from anywhere. The URL **changes every run** — fine for testing, not
for production.

Test it:
```bash
curl "https://<random>.trycloudflare.com/api/stream?tmdbId=550&type=movie&title=Fight+Club&year=1999"
```

### Production (STABLE URL on your own domain)
A quick tunnel's URL rotates, so the frontend can't hardcode it. Use a **named
tunnel** bound to a subdomain of `pstream.watch` (already on Cloudflare):

```bash
./cloudflared tunnel login                       # opens browser, pick pstream.watch
./cloudflared tunnel create pstream-resolver     # creates a persistent tunnel
./cloudflared tunnel route dns pstream-resolver resolver.pstream.watch
# run it (points resolver.pstream.watch → localhost:8790):
./cloudflared tunnel --hostname resolver.pstream.watch --url http://localhost:8790 run pstream-resolver
```

Now `https://resolver.pstream.watch` is a permanent address for this resolver,
and it survives your IP changing (which mobile IPs do).

## Point the frontend at it

In the frontend's Cloudflare Pages env vars, set:
```
VITE_GIGA_BACKEND_URL = https://resolver.pstream.watch
```
The player already calls `${VITE_GIGA_BACKEND_URL}/api/stream` and already falls
back to embeds when it returns nothing — so when this machine is off, the site
degrades gracefully instead of breaking.

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/ping` | health check |
| `GET /api/stream?tmdbId=&type=movie\|tv&season=&episode=&title=&year=` | resolve a playable source |

Response: `{ success, provider, sources: [{ url, quality, isM3U8, noProxy }], subtitles }`
