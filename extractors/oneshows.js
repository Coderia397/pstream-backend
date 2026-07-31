import { proxyAxios } from '../utils/http.js';

const BASE = 'https://www.1shows.org';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${BASE}/`,
};

export async function scrape1Shows(tmdbId, type, season = 1, episode = 1) {
    try {
        const url = type === 'movie' || type === 'film'
            ? `${BASE}/movie/${tmdbId}`
            : `${BASE}/tv/${tmdbId}/${season}/${episode}`;

        console.log(`[1Shows] Probing ${url}...`);

        const { data } = await proxyAxios.get(url, {
            headers: HEADERS,
            timeout: 7000,
        });

        const text = typeof data === 'string' ? data : JSON.stringify(data);
        const m3u8Matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];

        if (!m3u8Matches.length) return null;

        return {
            success: true,
            provider: '1Shows 📺',
            providerId: 'oneshows',
            sources: m3u8Matches.slice(0, 3).map((streamUrl, idx) => ({
                url: streamUrl,
                quality: idx === 0 ? '1080p' : '720p',
                isM3U8: true,
                noProxy: true,
                provider: '1Shows',
                providerId: 'oneshows',
            })),
            subtitles: [],
        };
    } catch (err) {
        console.warn(`[1Shows] Error: ${err.message}`);
        return null;
    }
}
