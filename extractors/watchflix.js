import { proxyAxios, gigaAxios } from '../utils/http.js';

const BASE = 'https://watchflix.st';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${BASE}/`,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export async function scrapeWatchFlix(tmdbId, type, season = 1, episode = 1) {
    try {
        const path = type === 'movie' || type === 'film'
            ? `/movie/${tmdbId}`
            : `/tv/${tmdbId}/${season}/${episode}`;

        console.log(`[WatchFlix] Probing ${BASE}${path}...`);

        const { data } = await proxyAxios.get(`${BASE}${path}`, {
            headers: HEADERS,
            timeout: 7000,
        });

        const html = typeof data === 'string' ? data : JSON.stringify(data);
        const m3u8Matches = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];

        if (!m3u8Matches.length) {
            return null;
        }

        const sources = m3u8Matches.slice(0, 3).map((url, idx) => ({
            url,
            quality: idx === 0 ? '1080p' : 'auto',
            isM3U8: true,
            isEmbed: false,
            noProxy: true,
            provider: 'WatchFlix',
            providerId: 'watchflix',
            referer: BASE,
        }));

        return {
            success: true,
            provider: 'WatchFlix 🎬',
            providerId: 'watchflix',
            sources,
            subtitles: [],
        };
    } catch (err) {
        console.warn(`[WatchFlix] Error: ${err.message}`);
        return null;
    }
}
