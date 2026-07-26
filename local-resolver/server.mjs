/**
 * P-Stream Local Resolver
 * ───────────────────────
 * A tiny, self-contained stream resolver meant to run on a machine with a
 * residential/mobile IP (a home computer tethered to a phone, etc.).
 *
 * WHY THIS EXISTS
 * The providers (vixsrc.to, lmscript.xyz) hand their data to anyone, but they
 * 403 requests from datacenter IPs — which is every cloud host, including the
 * HuggingFace Space. A home/mobile connection is exactly the kind of IP they
 * accept. This process does hop 2 (server -> provider) from that good IP and
 * exposes hop 1 (browser -> here) as a CORS-open endpoint the frontend reads.
 *
 * The browser then streams the video straight from the CDN (the manifests and
 * segments send Access-Control-Allow-Origin:*), so this box only ever handles a
 * few KB of resolution JSON per title — never the video.
 *
 * ZERO DEPENDENCIES. Node 18+ has global fetch and http. Run with:
 *     node server.mjs
 * Then expose it with a free Cloudflare Tunnel (see README.md).
 */

import http from 'http';

const PORT = process.env.PORT || 8790;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function getText(url, headers = {}, timeoutMs = 15000) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, ok: r.ok, text: await r.text() };
}
async function getJson(url, headers = {}, timeoutMs = 15000) {
    const { status, ok, text } = await getText(url, { Accept: 'application/json', ...headers }, timeoutMs);
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status, ok, json };
}

// ── VixSrc ───────────────────────────────────────────────────────────────────
// Two-step mint: the token on the /embed/ URL is a ~10s credential for the
// embed page; the real playlist token (~60 day life) is published as
// window.masterPlaylist.params INSIDE that page. Build the URL from that one.
const VIX = 'https://vixsrc.to';
const VIX_H = { Referer: `${VIX}/`, Origin: VIX };

async function resolveVixSrc(type, tmdbId, season, episode) {
    const apiPath = type === 'movie' ? `/api/movie/${tmdbId}` : `/api/tv/${tmdbId}/${season}/${episode}`;
    const api = await getJson(`${VIX}${apiPath}`, VIX_H, 10000);
    if (!api.json?.src) return null;

    const embedUrl = api.json.src.startsWith('http') ? api.json.src : `${VIX}${api.json.src}`;
    const page = await getText(embedUrl, { ...VIX_H, Accept: 'text/html' }, 12000);

    const anchor = page.text.indexOf('masterPlaylist');
    if (anchor === -1) return null;
    const block = page.text.slice(anchor, anchor + 1500);

    const token = block.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/)?.[1];
    const expires = block.match(/['"]expires['"]\s*:\s*['"]?(\d{9,})['"]?/)?.[1];
    const base = block.match(/url:\s*['"]([^'"]*\/playlist\/[^'"]*)['"]/)?.[1]?.replace(/\\\//g, '/');
    if (!token || !expires || !base) return null;

    const url = `${base}?token=${token}&expires=${expires}${/canPlayFHD=1/.test(embedUrl) ? '&h=1' : ''}`;

    // Verify — VixSrc lists titles it cannot serve; those 403 here, and we would
    // rather return nothing than a dead URL that starves the fallback.
    const check = await getText(url, { ...VIX_H, Accept: '*/*' }, 10000);
    if (!check.ok || !check.text.trimStart().startsWith('#EXTM3U')) return null;

    return {
        provider: 'VixSrc ⚡', providerId: 'vixsrc',
        sources: [{ url, quality: /&h=1/.test(url) ? '1080p' : '720p', isM3U8: true, noProxy: true, referer: `${VIX}/` }],
        subtitles: [],
    };
}

// ── LookMovie ────────────────────────────────────────────────────────────────
// Plain JSON API: search -> (show episode lookup) -> view (streams + subtitles).
const LM = 'https://lmscript.xyz';

async function resolveLookMovie(type, tmdbId, season, episode, title, year) {
    if (!title) return null;
    const isShow = type !== 'movie';

    const search = await getJson(`${LM}${isShow ? '/v1/shows' : '/v1/movies'}?filters%5Bq%5D=${encodeURIComponent(title)}`, {}, 6000);
    const items = search.json?.items || [];
    const match = items.find(i => i.title?.toLowerCase() === title.toLowerCase() && (!year || Number(i.year) === Number(year))) || items[0];
    if (!match) return null;

    let mediaId = match.id_movie;
    if (isShow) {
        const details = await getJson(`${LM}/v1/shows?expand=episodes&id=${match.id_show}`, {}, 6000);
        const ep = details.json?.episodes?.find(e => Number(e.season) === Number(season) && Number(e.episode) === Number(episode));
        mediaId = ep?.id;
    }
    if (!mediaId) return null;

    const view = await getJson(`${LM}${isShow ? '/v1/episodes/view' : '/v1/movies/view'}?expand=streams,subtitles&id=${mediaId}`, {}, 6000);
    const streams = view.json?.streams || {};
    const url = ['auto', '1080p', '1080', '720p', '720', '480p', '480'].map(q => streams[q]).find(Boolean);
    if (!url) return null;

    const subtitles = (view.json?.subtitles || []).map(s => ({
        url: s.url.startsWith('http') ? s.url : `${LM}${s.url}`,
        lang: s.language, label: s.language,
    }));

    return {
        provider: 'LookMovie 🎬', providerId: 'lookmovie',
        // noProxy: LookMovie's stream host serves ACAO:*, so it plays direct.
        sources: [{ url, quality: 'auto', isM3U8: true, noProxy: true }],
        subtitles,
    };
}

// ── Resolver: race both, first real answer wins ──────────────────────────────
async function resolve({ tmdbId, type, season, episode, title, year }) {
    const providers = [
        resolveVixSrc(type, tmdbId, season, episode).catch(() => null),
        resolveLookMovie(type, tmdbId, season, episode, title, year).catch(() => null),
    ];
    const results = (await Promise.all(providers)).filter(Boolean);
    if (!results.length) return { success: false, error: 'No stream found. All providers are currently unavailable.' };

    // VixSrc first when present — cleaner 1080p HLS — else whatever answered.
    const winner = results.find(r => r.providerId === 'vixsrc') || results[0];
    const subtitles = results.flatMap(r => r.subtitles || []);
    return { success: true, provider: winner.provider, providerId: winner.providerId, sources: winner.sources, subtitles };
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// Every user's resolution goes out over this one machine's single IP, so that
// IP is the rate-limit bottleneck (not each visitor's network — the browser's
// CORS rules make per-visitor resolution impossible). Caching is what keeps the
// IP safe: a resolved URL stays valid for a long time (VixSrc playlist tokens
// live ~60 days), so a title hits the provider once and is then served from
// memory to everyone else. Provider load scales with UNIQUE TITLES, not with
// viewers or replays — 100 people watching the same 20 films is ~20 hits.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — well short of token life, self-heals if a title breaks
const MAX_CACHE_ENTRIES = 5000;
const cache = new Map();

function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    // refresh recency for simple LRU-ish eviction
    cache.delete(key); cache.set(key, e);
    return e.data;
}
function cacheSet(key, data) {
    cache.set(key, { at: Date.now(), data });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

// ── Server ───────────────────────────────────────────────────────────────────
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(obj)); };

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/ping' || url.pathname === '/') return send(200, { ok: true, service: 'local-resolver' });

    if (url.pathname === '/api/stream') {
        const q = url.searchParams;
        const tmdbId = q.get('tmdbId');
        const type = q.get('type') === 'tv' ? 'tv' : 'movie';
        if (!tmdbId) return send(400, { success: false, error: 'tmdbId required' });

        const season = q.get('season') || '1', episode = q.get('episode') || '1';
        const cacheKey = `${type}:${tmdbId}:${season}:${episode}`;

        // Serve a hot title from memory — no provider request at all.
        const hit = cacheGet(cacheKey);
        if (hit) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...CORS });
            return res.end(JSON.stringify(hit));
        }

        const started = Date.now();
        try {
            const out = await resolve({
                tmdbId, type, season, episode,
                title: q.get('title') || '', year: q.get('year') || '',
            });
            if (out.success) cacheSet(cacheKey, out); // never cache a miss — a title may appear later
            console.log(`[resolve] ${type}/${tmdbId} -> ${out.success ? out.provider : 'MISS'} (${Date.now() - started}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...CORS });
            return res.end(JSON.stringify(out));
        } catch (e) {
            console.error('[resolve] error', e.message);
            return send(200, { success: false, error: e.message });
        }
    }

    send(404, { success: false, error: 'not_found' });
}).listen(PORT, () => console.log(`[local-resolver] listening on http://localhost:${PORT}`));
