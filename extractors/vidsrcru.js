/**
 * VidSrc.ru (vsembed.ru) Extractor — v4.0 (2026-04-29)
 *
 * vsembed.ru changed page structure. The old 3-hop chain
 * (embed → iframe → relSrc → M3U8) no longer works.
 *
 * NEW STRATEGY: Try multiple VidSrc-family embed endpoints.
 * The VidSrc family serves its M3U8 via the cloudnestra.com CDN.
 * We look for it in the JS bundles rather than iframes.
 *
 * FALLBACK: If the primary URL fails, try alternate VidSrc domains
 * that are listed as live on vidsrc.domains.
 */
import { proxyAxios, gigaAxios } from '../utils/http.js';

// Try these domains in order — vidsrc.domains tracks which are live.
// More mirrors = higher chance of at least one working from HF datacenter IPs.
// Updated 2026-05-02: added cc/cx/co/rip/su/vip from megathread research.
const EMBED_BASES = [
    'https://vsembed.ru',
    'https://vidsrc-embed.ru',
    'https://vidsrc-embed.su',
    'https://vidsrc.cc',       // ← NEW: confirmed listed live
    'https://vidsrc.cx',       // ← NEW: confirmed listed live
    'https://vidsrc.co',       // ← NEW: confirmed listed live
    'https://vidsrc.rip',      // ← NEW: confirmed listed live
    'https://vidsrc.su',       // ← NEW: confirmed listed live
    'https://vidsrc.stream',
    'https://vidsrc.net',
    'https://vidsrc.pm',
    'https://vidsrc.nl',
    'https://vidsrc.xyz',
];

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchText(url) {
    try {
        if (url.startsWith('//')) url = 'https:' + url;
        const { data, status } = await proxyAxios.get(url, {
            headers: HEADERS,
            timeout: 10000,
        });
        return status === 200 ? String(data || '') : null;
    } catch {
        return null;
    }
}

// Extract any M3U8 URL from page source
function extractM3u8(html) {
    // Pattern 1: file: 'https://...' (JWPlayer / Playerjs)
    const p1 = html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)['"]/i);
    if (p1) return [p1[1]];

    // Pattern 2: source: [{file: '...'}, ...]
    const p2 = [...html.matchAll(/["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)['"]/gi)].map(m => m[1]);
    if (p2.length) return p2;

    // Pattern 3: "or" separated cloudnestra URLs
    const p3 = html.match(/file\s*:\s*["']([^"']+)["']/i);
    if (p3) {
        const rawUrls = p3[1].split(/\s+or\s+/i);
        const resolved = rawUrls.map(u => {
            // Replace vidzee-style domain placeholders
            return u
                .replace('{v4}', 'cloudnestra.com')
                .replace('{v1}', 'neonhorizonworkshops.com')
                .replace('{v2}', 'wanderlynest.com')
                .replace('{v3}', 'orchidpixelgardens.com');
        }).filter(u => u.startsWith('http') && !u.includes('{'));
        if (resolved.length) return resolved;
    }

    // Pattern 4: direct .m3u8 anywhere in source
    const p4 = [...html.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi)].map(m => m[0]);
    return [...new Set(p4)];
}

// Follow one iframe level
function extractSrc(html) {
    // iframe src
    const iframe = html.match(/<iframe[^>]+\ssrc=["']([^"']+)["'][^>]*>/i);
    if (iframe) return iframe[1];
    // JS src: '...' pattern
    const jsSrc = html.match(/src\s*:\s*['"]([^'"]+)['"]/i);
    return jsSrc ? jsSrc[1] : null;
}

export async function scrapeVidSrc(tmdbId, type, season, episode) {
    for (const base of EMBED_BASES) {
        try {
            const pageUrl = type === 'movie'
                ? `${base}/embed/movie?tmdb=${tmdbId}`
                : `${base}/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;

            console.log(`[VidSrc.ru] Trying: ${pageUrl}`);
            const html1 = await fetchText(pageUrl);
            if (!html1) continue;

            // Check for M3U8 directly in the first page
            const direct = extractM3u8(html1);
            if (direct.length) {
                console.log(`[VidSrc.ru] ✅ Direct M3U8 found on ${base}`);
                return buildResult(direct);
            }

            // Follow one level of iframe / src
            const src = extractSrc(html1);
            if (!src) {
                console.log(`[VidSrc.ru] No iframe/src found on ${base}`);
                continue;
            }

            const src2 = src.startsWith('http') ? src : (src.startsWith('//') ? 'https:' + src : new URL(src, pageUrl).href);
            const html2 = await fetchText(src2);
            if (!html2) continue;

            const m3u8FromLevel2 = extractM3u8(html2);
            if (m3u8FromLevel2.length) {
                console.log(`[VidSrc.ru] ✅ M3U8 found at level 2 from ${base}`);
                return buildResult(m3u8FromLevel2);
            }

            // Follow one more level
            const src3raw = extractSrc(html2);
            if (src3raw) {
                const src3 = src3raw.startsWith('http') ? src3raw : (src3raw.startsWith('//') ? 'https:' + src3raw : new URL(src3raw, src2).href);
                const html3 = await fetchText(src3);
                if (html3) {
                    const m3u8FromLevel3 = extractM3u8(html3);
                    if (m3u8FromLevel3.length) {
                        console.log(`[VidSrc.ru] ✅ M3U8 found at level 3 from ${base}`);
                        return buildResult(m3u8FromLevel3);
                    }
                }
            }

            console.log(`[VidSrc.ru] No M3U8 found for ${base}`);
        } catch (e) {
            console.warn(`[VidSrc.ru] Error on ${base}: ${e.message}`);
        }
    }

    return null;
}

function buildResult(urls) {
    // cloudnestra.com CDN blocks datacenter IPs → noProxy: true
    // Other CDNs may vary, but default to noProxy: true for safety
    const sources = urls.map(url => ({
        url,
        quality: 'auto',
        isM3U8: true,
        referer: 'https://cloudnestra.com/',
    }));
    return {
        success: true,
        provider: 'VidSrc.ru 🌐',
        sources,
        subtitles: [],
    };
}
