import axios from 'axios';
import https from 'https';
import { HttpsCookieAgent, createCookieAgent } from 'http-cookie-agent/http';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getRandomUA } from './constants.js';

// Browser-like TLS cipher suite (bypasses Cloudflare Bot Fight Mode TLS fingerprinting)
const chromeCiphers = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';

const globalCookieJar = new CookieJar();
const proxyUrl = process.env.RESIDENTIAL_PROXY_URL;

const ProxyCookieAgent = proxyUrl ? createCookieAgent(HttpsProxyAgent) : null;
let proxyAgent;

if (proxyUrl) {
    try {
        const pUrl = new URL(proxyUrl);
        const masked = `${pUrl.protocol}//${pUrl.username ? '****:****@' : ''}${pUrl.host}`;
        console.log(`[HTTP] Initializing Residential Proxy (Tier-1): ${masked}`);

        const proxyOptions = {
            host: pUrl.hostname,
            port: pUrl.port || (pUrl.protocol === 'https:' ? '443' : '80'),
            cookies: { jar: globalCookieJar },
            ciphers: chromeCiphers,
            minVersion: 'TLSv1.2',
            honorCipherOrder: true,
        };
        if (pUrl.username && pUrl.password) {
            proxyOptions.auth = `${decodeURIComponent(pUrl.username)}:${decodeURIComponent(pUrl.password)}`;
        }
        proxyAgent = new ProxyCookieAgent(proxyUrl, proxyOptions);
    } catch (e) {
        console.error('[HTTP] Failed to parse RESIDENTIAL_PROXY_URL:', e.message);
    }
}

export const browserHttpsAgent = new HttpsCookieAgent({
    cookies: { jar: globalCookieJar },
    ciphers: chromeCiphers,
    minVersion: 'TLSv1.2',
    honorCipherOrder: true,
});

// Shared browser-like headers for all axios instances
export const BROWSER_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
};

// THE GIGA AGENT: Direct HF IP, browser TLS fingerprint, browser headers.
// Used for providers whose CDNs don't block datacenter IPs.
export const gigaAxios = axios.create({
    withCredentials: true,
    proxy: false,
    httpsAgent: browserHttpsAgent,
    timeout: 10000,
    headers: {
        'User-Agent': getRandomUA(),
        ...BROWSER_HEADERS,
    },
});

// ─── ScraperAPI (Tier-2 Proxy) ────────────────────────────────────────────────
// Problem: IPRoyal (geo.iproyal.com) blocks HF datacenter IPs from using their
// residential network → returns 407 from HF but works fine from home IPs.
// Solution: ScraperAPI accepts connections from datacenter IPs and routes through
// their own residential proxy pool. Free tier: 1000 req/month @ scraperapi.com
//
// To enable: add SCRAPER_API_KEY to HF Space secrets
const SCRAPER_KEYS = (process.env.SCRAPER_API_KEY || '').split(',').map(k => k.trim()).filter(k => k);
let currentKeyIdx = 0;

function getNextScraperKey() {
    if (!SCRAPER_KEYS.length) return null;
    const key = SCRAPER_KEYS[currentKeyIdx];
    currentKeyIdx = (currentKeyIdx + 1) % SCRAPER_KEYS.length;
    return key;
}

// Convenience wrapper for one-shot ScraperAPI fetches from extractors
export async function scraperApiFetch(targetUrl, extraOptions = {}) {
    const key = getNextScraperKey();
    if (!key) throw new Error('[ScraperAPI] No keys available');
    const apiUrl = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(targetUrl)}&render=false`;
    const { data } = await gigaAxios.get(apiUrl, { timeout: 22000, ...extraOptions });
    return data;
}

// ─── proxyAxios: 3-Tier Fallback Chain ───────────────────────────────────────
// Tier 1 → IPRoyal residential proxy (best — genuine residential IPs, low block rate)
// Tier 2 → ScraperAPI residential pool (works from datacenter IPs, free tier available)
// Tier 3 → HF bare IP with browser TLS fingerprint (last resort — CDNs may 403)
export const proxyAxios = axios.create({
    withCredentials: true,
    httpsAgent: proxyAgent || browserHttpsAgent,
    timeout: 15000,
});

proxyAxios.interceptors.response.use(
    response => response,
    async error => {
        const config = error.config;
        if (!config || config._isRetry) return Promise.reject(error);

        const status = error.response?.status;
        const isProxyIssue = status === 407 || status === 429 || status === 503
            || error.code === 'ECONNREFUSED'
            || (error.message || '').includes('407');

        // Special handling for ScraperAPI exhaustion (403)
        const isScraperExhaustion = status === 403 && config.url?.includes('scraperapi.com');

        if (!isProxyIssue && !isScraperExhaustion) return Promise.reject(error);

        config._isRetry = true;

        // ── Tier 2: ScraperAPI (with Rotation) ───────────────────────────────
        if (SCRAPER_KEYS.length > 0) {
            console.warn(`[HTTP] Proxy/Scraper Issue (${status || error.code}). Trying next ScraperAPI key...`);
            
            // Try up to 3 times with different keys if we have them
            for (let i = 0; i < Math.min(SCRAPER_KEYS.length, 3); i++) {
                const key = getNextScraperKey();
                try {
                    const scraperUrl = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(config.url)}&render=false`;
                    return await gigaAxios.get(scraperUrl, {
                        responseType: config.responseType,
                        timeout: 22000,
                    });
                } catch (scraperErr) {
                    if (scraperErr.response?.status === 403) {
                        console.warn(`[HTTP] ScraperAPI Key Exhausted (403). Trying another...`);
                        continue;
                    }
                    console.warn(`[HTTP] ScraperAPI failed: ${scraperErr.message}. Falling to HF bare IP (tier-3)...`);
                    break;
                }
            }
        } else {
            console.warn(`[HTTP] Proxy Failure (${status || error.code}). No ScraperAPI keys → bare HF IP (tier-3).`);
        }

        // ── Tier 3: HF bare IP ───────────────────────────────────────────────
        config.httpsAgent = browserHttpsAgent;
        config.proxy = false;
        return axios(config);
    }
);

export const stringAtob = (input) => Buffer.from(input, 'base64').toString('binary');
export const stringBtoa = (input) => Buffer.from(input, 'binary').toString('base64');
