/**
 * services/trailer.js
 * ────────────────────
 * yt-dlp powered trailer resolver for the giga-backend.
 *
 * Strategy:
 *  Pass 1 — search "{title} {year} 4K trailer"        (prefer 4K for hero zoom)
 *  Pass 2 — search "{title} {year} official trailer"  (fallback)
 *  Pass 3 — TMDB video IDs supplied by caller          (last resort, can be trolled)
 *
 * Returns the best scored video ID so the frontend can fetch
 * a stream URL from Piped independently (middleman delivers bytes).
 *
 * Residential proxy (RESIDENTIAL_PROXY_URL) is used so HF Space
 * can reach YouTube without SSL errors.
 */

import ytDlpExec from 'yt-dlp-exec';

const PROXY   = process.env.RESIDENTIAL_PROXY_URL || null;
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 h — trailer IDs don't change
const _cache  = new Map(); // key → { ts, data }

function cacheGet(key) {
    const h = _cache.get(key);
    if (!h) return null;
    if (Date.now() - h.ts > CACHE_TTL) { _cache.delete(key); return null; }
    return h.data;
}
function cacheSet(key, data) {
    if (_cache.size > 500) {
        const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) _cache.delete(oldest[0]);
    }
    _cache.set(key, { ts: Date.now(), data });
}

/** Base yt-dlp options */
function baseOpts(extra = {}) {
    const opts = {
        dumpSingleJson: true,
        noWarnings:     true,
        noCallHome:     true,
        skipDownload:   true,
        quiet:          true,
        socketTimeout:  20,
        addHeader: [
            'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language:en-US,en;q=0.9',
        ],
        ...extra,
    };
    if (PROXY) opts.proxy = PROXY;
    return opts;
}

/** Score a search result — higher = better trailer match */
function scoreResult(entry, title) {
    const t = (entry.title || '').toLowerCase();
    const normalTitle = (title || '').toLowerCase();
    let score = 0;

    // Hard disqualifiers
    if (/fan.?made|fan.?trailer|concept|ai.?trailer|deepfake/i.test(t)) return -9999;
    if (/reaction|review|analysis|essay|video.?essay/i.test(t))           return -9999;

    // Title match
    if (t.includes(normalTitle))          score += 20;
    else if (normalTitle.split(' ').filter(w => w.length > 3)
             .every(w => t.includes(w)))  score += 10;

    // 4K signals
    if (/\b4k\b|2160p|uhd|hdr/i.test(t)) score += 15;

    // Official trailer signals
    if (/official.?trailer/i.test(t))     score += 12;
    if (/\btrailer\b/i.test(t))           score +=  8;

    // Teaser / featurette (less preferred)
    if (/teaser/i.test(t))                score -=  5;
    if (/featurette|clip|scene/i.test(t)) score -= 10;

    // Duration: trailers are 60–300 s
    const dur = entry.duration || 0;
    if (dur >= 60 && dur <= 300)          score += 10;
    else if (dur > 0 && dur < 60)         score -=  5;
    else if (dur > 600)                   score -= 15;

    // View count popularity signal
    const views = entry.view_count || 0;
    if (views > 5_000_000)  score += 10;
    else if (views > 1_000_000) score += 5;

    return score;
}

/** Search YouTube via yt-dlp's ytsearch: prefix (no API key needed) */
async function ytSearch(query, limit = 5) {
    const key = `search:${query}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const info = await ytDlpExec(
        `ytsearch${limit}:${query}`,
        baseOpts({ flatPlaylist: true, extractFlat: true })
    );

    const entries = (info.entries || []).map(e => ({
        id:         e.id,
        title:      e.title || '',
        url:        e.url || `https://www.youtube.com/watch?v=${e.id}`,
        duration:   e.duration || 0,
        view_count: e.view_count || 0,
    }));

    cacheSet(key, entries);
    return entries;
}

/**
 * Resolve the best trailer video ID for a title.
 * Returns { videoId, title, score, source }
 *
 * @param {string} title        Movie/show title
 * @param {string} [year]       Release year (helps precision)
 * @param {'movie'|'tv'} [type]
 * @param {string[]} [tmdbIds]  TMDB-sourced YouTube IDs (used as Pass 3 fallback)
 */
export async function resolveTrailerId(title, year = '', type = 'movie', tmdbIds = []) {
    const cacheKey = `resolve:${title}:${year}:${type}`;
    const cached   = cacheGet(cacheKey);
    if (cached) return cached;

    const suffix = type === 'tv' ? 'official trailer season 1' : 'official trailer';
    const yearStr = year ? ` ${year}` : '';

    // Pass 1+2: yt-dlp YouTube search (4K first, official trailer fallback)
    // These may fail on HF datacenter IPs — caught gracefully below
    let pass1 = { status: 'rejected', value: [] };
    let pass2 = { status: 'rejected', value: [] };
    try {
        [pass1, pass2] = await Promise.allSettled([
            ytSearch(`${title}${yearStr} 4K trailer`, 5),
            ytSearch(`${title}${yearStr} ${suffix}`,  5),
        ]);
    } catch {
        // yt-dlp search failed entirely — will rely on TMDB IDs
    }

    const candidates = [
        ...(pass1.status === 'fulfilled' ? pass1.value.map(e => ({ ...e, source: '4k_search' })) : []),
        ...(pass2.status === 'fulfilled' ? pass2.value.map(e => ({ ...e, source: 'official_search' })) : []),
    ];

    // Pass 3: TMDB-sourced IDs — reliable fallback when yt-dlp search is blocked
    for (const id of tmdbIds) {
        if (!candidates.find(c => c.id === id)) {
            candidates.push({ id, title: `${title} trailer`, duration: 120, view_count: 0, source: 'tmdb' });
        }
    }

    // If yt-dlp search was blocked AND no TMDB IDs, we genuinely can't resolve
    if (candidates.length === 0) {
        throw new Error(`No trailer candidates found for "${title}" (yt-dlp blocked, no TMDB IDs provided)`);
    }

    // Deduplicate by video ID and pick the best score
    const seen   = new Set();
    const scored = [];
    for (const c of candidates) {
        if (!c.id || seen.has(c.id)) continue;
        seen.add(c.id);
        scored.push({ ...c, score: scoreResult(c, title) });
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    const result = {
        videoId: best.id,
        title:   best.title,
        score:   best.score,
        source:  best.source,
        year,
        ytdlpBlocked: candidates.every(c => c.source === 'tmdb'),
    };

    cacheSet(cacheKey, result);
    return result;
}


export function getTrailerCacheStats() {
    return { size: _cache.size, ttl_h: CACHE_TTL / 3_600_000 };
}
