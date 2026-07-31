import { gigaAxios } from '../utils/http.js';

const BASE = 'https://fireflix.pages.dev';

export async function scrapeFireFlix(tmdbId, type, season = 1, episode = 1) {
    try {
        const apiUrl = type === 'movie' || type === 'film'
            ? `${BASE}/api/movie?id=${tmdbId}`
            : `${BASE}/api/tv?id=${tmdbId}&season=${season}&episode=${episode}`;

        console.log(`[FireFlix] Probing ${apiUrl}...`);

        const { data } = await gigaAxios.get(apiUrl, {
            timeout: 6000,
            headers: { Accept: 'application/json, text/plain, */*' },
        });

        if (!data) return null;

        const htmlOrJson = typeof data === 'string' ? data : JSON.stringify(data);
        const m3u8Matches = htmlOrJson.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];

        if (!m3u8Matches.length) return null;

        return {
            success: true,
            provider: 'FireFlix 🔥',
            providerId: 'fireflix',
            sources: m3u8Matches.slice(0, 2).map((url) => ({
                url,
                quality: '1080p',
                isM3U8: true,
                noProxy: true,
                provider: 'FireFlix',
                providerId: 'fireflix',
            })),
            subtitles: [],
        };
    } catch (err) {
        console.warn(`[FireFlix] Error: ${err.message}`);
        return null;
    }
}
