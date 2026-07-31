import { proxyAxios } from '../utils/http.js';

const BASE = 'https://cinemaos.live';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${BASE}/`,
};

export async function scrapeCinemaOS(tmdbId, type, season = 1, episode = 1) {
    try {
        const url = type === 'movie' || type === 'film'
            ? `${BASE}/movie/${tmdbId}`
            : `${BASE}/tv/${tmdbId}/${season}/${episode}`;

        console.log(`[CinemaOS] Probing ${url}...`);

        const { data } = await proxyAxios.get(url, {
            headers: HEADERS,
            timeout: 7000,
        });

        const text = typeof data === 'string' ? data : JSON.stringify(data);
        const m3u8Matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];

        if (!m3u8Matches.length) return null;

        return {
            success: true,
            provider: 'CinemaOS 🎥',
            providerId: 'cinemaos',
            sources: m3u8Matches.slice(0, 2).map((streamUrl) => ({
                url: streamUrl,
                quality: '1080p',
                isM3U8: true,
                noProxy: true,
                provider: 'CinemaOS',
                providerId: 'cinemaos',
            })),
            subtitles: [],
        };
    } catch (err) {
        console.warn(`[CinemaOS] Error: ${err.message}`);
        return null;
    }
}
