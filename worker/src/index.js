/**
 * pstream-vixsrc — VixSrc minting Worker
 *
 * WHY THIS EXISTS
 * vixsrc.to sits behind Cloudflare and 403s datacenter IPs, including the
 * HuggingFace Space's whole range — every path, not just /api. It is pure IP
 * reputation, not bot detection: the same requests succeed from a residential
 * IP with a plain `curl/8.0` User-Agent.
 *
 * The Space's workaround was a residential-proxy → ScraperAPI chain, which is
 * metered AND slow: each hop can burn 8s+, and resolving a stream needs three
 * sequential requests (API → embed page → validation). That blows past the
 * resolver's ~13.5s budget, so VixSrc never returns in time.
 *
 * This Worker performs all three requests from Cloudflare's edge and hands the
 * backend a finished, validated playlist URL. The Space makes ONE fast call
 * instead of three slow proxied ones, and ScraperAPI leaves the path entirely.
 *
 * WHAT IT RETURNS
 *   GET /vixsrc?tmdbId=550&type=movie
 *   GET /vixsrc?tmdbId=1396&type=tv&season=1&episode=1
 *     -> { success: true, url, quality, expires }
 *     -> { success: false, error }
 *
 * Responses are CORS-open so the browser can call this directly too.
 */

const VIX = 'https://vixsrc.to';

const UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${VIX}/`,
    'Origin': VIX,
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Playlist tokens are valid ~60 days, so a resolved URL stays good for a long
// time. Cache well short of that so a re-encode or pulled title recovers on its
// own, while still collapsing repeat traffic for popular titles.
const CACHE_SECONDS = 6 * 60 * 60;

function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
    });
}

/**
 * The two-step mint.
 *
 * The credential that /playlist/ accepts is NOT the token on the /embed/ URL —
 * that one is a ~10s credential for the embed page itself. The real one is
 * published as `window.masterPlaylist.params` inside that page and lives ~60
 * days. Building the playlist URL from the embed token (as the old extractor
 * did) always 403s.
 */
async function mintPlaylist(type, tmdbId, season, episode) {
    const apiPath = type === 'movie'
        ? `/api/movie/${tmdbId}`
        : `/api/tv/${tmdbId}/${season}/${episode}`;

    const apiRes = await fetch(`${VIX}${apiPath}`, {
        headers: { ...UPSTREAM_HEADERS, Accept: 'application/json' },
    });
    if (!apiRes.ok) return { error: `api_http_${apiRes.status}` };

    const data = await apiRes.json().catch(() => null);
    if (!data?.src) return { error: 'not_in_catalog' };

    const embedUrl = data.src.startsWith('http') ? data.src : `${VIX}${data.src}`;

    const pageRes = await fetch(embedUrl, {
        headers: { ...UPSTREAM_HEADERS, Accept: 'text/html' },
    });
    if (!pageRes.ok) return { error: `embed_http_${pageRes.status}` };

    const html = await pageRes.text();

    // Scope the search to the masterPlaylist block so the embed URL's own
    // token/expires query params can't be matched by mistake.
    const anchor = html.indexOf('masterPlaylist');
    if (anchor === -1) return { error: 'no_master_playlist' };
    const block = html.slice(anchor, anchor + 1500);

    const token = block.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/)?.[1];
    const expires = block.match(/['"]expires['"]\s*:\s*['"]?(\d{9,})['"]?/)?.[1];
    const base = block.match(/url:\s*['"]([^'"]*\/playlist\/[^'"]*)['"]/)?.[1]?.replace(/\\\//g, '/');
    if (!token || !expires || !base) return { error: 'parse_failed' };

    const canPlayFHD = /canPlayFHD=1/.test(embedUrl);
    const url = `${base}?token=${token}&expires=${expires}${canPlayFHD ? '&h=1' : ''}`;

    // VixSrc lists titles it cannot actually serve; those 403 here. Verifying
    // now means a dead URL never reaches the player, so the resolver can fall
    // through to another provider instead of dead-ending on a "success".
    const check = await fetch(url, { headers: { ...UPSTREAM_HEADERS, Accept: '*/*' } });
    if (!check.ok) return { error: `playlist_http_${check.status}` };

    const body = await check.text();
    if (!body.trimStart().startsWith('#EXTM3U')) return { error: 'not_a_manifest' };

    return { url, quality: canPlayFHD ? '1080p' : '720p', expires: Number(expires) };
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

        const url = new URL(request.url);

        if (url.pathname === '/health' || url.pathname === '/') {
            return json({ ok: true, service: 'pstream-vixsrc' });
        }

        if (url.pathname !== '/vixsrc') {
            return json({ success: false, error: 'not_found' }, 404);
        }

        // Optional shared secret. Set SHARED_SECRET to stop the Worker being
        // used as free minting capacity by anyone who finds the URL.
        if (env.SHARED_SECRET) {
            const provided = url.searchParams.get('key')
                || (request.headers.get('Authorization') || '').replace('Bearer ', '');
            if (provided !== env.SHARED_SECRET) {
                return json({ success: false, error: 'unauthorized' }, 401);
            }
        }

        const tmdbId = url.searchParams.get('tmdbId');
        const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
        const season = url.searchParams.get('season') || '1';
        const episode = url.searchParams.get('episode') || '1';

        if (!tmdbId || !/^\d+$/.test(tmdbId)) {
            return json({ success: false, error: 'tmdbId required' }, 400);
        }

        // Cache on the normalised identity, so a stray `key` or param ordering
        // doesn't fragment the cache.
        const cacheKey = new Request(
            `https://cache.invalid/vixsrc/${type}/${tmdbId}/${season}/${episode}`,
            { method: 'GET' }
        );
        const cache = caches.default;

        const hit = await cache.match(cacheKey);
        if (hit) {
            const cloned = new Response(hit.body, hit);
            cloned.headers.set('X-Cache', 'HIT');
            return cloned;
        }

        let result;
        try {
            result = await mintPlaylist(type, tmdbId, season, episode);
        } catch (e) {
            return json({ success: false, error: `upstream_error: ${e.message}` }, 502);
        }

        if (result.error) {
            // Negative results are deliberately not cached: a title missing
            // today may be encoded tomorrow.
            return json({ success: false, error: result.error, provider: 'vixsrc' }, 200);
        }

        const payload = {
            success: true,
            provider: 'VixSrc ⚡',
            providerId: 'vixsrc',
            url: result.url,
            quality: result.quality,
            expires: result.expires,
            isM3U8: true,
            // Playlist and segments send Access-Control-Allow-Origin:* and need
            // no Referer, so the player streams straight from the CDN.
            noProxy: true,
            referer: `${VIX}/`,
        };

        const response = json(payload, 200, {
            'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
            'X-Cache': 'MISS',
        });

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
    },
};
