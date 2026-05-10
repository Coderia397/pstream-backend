/**
 * VaPlayer / JustHD Extractor
 * 
 * Uses streamdata.vaplayer.ru/api.php — the clean JSON API powering
 * vidsrc.pm and brightpathsignals.com. Returns multiple HLS mirrors.
 * 
 * API: GET https://streamdata.vaplayer.ru/api.php?tmdb={id}&type=movie|tv[&season=N&episode=N]
 * Returns: { status_code: "200", data: { stream_urls: [...m3u8...] } }
 * 
 * CDN domains seen: onlinevisibilitysystem.site, quietmidnightgardeningideas.site, tmstrd.justhd.tv
 * These CDNs are NOT IP-locked — standard proxy works.
 */

import { proxyAxios } from '../utils/http.js';
import { USER_AGENTS } from '../utils/constants.js';

const BASE = 'https://streamdata.vaplayer.ru/api.php';
const REFERER = 'https://brightpathsignals.com/';

export async function extractVaPlayer({ tmdbId, type, season, episode } = {}) {
    const s = parseInt(season) || 1;
    const e = parseInt(episode) || 1;

    let url = `${BASE}?tmdb=${tmdbId}&type=${type === 'tv' ? 'tv' : 'movie'}`;
    if (type === 'tv') url += `&season=${s}&episode=${e}`;

    console.log(`[VaPlayer] Fetching: ${url}`);

    const { data } = await proxyAxios.get(url, {
        headers: {
            'User-Agent': USER_AGENTS[0],
            'Referer': REFERER,
            'Accept': 'application/json',
        },
        timeout: 12000,
    });

    if (!data || String(data.status_code) !== '200' || !data.data?.stream_urls?.length) {
        throw new Error(`VaPlayer: No streams (status ${data?.status_code})`);
    }

    const { stream_urls, default_subs = [] } = data.data;

    // Map each mirror URL to a source.
    // Keep VaPlayer on backend proxy path so browser never hits CDN directly.
    // Direct browser mode causes CORS failures on multiple VaPlayer CDN hosts.
    const sources = stream_urls.map((url, i) => ({
        url,
        quality: i === stream_urls.length - 1 ? 'auto' : '1080p',
        isM3U8: true,
        referer: REFERER,
        provider: `VaPlayer Mirror ${i + 1}`,
        providerId: 'vaplayer',
    }));

    // Sort so JustHD (tmstrd.justhd.tv) comes first — it has proper CORS headers.
    // The rotating disposable CDN domains (personalbrandgrowth.site, wealthcreationmethod.site etc.)
    // have no CORS headers so direct browser fetches fail with status 0. JustHD is the safe primary.
    sources.sort((a, b) => {
        const aIsJustHD = a.url.includes('justhd.tv');
        const bIsJustHD = b.url.includes('justhd.tv');
        if (aIsJustHD && !bIsJustHD) return -1;
        if (bIsJustHD && !aIsJustHD) return 1;
        return 0;
    });

    // Map subtitles if present
    const subtitles = (default_subs || []).map(sub => ({
        url: sub.file || sub.url,
        lang: sub.label?.toLowerCase().startsWith('en') ? 'en' : (sub.label || 'en'),
        label: sub.label || 'English',
    })).filter(s => s.url);

    console.log(`[VaPlayer] ✅ Found ${sources.length} mirrors, ${subtitles.length} subs`);

    return {
        success: true,
        provider: 'VaPlayer 🎯',
        providerId: 'vaplayer',
        sources,
        subtitles,
    };
}
