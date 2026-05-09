/**
 * SmashyStream Extractor — v1.0 (2026-05-09)
 *
 * Clean public JSON API — no scraping, no auth.
 * Returns direct M3U8 streams indexed by TMDB ID.
 *
 * Movie:  GET /player?id={tmdbId}
 * TV:     GET /player/tv?id={tmdbId}&s={season}&e={episode}
 *
 * Response: { stream: [ { url, quality, headers }, ... ] }
 *
 * Source: piracy megathread (smashystream.com)
 */

import { gigaAxios } from '../utils/http.js';

const BASES = [
    'https://player.smashystream.com',
    'https://smashystream.xyz',
];

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://smashystream.com/',
    'Origin': 'https://smashystream.com',
};

async function tryFetch(url) {
    const resp = await gigaAxios.get(url, { headers: HEADERS, timeout: 10000 });
    return resp.data;
}

export async function scrapeSmashyStream(tmdbId, type, season, episode) {
    for (const base of BASES) {
        try {
            let url;
            if (type === 'movie') {
                url = `${base}/player?id=${tmdbId}`;
            } else {
                const s = parseInt(season) || 1;
                const e = parseInt(episode) || 1;
                url = `${base}/player/tv?id=${tmdbId}&s=${s}&e=${e}`;
            }

            console.log(`[SmashyStream] Fetching: ${url}`);
            const data = await tryFetch(url);

            const streams = data?.stream || data?.streams || data?.sources || [];
            if (!streams.length) {
                console.warn('[SmashyStream] Empty streams array');
                continue;
            }

            const sources = streams
                .filter(s => s.url && (s.url.includes('.m3u8') || s.url.includes('.mp4')))
                .map(s => ({
                    url: s.url,
                    quality: s.quality || s.label || 'auto',
                    isM3U8: s.url.includes('.m3u8'),
                    provider: 'SmashyStream 💥',
                    providerId: 'smashystream',
                    referer: 'https://smashystream.com/',
                }));

            if (!sources.length) {
                console.warn('[SmashyStream] No valid stream URLs in response');
                continue;
            }

            console.log(`[SmashyStream] ✅ Got ${sources.length} source(s)`);
            return {
                success: true,
                provider: 'SmashyStream 💥',
                providerId: 'smashystream',
                sources,
                subtitles: [],
            };

        } catch (err) {
            console.warn(`[SmashyStream] ${base} failed: ${err.message}`);
        }
    }

    return null;
}
