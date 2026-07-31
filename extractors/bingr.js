import { gigaAxios, proxyAxios } from '../utils/http.js';

const BASE = 'https://bingr.one';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${BASE}/`,
};

export async function scrapeBingr(tmdbId, type, season = 1, episode = 1) {
    try {
        const url = type === 'movie' || type === 'film'
            ? `${BASE}/watch/movie/${tmdbId}`
            : `${BASE}/watch/tv/${tmdbId}/${season}/${episode}`;

        console.log(`[Bingr] Probing ${url}...`);

        const { data } = await proxyAxios.get(url, {
            headers: HEADERS,
            timeout: 7000,
        });

        const html = typeof data === 'string' ? data : JSON.stringify(data);
        const m3u8Matches = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];

        if (!m3u8Matches.length) {
            return null;
        }

        const sources = m3u8Matches.slice(0, 3).map((streamUrl, i) => ({
            url: streamUrl,
            quality: i === 0 ? '1080p' : '720p',
            isM3U8: true,
            noProxy: true,
            provider: 'Bingr',
            providerId: 'bingr',
            referer: BASE,
        }));

        return {
            success: true,
            provider: 'Bingr 🚀',
            providerId: 'bingr',
            sources,
            subtitles: [],
        };
    } catch (err) {
        console.warn(`[Bingr] Error: ${err.message}`);
        return null;
    }
}
