import { proxyAxios } from '../utils/http.js';

const BASE = 'https://bstsrs.in';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${BASE}/`,
};

export async function scrapeBSTSrs(tmdbId, type, season = 1, episode = 1) {
    if (type !== 'tv' && type !== 'show') return null; // BSTSrs is TV specific

    try {
        const url = `${BASE}/show/${tmdbId}/season/${season}/episode/${episode}`;
        console.log(`[BSTSrs] Probing ${url}...`);

        const { data } = await proxyAxios.get(url, {
            headers: HEADERS,
            timeout: 7000,
        });

        const text = typeof data === 'string' ? data : JSON.stringify(data);
        const m3u8Matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];

        if (!m3u8Matches.length) return null;

        return {
            success: true,
            provider: 'BSTSrs Series 📺',
            providerId: 'bstsrs',
            sources: m3u8Matches.slice(0, 2).map((streamUrl) => ({
                url: streamUrl,
                quality: '720p',
                isM3U8: true,
                noProxy: true,
                provider: 'BSTSrs',
                providerId: 'bstsrs',
            })),
            subtitles: [],
        };
    } catch (err) {
        console.warn(`[BSTSrs] Error: ${err.message}`);
        return null;
    }
}
