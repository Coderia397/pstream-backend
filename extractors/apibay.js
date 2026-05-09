/**
 * APiBay Extractor — The Pirate Bay's official public API
 *
 * Free, no auth, returns torrents by IMDb ID directly.
 * Seeder counts are real and updated frequently.
 * Used as a supplementary source alongside Torrentio.
 *
 * API: https://apibay.org/q.php?q={imdb_id}
 * Returns: JSON array of torrents with info_hash, seeders, name, category
 *
 * Categories relevant to video:
 *   207 = HD Movies, 200 = Movies, 208 = Movie clips
 *   205 = Movies (other), 201 = Movies (other)
 */

import axios from 'axios';

const APIBAY_BASE = 'https://apibay.org';
const VIDEO_CATEGORIES = new Set(['200', '201', '202', '205', '206', '207', '208', '500', '501', '502', '503', '504']);

const TRACKERS = [
    'udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
    'udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce',
    'udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce',
    'udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
].join('&tr=');

function buildMagnet(infoHash, name) {
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=${TRACKERS}`;
}

function detectQuality(name) {
    const n = name.toLowerCase();
    if (/4k|2160p|uhd/.test(n)) return '4k';
    if (/1080p|fhd|full.?hd/.test(n)) return '1080p';
    if (/720p|hd/.test(n)) return '720p';
    if (/480p|sd/.test(n)) return '480p';
    return 'unknown';
}

/**
 * Fetch magnet sources from APiBay for a given IMDb ID.
 * @param {string} imdbId  - e.g. "tt0468569"
 * @param {string} type    - "movie" | "series"
 * @param {number} season
 * @param {number} episode
 * @param {object} redisClient
 */
export async function getApiBaySources(imdbId, type, season, episode, redisClient = null) {
    const cacheKey = `apibay:${imdbId}:${type}:${season || ''}:${episode || ''}`;

    if (redisClient) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(`[APiBay] Cache HIT: ${cacheKey}`);
                return JSON.parse(cached);
            }
        } catch (_) {}
    }

    const url = `${APIBAY_BASE}/q.php?q=${imdbId}`;
    console.log(`[APiBay] Fetching: ${url}`);

    const resp = await axios.get(url, {
        timeout: 8000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });

    const results = resp.data;

    // APiBay returns [{ id: "0", name: "No results returned", info_hash: "..." }] when empty
    if (!Array.isArray(results) || results[0]?.name === 'No results returned') {
        console.warn('[APiBay] No results');
        return [];
    }

    let filtered = results.filter(t =>
        VIDEO_CATEGORIES.has(t.category) &&
        parseInt(t.seeders) > 0
    );

    // For TV, also filter by season/episode in title if provided
    if (type !== 'movie' && season && episode) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        const tvPattern = new RegExp(`[Ss]0*${season}[Ee]0*${episode}|S${s}E${e}|${season}x${e}`, 'i');
        const tvFiltered = filtered.filter(t => tvPattern.test(t.name));
        // Only apply filter if we actually found episode-specific results
        if (tvFiltered.length > 0) filtered = tvFiltered;
    }

    const parsed = filtered
        .map(t => ({
            name:     t.name,
            infoHash: t.info_hash.toLowerCase(),
            magnet:   buildMagnet(t.info_hash, t.name),
            seeders:  parseInt(t.seeders) || 0,
            quality:  detectQuality(t.name),
            fileIdx:  null,
            source:   'apibay',
        }))
        .sort((a, b) => {
            const qRank = { '4k': 0, '1080p': 1, '720p': 2, '480p': 3, 'unknown': 4 };
            const qa = qRank[a.quality] ?? 5;
            const qb = qRank[b.quality] ?? 5;
            if (qa !== qb) return qa - qb;
            return b.seeders - a.seeders;
        })
        .slice(0, 30); // Cap at 30 — we only need the best

    console.log(`[APiBay] Got ${parsed.length} sources. Best: ${parsed[0]?.quality} @ ${parsed[0]?.seeders} seeders (${parsed[0]?.name?.substring(0, 60)})`);

    if (redisClient && parsed.length) {
        try {
            await redisClient.set(cacheKey, JSON.stringify(parsed), 'EX', 43200); // 12h cache
        } catch (_) {}
    }

    return parsed;
}
