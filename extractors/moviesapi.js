/**
 * MoviesAPI.club Extractor — v1.0 (2026-05-09)
 *
 * Public JSON API returning direct M3U8 and MP4 streams.
 * Indexed by TMDB ID, no auth required.
 *
 * Movie:  GET /movie?id={tmdbId}
 * TV:     GET /tv?id={tmdbId}&s={season}&e={episode}
 *
 * Response: { videoSource: "...", backupSource: "...", ... }
 *
 * Source: piracy megathread (moviesapi.club)
 */

import { gigaAxios } from '../utils/http.js';

const BASES = [
    'https://moviesapi.club',
    'https://moviesapi.cc',
];

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept': 'application/json, */*',
    'Referer': 'https://moviesapi.club/',
};

function normalizeQuality(q = '') {
    const s = q.toLowerCase();
    if (/4k|2160/.test(s)) return '4k';
    if (/1080/.test(s))    return '1080p';
    if (/720/.test(s))     return '720p';
    if (/480/.test(s))     return '480p';
    return 'auto';
}

export async function scrapeMoviesApi(tmdbId, type, season, episode) {
    for (const base of BASES) {
        try {
            let url;
            if (type === 'movie') {
                url = `${base}/movie?id=${tmdbId}`;
            } else {
                const s = parseInt(season) || 1;
                const e = parseInt(episode) || 1;
                url = `${base}/tv?id=${tmdbId}&s=${s}&e=${e}`;
            }

            console.log(`[MoviesAPI] Fetching: ${url}`);
            const { data } = await gigaAxios.get(url, { headers: HEADERS, timeout: 10000 });

            if (!data) {
                console.warn('[MoviesAPI] Empty response');
                continue;
            }

            const sources = [];

            // Handle both array-style and object-style responses
            const streamList = Array.isArray(data) ? data : [data];

            for (const item of streamList) {
                // Primary source
                if (item.videoSource) {
                    sources.push({
                        url: item.videoSource,
                        quality: normalizeQuality(item.quality || item.label || ''),
                        isM3U8: item.videoSource.includes('.m3u8'),
                        provider: 'MoviesAPI 🎬',
                        providerId: 'moviesapi',
                        referer: `${base}/`,
                    });
                }
                // Backup source
                if (item.backupSource && item.backupSource !== item.videoSource) {
                    sources.push({
                        url: item.backupSource,
                        quality: normalizeQuality(item.quality || ''),
                        isM3U8: item.backupSource.includes('.m3u8'),
                        provider: 'MoviesAPI 🎬 (backup)',
                        providerId: 'moviesapi',
                        referer: `${base}/`,
                    });
                }
                // Some variants use `sources` array
                for (const src of (item.sources || [])) {
                    const srcUrl = src.file || src.url || src.src;
                    if (!srcUrl) continue;
                    sources.push({
                        url: srcUrl,
                        quality: normalizeQuality(src.label || src.quality || ''),
                        isM3U8: srcUrl.includes('.m3u8'),
                        provider: 'MoviesAPI 🎬',
                        providerId: 'moviesapi',
                        referer: `${base}/`,
                    });
                }
            }

            const validSources = sources.filter(s => s.url && (s.url.startsWith('http')));
            if (!validSources.length) {
                console.warn('[MoviesAPI] No valid URLs in response');
                continue;
            }

            // Subtitles
            const subtitles = [];
            const subList = Array.isArray(data) ? [] : (data.subtitles || data.tracks || []);
            for (const sub of subList) {
                const subUrl = sub.file || sub.url;
                if (!subUrl) continue;
                subtitles.push({
                    url: subUrl,
                    lang: sub.label || sub.language || 'en',
                    label: sub.label || 'Unknown',
                });
            }

            console.log(`[MoviesAPI] ✅ ${validSources.length} source(s), ${subtitles.length} subtitle(s) from ${base}`);
            return {
                success: true,
                provider: 'MoviesAPI 🎬',
                providerId: 'moviesapi',
                sources: validSources,
                subtitles,
            };

        } catch (err) {
            console.warn(`[MoviesAPI] ${base} failed: ${err.message}`);
        }
    }

    return null;
}
