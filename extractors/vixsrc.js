import { proxyAxios, gigaAxios } from '../utils/http.js';

/**
 * VixSrc Extractor — v4 (2026-07-18)
 *
 * ── Why v3 returned unplayable URLs ─────────────────────────────────────────
 * v3 read `token`/`expires` off the **embed** URL and concatenated them into a
 * `/playlist/{id}` URL. Those are two different credentials:
 *
 *   embed token     — from /api/{type}/{id}, lives ~10 seconds, only valid for
 *                     the /embed/ page itself.
 *   playlist token  — published as `window.masterPlaylist.params` INSIDE the
 *                     embed page, lives ~60 days, the only token /playlist/
 *                     accepts.
 *
 * v3 never fetched the embed page, so it emitted a guessed URL that always
 * 403s — while still reporting success:true. That made VixSrc win the resolver
 * race with a dead link and starved the other providers of their turn.
 *
 * ── Correct flow ────────────────────────────────────────────────────────────
 *   1. GET /api/{movie|tv}/...   → { src: "/embed/{id}?token=…&canPlayFHD=1" }
 *   2. GET that embed page       → HTML containing window.masterPlaylist
 *   3. Read params.token/expires + the playlist base URL from that page
 *   4. Build {base}?token=…&expires=…[&h=1]
 *
 * ── Networking ──────────────────────────────────────────────────────────────
 * vixsrc.to 403s datacenter IPs on EVERY path (homepage, /api, /playlist), so
 * steps 1–3 must go through the residential proxy chain. Verified 2026-07-18.
 * The video CDN (vix-content.net) does NOT block datacenter IPs.
 *
 * The emitted playlist serves `Access-Control-Allow-Origin: *` and needs no
 * Referer, so it is returned with noProxy:true — hls.js streams it straight
 * from the CDN. Video never touches our proxy, which is both faster and keeps
 * segment traffic off the metered proxy.
 *
 * NOTE: playing direct means the server-side "English audio filter" in
 * index.js never runs for these sources. VixSrc masters default to Italian
 * audio (DEFAULT=YES), so the client must select the English track itself.
 */

const BASE = 'https://vixsrc.to';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${BASE}/`,
    'Origin': BASE,
};

// Skip the validation fetch (saves one proxy request per resolve, at the cost
// of possibly emitting a dead URL). Off by default — see validateSource().
const SKIP_VALIDATION = process.env.VIXSRC_VALIDATE === '0';

// ── Worker fast path ────────────────────────────────────────────────────────
// Set VIXSRC_WORKER_URL to the deployed Cloudflare Worker (see worker/) and
// the whole mint happens at the edge instead of here.
//
// This matters for latency, not just cost. Direct from this Space every
// vixsrc.to request must traverse the residential-proxy → ScraperAPI chain,
// where a single hop can cost 8s+; three sequential requests cannot fit inside
// the resolver's ~13.5s budget, so VixSrc times out and returns nothing. The
// Worker collapses those three into one fast call from an IP vixsrc accepts.
const WORKER_URL = (process.env.VIXSRC_WORKER_URL || '').replace(/\/+$/, '');
const WORKER_KEY = process.env.VIXSRC_WORKER_KEY || '';

async function scrapeViaWorker(tmdbId, type, s, e) {
    const params = new URLSearchParams({ tmdbId: String(tmdbId), type });
    if (type !== 'movie') {
        params.set('season', String(s || 1));
        params.set('episode', String(e || 1));
    }
    if (WORKER_KEY) params.set('key', WORKER_KEY);

    // gigaAxios (direct from this Space) is correct here: the Worker is ours
    // and does not block datacenter IPs — only vixsrc.to does.
    const { data } = await gigaAxios.get(`${WORKER_URL}/vixsrc?${params.toString()}`, {
        timeout: 12000,
        headers: { Accept: 'application/json' },
    });

    if (!data?.success || !data.url) {
        console.log(`[VixSrc] Worker: ${data?.error || 'no url'}`);
        return null;
    }

    console.log(`[VixSrc] ✅ via Worker → ${data.quality}`);
    return {
        success: true,
        provider: 'VixSrc ⚡',
        sources: [{
            url: data.url,
            quality: data.quality || '1080p',
            isM3U8: true,
            noProxy: true,
            referer: `${BASE}/`,
        }],
        subtitles: [],
    };
}

/**
 * vixsrc.to blocks datacenter IPs, so the proxy chain is the primary transport.
 * The direct fallback exists for local/residential runs where no proxy is
 * configured — from a home IP vixsrc.to answers fine.
 */
async function vixGet(url, extra = {}) {
    const opts = { headers: HEADERS, timeout: 12000, ...extra };

    // IMPORTANT: do not pass validateStatus here. proxyAxios implements its
    // Tier-1 → Tier-2 (ScraperAPI) → Tier-3 fallback chain in a *response
    // error* interceptor, so a non-2xx has to reject for the fallback to run.
    // Suppressing the throw makes the residential proxy's 407 look like a
    // success and the request never falls through to ScraperAPI.
    try {
        return await proxyAxios.get(url, opts);
    } catch (proxyErr) {
        // Outside the datacenter (local/residential) vixsrc answers directly,
        // so a direct attempt is worth one try before giving up.
        try {
            return await gigaAxios.get(url, opts);
        } catch (_) {
            throw proxyErr;
        }
    }
}

/**
 * Pull the playlist credentials out of the embed page.
 * The page contains:
 *   window.masterPlaylist = { params: { 'token': '…', 'expires': '…' }, url: '…' }
 * `url` sits after the params object closes, so it is matched separately.
 */
function parseMasterPlaylist(html = '') {
    const anchor = html.indexOf('masterPlaylist');
    if (anchor === -1) return null;

    // Scope the credential search to the masterPlaylist block so we can't
    // accidentally match the embed URL's own token/expires query params.
    const block = html.slice(anchor, anchor + 1500);

    const token = block.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/)?.[1];
    const expires = block.match(/['"]expires['"]\s*:\s*['"]?(\d{9,})['"]?/)?.[1];
    const url = block.match(/url:\s*['"]([^'"]*\/playlist\/[^'"]*)['"]/)?.[1]?.replace(/\\\//g, '/');

    if (!token || !expires || !url) return null;
    return { token, expires, url };
}

/**
 * VixSrc answers 200 + #EXTM3U for a real title and 403 for one it lists but
 * cannot serve. Without this check a dead URL still wins the resolver race and
 * blocks every fallback provider, which is the failure mode v3 shipped.
 */
async function validateSource(url) {
    if (SKIP_VALIDATION) return true;
    try {
        const res = await vixGet(url, {
            headers: { ...HEADERS, Accept: '*/*' },
            timeout: 10000,
            responseType: 'text',
        });
        return String(res.data || '').trimStart().startsWith('#EXTM3U');
    } catch (_) {
        return false;
    }
}

export async function scrapeVixSrc(tmdbId, type, s, e) {
    // Prefer the edge Worker when configured; fall back to the direct flow
    // below so local/residential runs (and an unreachable Worker) still work.
    if (WORKER_URL) {
        try {
            return await scrapeViaWorker(tmdbId, type, s, e);
        } catch (err) {
            console.warn(`[VixSrc] Worker unreachable (${err.message}) — falling back to direct`);
        }
    }

    try {
        const apiPath = type === 'movie'
            ? `/api/movie/${tmdbId}`
            : `/api/tv/${tmdbId}/${s}/${e}`;

        // ── Step 1: signed embed src ────────────────────────────────────────
        const apiRes = await vixGet(`${BASE}${apiPath}`, {
            headers: { ...HEADERS, Accept: 'application/json' },
            timeout: 10000,
        });

        const apiData = typeof apiRes.data === 'string'
            ? (() => { try { return JSON.parse(apiRes.data); } catch { return null; } })()
            : apiRes.data;

        if (!apiData?.src) {
            console.log(`[VixSrc] Not in catalog: ${apiPath}`);
            return null;
        }

        const embedUrl = apiData.src.startsWith('http') ? apiData.src : `${BASE}${apiData.src}`;

        // ── Step 2: embed page (holds the real playlist credentials) ────────
        const pageRes = await vixGet(embedUrl, {
            headers: { ...HEADERS, Accept: 'text/html' },
            timeout: 12000,
            responseType: 'text',
        });

        // ── Step 3: parse credentials ───────────────────────────────────────
        const master = parseMasterPlaylist(String(pageRes.data || ''));
        if (!master) {
            console.warn('[VixSrc] masterPlaylist block not found in embed page');
            return null;
        }

        // ── Step 4: build the playlist URL ──────────────────────────────────
        // canPlayFHD gates the 1080p rendition behind &h=1.
        const canPlayFHD = /canPlayFHD=1/.test(embedUrl);
        const playlistUrl =
            `${master.url}?token=${master.token}&expires=${master.expires}${canPlayFHD ? '&h=1' : ''}`;

        if (!(await validateSource(playlistUrl))) {
            console.warn(`[VixSrc] Playlist rejected for ${apiPath} — not serving a dead source`);
            return null;
        }

        console.log(`[VixSrc] ✅ ${apiPath} → ${canPlayFHD ? '1080p' : '720p'}`);

        return {
            success: true,
            provider: 'VixSrc ⚡',
            sources: [{
                url: playlistUrl,
                quality: canPlayFHD ? '1080p' : '720p',
                isM3U8: true,
                // CORS is open and no Referer is required, so the browser
                // streams this straight from the CDN — no proxy hop.
                noProxy: true,
                referer: `${BASE}/`,
            }],
            subtitles: [],
        };

    } catch (error) {
        console.warn(`[VixSrc] Error: ${error.message}`);
        return null;
    }
}
