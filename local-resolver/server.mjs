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
import { Readable } from 'stream';
import { execSync } from 'child_process';
import { scrapeWatchFlix }                 from '../extractors/watchflix.js';
import { scrapeBingr }                     from '../extractors/bingr.js';
import { scrapeFireFlix }                  from '../extractors/fireflix.js';
import { scrape1Shows }                    from '../extractors/oneshows.js';
import { scrapeCinemaOS }                  from '../extractors/cinemaos.js';
import { scrapeAuroraScreen }              from '../extractors/aurorascreen.js';
import { scrapeMiruro }                    from '../extractors/miruro.js';
import { scrapeBSTSrs }                    from '../extractors/bstsrs.js';
import { scrapeDramaCool }                 from '../extractors/dramacool.js';
import { scrapeMovieBox }                  from '../extractors/moviebox.js';
import { scrapeNontonGo }                  from '../extractors/nontongo.js';

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
        // noProxy: false — LookMovie stream URLs are IP-bound to this machine's IP,
        // so visitor browsers must route requests through /proxy/stream.
        sources: [{ url, quality: 'auto', isM3U8: true, noProxy: false }],
        subtitles,
    };
}

// ── M3U8 Manifest Rewriter for Proxy ──────────────────────────────────────────
function rewriteProxyManifest(text, baseUrl, headersParam = '') {
    const lines = text.split(/\r?\n/);
    return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('#')) {
            if (/URI=/i.test(trimmed)) {
                return trimmed.replace(/URI=(['"]?)(.*?)\1/i, (match, quote, p2) => {
                    let absoluteUrl = p2;
                    try { absoluteUrl = new URL(p2, baseUrl).href; } catch (e) { return match; }
                    return `URI=${quote}/proxy/stream?url=${encodeURIComponent(absoluteUrl)}${headersParam}${quote}`;
                });
            }
            return trimmed;
        }
        let absoluteUrl = trimmed;
        try { absoluteUrl = new URL(trimmed, baseUrl).href; } catch (e) { return trimmed; }
        return `/proxy/stream?url=${encodeURIComponent(absoluteUrl)}${headersParam}`;
    }).join('\n');
}

// ── Provider health ──────────────────────────────────────────────────────────
// Tracks which providers are actually delivering so the preferred one can be
// ordered first. Kept in memory only — it's a hint for ordering, not state we
// need to survive a restart.
const health = new Map(); // providerId -> { ok, fail, lastMs }

function recordHealth(providerId, ok, ms) {
    const h = health.get(providerId) || { ok: 0, fail: 0, lastMs: 0 };
    if (ok) h.ok++; else h.fail++;
    h.lastMs = ms;
    health.set(providerId, h);
}

function successRate(providerId) {
    const h = health.get(providerId);
    if (!h || (h.ok + h.fail) < 5) return 0.5; // too few samples — stay neutral
    return h.ok / (h.ok + h.fail);
}

// ── Resolver: race providers, return EVERY working source ────────────────────
// Both providers are queried in parallel for latency, and every one that
// answers is returned — not just the winner. The player already cycles through
// `sources` when a URL turns out dead at playback time, so handing it a spare
// avoids a full re-resolve (and therefore a second round of provider requests
// over our single IP). Previously the loser's perfectly good URL was discarded.
async function resolve({ tmdbId, type, season, episode, title, year }) {
    const run = async (id, fn) => {
        const t0 = Date.now();
        try {
            const r = await fn();
            recordHealth(id, !!r, Date.now() - t0);
            return r;
        } catch {
            recordHealth(id, false, Date.now() - t0);
            return null;
        }
    };

    const results = (await Promise.all([
        run('vixsrc',       () => resolveVixSrc(type, tmdbId, season, episode)),
        run('lookmovie',    () => resolveLookMovie(type, tmdbId, season, episode, title, year)),
        run('watchflix',    () => scrapeWatchFlix(tmdbId, type, season, episode)),
        run('bingr',        () => scrapeBingr(tmdbId, type, season, episode)),
        run('fireflix',     () => scrapeFireFlix(tmdbId, type, season, episode)),
        run('oneshows',     () => scrape1Shows(tmdbId, type, season, episode)),
        run('cinemaos',     () => scrapeCinemaOS(tmdbId, type, season, episode)),
        run('aurorascreen', () => scrapeAuroraScreen(tmdbId, type, season, episode)),
        run('miruro',       () => scrapeMiruro(tmdbId, type, season, episode)),
        run('bstsrs',       () => scrapeBSTSrs(tmdbId, type, season, episode)),
        run('dramacool',    () => scrapeDramaCool(tmdbId, type, season, episode)),
        run('moviebox',     () => scrapeMovieBox(title, year)),
        run('nontongo',     () => scrapeNontonGo(tmdbId, type, season, episode)),
    ])).filter(Boolean);

    if (!results.length) return { success: false, error: 'No stream found. All providers are currently unavailable.' };

    // Unbiased ordering: treat all working providers equally based on response timing
    const ranked = [...results];

    const sources = ranked.flatMap(r => r.sources || []);
    const subtitles = ranked.flatMap(r => r.subtitles || []);
    const winner = ranked[0];
    return {
        success: true,
        provider: winner.provider,
        providerId: winner.providerId,
        // Every working source, best first — the player falls back through these.
        sources,
        subtitles,
    };
}

// ── YouTube trailer search (keyless) ─────────────────────────────────────────
// The frontend used to call the YouTube Data API directly, which meant shipping
// API keys in the browser bundle — where anyone could read them (Vite inlines
// any VITE_* value). Doing the search here instead means no key ever reaches a
// visitor. We scrape YouTube's own search page rather than using the Data API,
// so there is no key to leak in the first place and no quota to exhaust.
//
// Returns title + channel alongside the id because the frontend scores
// candidates on those to pick the best-matching trailer.
async function youtubeSearch(query, maxResults = 5) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
    const { text } = await getText(url, {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
    }, 12000);

    // Search results are embedded as ytInitialData JSON inside the page.
    const out = [];
    const seen = new Set();
    const re = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"(.*?)"ownerText":\{"runs":\[\{"text":"(.*?)"/g;
    let m;
    while ((m = re.exec(text)) !== null && out.length < maxResults) {
        const videoId = m[1];
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        // Title lives in the chunk between the id and ownerText.
        const titleMatch = /"title":\{"runs":\[\{"text":"(.*?)"/.exec(m[2]);
        const decode = (s) => {
            try { return JSON.parse(`"${s}"`); } catch { return s; }
        };
        out.push({
            videoId,
            title: titleMatch ? decode(titleMatch[1]) : '',
            channelTitle: decode(m[3]),
        });
    }
    return out;
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

// ── SubDL subtitle search ────────────────────────────────────────────────────
// Same reasoning as the YouTube endpoint: the frontend used to call SubDL
// where anyone can read it. Only the SEARCH needs the key — the subtitle files
// SubDL returns are plain public URLs the browser can still fetch itself, so we
// proxy just this one call and the key never leaves this machine.
//
// Set SUBDL_API_KEY (no VITE_ prefix) in the environment to enable.
const SUBDL_KEY = process.env.SUBDL_API_KEY || '';

async function subdlSearch({ tmdbId, type, season, episode, langs }) {
    if (!SUBDL_KEY) return { subtitles: [], error: 'SUBDL_API_KEY not configured' };
    let url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(SUBDL_KEY)}`
        + `&tmdb_id=${encodeURIComponent(tmdbId)}&type=${type === 'tv' ? 'tv' : 'movie'}`
        + `&subs_per_page=30&language=${encodeURIComponent(langs)}`;
    if (type === 'tv') url += `&season_number=${encodeURIComponent(season)}&episode_number=${encodeURIComponent(episode)}`;

    const { ok, status, json } = await getJson(url, {}, 10000);
    if (!ok) return { subtitles: [], error: `SubDL HTTP ${status}` };
    return { subtitles: Array.isArray(json?.subtitles) ? json.subtitles : [] };
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Every resolve goes out over this machine's ONE IP. Anyone who finds this URL
// could otherwise hammer it — burning mobile data and, worse, getting that
// single IP rate-limited or banned by the providers, which takes the whole site
// down. Cache hits are free; only real provider work is counted.
const RATE_MAX = 30;              // provider-hitting requests…
const RATE_WINDOW_MS = 60 * 1000; // …per IP per minute
const rate = new Map();

function clientIp(req) {
    return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
        .toString().split(',')[0].trim();
}

function rateLimited(ip) {
    const now = Date.now();
    const e = rate.get(ip);
    if (!e || now > e.reset) { rate.set(ip, { n: 1, reset: now + RATE_WINDOW_MS }); return false; }
    e.n++;
    return e.n > RATE_MAX;
}
// Keep the map from growing without bound.
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rate) if (now > e.reset) rate.delete(ip);
}, RATE_WINDOW_MS).unref?.();

// ── Server ───────────────────────────────────────────────────────────────────
// Only our own front-ends may call this from a browser. This does not stop
// scripted abuse (curl ignores CORS) — that's what the rate limit is for — but
// it does stop other websites using this resolver as free infrastructure.
const ALLOWED_ORIGINS = [
    'https://pstream.watch',
    'https://www.pstream.watch',
    'http://localhost:5173',
    'http://localhost:5199',
    'http://localhost:4173',
];
function corsFor(req) {
    const origin = req.headers.origin;
    const ok = !origin || ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.pages\.dev$/.test(origin);
    return {
        'Access-Control-Allow-Origin': ok ? (origin || '*') : 'https://pstream.watch',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}

http.createServer(async (req, res) => {
    const CORS = corsFor(req);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(obj)); };

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/ping' || url.pathname === '/') return send(200, { ok: true, service: 'local-resolver' });

    // ── Stream proxy: proxies M3U8 playlists & segments through this machine's IP ──
    if (url.pathname === '/proxy/stream') {
        const targetUrlRaw = url.searchParams.get('url');
        if (!targetUrlRaw) return send(400, { success: false, error: 'url parameter required' });

        let targetUrl = targetUrlRaw;
        try { targetUrl = decodeURIComponent(targetUrlRaw); } catch {}

        let customHeaders = {};
        const headersParam = url.searchParams.get('headers');
        if (headersParam) {
            try { customHeaders = JSON.parse(headersParam); } catch {}
        }

        const fetchHeaders = {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            ...customHeaders,
        };

        try {
            const upstream = await fetch(targetUrl, {
                headers: fetchHeaders,
                signal: AbortSignal.timeout(15000),
            });

            if (!upstream.ok && upstream.status !== 206) {
                res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
                return res.end(JSON.stringify({ error: `Upstream returned status ${upstream.status}` }));
            }

            const contentType = upstream.headers.get('content-type') || '';
            const isManifest = contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8');

            if (isManifest) {
                const text = await upstream.text();
                if (text.startsWith('#EXTM3U')) {
                    const encodedHeadersParam = headersParam ? `&headers=${encodeURIComponent(headersParam)}` : '';
                    const rewritten = rewriteProxyManifest(text, targetUrl, encodedHeadersParam);
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Cache-Control': 'no-cache',
                        ...CORS,
                    });
                    return res.end(rewritten);
                }
            }

            // Binary video segment/subtitle stream
            const resHeaders = {
                'Content-Type': contentType || 'application/octet-stream',
                'Cache-Control': 'public, max-age=3600',
                ...CORS,
            };
            const contentLength = upstream.headers.get('content-length');
            if (contentLength) resHeaders['Content-Length'] = contentLength;
            const contentRange = upstream.headers.get('content-range');
            if (contentRange) resHeaders['Content-Range'] = contentRange;

            res.writeHead(upstream.status, resHeaders);
            if (upstream.body) {
                Readable.fromWeb(upstream.body).pipe(res);
            } else {
                res.end();
            }
            return;
        } catch (e) {
            console.warn('[proxy/stream] error:', e.message);
            return send(500, { error: `Proxy failed: ${e.message}` });
        }
    }

    // Trailer search — keeps YouTube API keys out of the browser entirely.
    if (url.pathname === '/api/youtube/search') {
        const ip = clientIp(req);
        if (rateLimited(ip)) return send(429, { error: 'Rate limit exceeded' });
        const origin = req.headers.origin || req.headers.referer || '';
        if (!origin.includes('pstream.watch') && !origin.includes('localhost') && !origin.includes('.pages.dev')) return send(403, { error: 'Forbidden' });

        const q = (url.searchParams.get('q') || '').slice(0, 200).trim();
        if (!q) return send(400, { results: [], error: 'q required' });
        const maxResults = Math.min(Math.max(parseInt(url.searchParams.get('maxResults') || '5', 10) || 5, 1), 10);

        const key = `yt:${q}:${maxResults}`;
        const hit = cacheGet(key);
        if (hit) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...CORS });
            return res.end(JSON.stringify(hit));
        }

        try {
            const results = await youtubeSearch(q, maxResults);
            const payload = { results };
            if (results.length) cacheSet(key, payload);
            console.log(`[yt] "${q.slice(0, 40)}" -> ${results.length} result(s)`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...CORS });
            return res.end(JSON.stringify(payload));
        } catch (e) {
            console.warn('[yt] search failed:', e.message);
            return send(200, { results: [], error: e.message });
        }
    }

    // Subtitle search — keeps the SubDL API key out of the browser.
    if (url.pathname === '/api/subtitles/subdl') {
        const ip = clientIp(req);
        if (rateLimited(ip)) return send(429, { error: 'Rate limit exceeded' });
        const origin = req.headers.origin || req.headers.referer || '';
        if (!origin.includes('pstream.watch') && !origin.includes('localhost') && !origin.includes('.pages.dev')) return send(403, { error: 'Forbidden' });

        const q = url.searchParams;
        const tmdbId = q.get('tmdbId');
        if (!tmdbId || !/^\d{1,12}$/.test(tmdbId)) return send(400, { subtitles: [], error: 'tmdbId must be numeric' });
        const type = q.get('type') === 'tv' ? 'tv' : 'movie';
        const season = (q.get('season') || '1').replace(/\D/g, '').slice(0, 4) || '1';
        const episode = (q.get('episode') || '1').replace(/\D/g, '').slice(0, 5) || '1';
        // Comma-separated ISO codes; strip anything that isn't a code so the
        // value can't be used to reshape the upstream query.
        const langs = (q.get('langs') || 'en').split(',').map(s => s.trim().toLowerCase())
            .filter(s => /^[a-z]{2,3}$/.test(s)).slice(0, 10).join(',') || 'en';

        const key = `subdl:${type}:${tmdbId}:${season}:${episode}:${langs}`;
        const hit = cacheGet(key);
        if (hit) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...CORS });
            return res.end(JSON.stringify(hit));
        }

        if (rateLimited(clientIp(req))) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...CORS });
            return res.end(JSON.stringify({ subtitles: [], error: 'Too many requests' }));
        }

        try {
            const out = await subdlSearch({ tmdbId, type, season, episode, langs });
            if (out.subtitles.length) cacheSet(key, out);
            console.log(`[subdl] ${type}/${tmdbId} -> ${out.subtitles.length} result(s)`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...CORS });
            return res.end(JSON.stringify(out));
        } catch (e) {
            console.warn('[subdl] failed:', e.message);
            return send(200, { subtitles: [], error: e.message });
        }
    }

    if (url.pathname === '/api/stream') {
        const q = url.searchParams;
        const type = q.get('type') === 'tv' ? 'tv' : 'movie';

        // Validate before use: these are interpolated straight into provider URL
        // paths (/api/tv/{id}/{season}/{episode}), so anything but digits could
        // reshape the request path — and unbounded values would let a caller
        // flood the cache with junk keys and evict real entries.
        const tmdbId = q.get('tmdbId');
        if (!tmdbId || !/^\d{1,12}$/.test(tmdbId)) {
            return send(400, { success: false, error: 'tmdbId must be numeric' });
        }

        const seasonRaw = q.get('season') || '1', episodeRaw = q.get('episode') || '1';
        if (!/^\d{1,4}$/.test(seasonRaw) || !/^\d{1,5}$/.test(episodeRaw)) {
            return send(400, { success: false, error: 'season/episode must be numeric' });
        }
        const season = seasonRaw, episode = episodeRaw;
        // Titles only feed a search query; cap the length so one caller can't
        // push huge strings through the provider or into our logs.
        const title = (q.get('title') || '').slice(0, 200);
        const year = (q.get('year') || '').slice(0, 4);
        const cacheKey = `${type}:${tmdbId}:${season}:${episode}`;

        // Serve a hot title from memory — no provider request at all. Cache hits
        // are deliberately NOT rate-limited: they cost us nothing.
        const hit = cacheGet(cacheKey);
        if (hit) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...CORS });
            return res.end(JSON.stringify(hit));
        }

        // Past this point we'd hit a provider over our single IP — so meter it.
        const ip = clientIp(req);
        if (rateLimited(ip)) {
            console.warn(`[resolve] rate-limited ${ip}`);
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...CORS });
            return res.end(JSON.stringify({ success: false, error: 'Too many requests — please slow down.' }));
        }

        const started = Date.now();
        try {
            const out = await resolve({
                tmdbId, type, season, episode, title, year,
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

    // ── Remote deploy: git pull + restart ──────────────────────────────────────
    if (url.pathname === '/api/deploy' && req.method === 'POST') {
        const secret = process.env.DEPLOY_SECRET;
        if (!secret) {
            return send(404, { success: false, error: 'not_found' });
        }

        const provided = req.headers['x-deploy-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
        if (!provided || provided !== secret) {
            return send(403, { success: false, error: 'Invalid deploy secret' });
        }

        try {
            const cwd = new URL('..', import.meta.url).pathname;
            const pullOutput = execSync('git pull origin main', { cwd, timeout: 30000 }).toString();
            console.log('[deploy] git pull:', pullOutput.trim());

            res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
            res.end(JSON.stringify({ success: true, pull: pullOutput.trim(), restarting: true }));

            // Give the response time to flush, then restart
            setTimeout(() => {
                console.log('[deploy] Restarting process...');
                process.exit(0); // Termux auto-restart / pm2 / systemd will bring it back
            }, 500);
            return;
        } catch (e) {
            console.error('[deploy] failed:', e.message);
            return send(500, { success: false, error: e.message });
        }
    }

    send(404, { success: false, error: 'not_found' });
}).listen(PORT, () => console.log(`[local-resolver] listening on http://localhost:${PORT}`));
