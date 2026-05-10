/**
 * VidZee Extractor — v3.0 (2026-04-24)
 *
 * Live-verified behaviour (probed from dev machine, 2026-04-24):
 *
 * KEY API:
 *   GET https://core.vidzee.wtf/api-key
 *   Returns AES-GCM encrypted key. Layout: IV[0:12] | authTag[12:28] | ciphertext[28:]
 *   Decrypted with SHA-256(GCM_SECRET). Currently decrypts to "pleasedontscrapemesaywallahi".
 *   ⚠️  Takes 8-12s via proxy chain. Timeout raised to 15s.
 *
 * SERVER API:
 *   GET /api/server?id={tmdbId}&sr={serverId}[&ss={season}&ep={episode}]
 *   Invalid sr → {"error":"Invalid server","availableServers":[{"server":0,"name":"...","sr":"X"},...]}
 *   Valid sr   → {"url":[{"lang":"English","link":"<base64_aes_cbc>"},...], "tracks":[...]}
 *   Empty sr   → {"error":"No stream found","server":"Togi","id":"..."}
 *
 * CONFIRMED WORKING sr VALUES (2026-04-24):
 *   Movie only:  sr=4, 6, 7
 *   TV only:     sr=0, 3
 *   Both:        sr=4, 6, 7
 *
 * STRATEGY:
 *   Step 1: Probe sr=99 (guaranteed invalid) to get `availableServers` list
 *   Step 2: Try each available sr in parallel
 *   Step 3: Decrypt URL with AES-256-CBC key ("base64_iv:base64_ciphertext" format)
 *
 * CDN (neonhorizonworkshops, wanderlynest, orchidpixelgardens, etc.):
 *   Blocks HF datacenter IPs. noProxy=true → HLS.js fetches directly from browser.
 */
import { gigaAxios } from '../utils/http.js';
import crypto from 'crypto';

const BASE_URL = 'https://player.vidzee.wtf';
const KEY_API  = 'https://core.vidzee.wtf/api-key';

// AES-GCM secret to decrypt the rotating key from /api-key endpoint.
// key = SHA-256(UTF8(GCM_SECRET)) — NOT raw hex, SHA-256 of the string itself
const GCM_SECRET = '4f2a9c7d1e8b3a6f0d5c2e9a7b1f4d8c';

// Last-known-good fallback (confirmed 2026-04-24 via probe)
const KNOWN_FALLBACK_KEY = 'pleasedontscrapemesaywallahi';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: BASE_URL + '/',
    Origin: BASE_URL,
};

// Cache derived key for 1 hour (it rotates at most daily)
let _cachedDecryptKey = null;
let _cacheExpiry = 0;

async function getDerivedKey() {
    const now = Date.now();
    if (_cachedDecryptKey && now < _cacheExpiry) return _cachedDecryptKey;

    try {
        // Fail fast to KNOWN_FALLBACK_KEY if the key API is slow. The fallback is valid
        // and there's no reason to block the race for 15s waiting for a key that rarely changes.
        const { data: encKeyB64 } = await gigaAxios.get(KEY_API, { headers: HEADERS, timeout: 6000 });
        const buf = Buffer.from(encKeyB64.trim(), 'base64');

        const iv         = buf.slice(0, 12);
        const authTag    = buf.slice(12, 28);
        const ciphertext = buf.slice(28);

        const gcmKey = crypto.createHash('sha256').update(Buffer.from(GCM_SECRET, 'utf8')).digest();
        const decipher = crypto.createDecipheriv('aes-256-gcm', gcmKey, iv);
        decipher.setAuthTag(authTag);
        let dec = decipher.update(ciphertext, undefined, 'utf8');
        dec += decipher.final('utf8');

        _cachedDecryptKey = dec.trim();
        _cacheExpiry = now + 60 * 60 * 1000; // 1 hour
        console.log(`[VidZee] ✅ Dynamic key fetched (${_cachedDecryptKey.length} chars)`);
        return _cachedDecryptKey;
    } catch (e) {
        console.warn(`[VidZee] Key fetch failed (${e.message}) — using fallback`);
        return KNOWN_FALLBACK_KEY;
    }
}

// Decrypt one AES-256-CBC link ("base64_iv:base64_ciphertext" format)
function decryptUrl(link, decryptKey) {
    try {
        const rawKey = decryptKey.padEnd(32, '\0').slice(0, 32);
        const keyBytes = Buffer.from(rawKey, 'utf8');
        const decoded = Buffer.from(link, 'base64').toString('utf8');
        const [ivBase64, cipherBase64] = decoded.split(':');
        if (!ivBase64 || !cipherBase64) return null;

        const iv = Buffer.from(ivBase64, 'base64');
        const ciphertext = Buffer.from(cipherBase64, 'base64');

        const decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, iv);
        let decrypted = decipher.update(ciphertext, undefined, 'utf8');
        decrypted += decipher.final('utf8');

        const url = decrypted.replace(/[\x00-\x08\x0b-\x1f]/g, '').trim();
        return url.startsWith('http') ? url : null;
    } catch {
        return null;
    }
}

// Fetch available server IDs dynamically by sending a guaranteed-invalid sr
async function getAvailableServers(tmdbId, type, season, episode) {
    try {
        let url = `${BASE_URL}/api/server?id=${tmdbId}&sr=99999`;
        if (type === 'tv' && season && episode) url += `&ss=${season}&ep=${episode}`;

        const { data } = await gigaAxios.get(url, { headers: HEADERS, timeout: 10000 });
        if (data?.availableServers?.length) {
            return data.availableServers.map(s => s.sr).filter(Boolean);
        }
    } catch {}
    // Hardcoded fallback based on live probe (2026-04-24)
    return type === 'tv' ? ['0','3','4','6','7'] : ['4','6','7'];
}

// Fetch one server's stream data
async function fetchServer(tmdbId, srId, type, season, episode) {
    try {
        let url = `${BASE_URL}/api/server?id=${tmdbId}&sr=${srId}`;
        if (type === 'tv' && season && episode) url += `&ss=${season}&ep=${episode}`;
        const { data } = await gigaAxios.get(url, { headers: HEADERS, timeout: 10000 });
        // Only return if we actually got URL data (not "No stream found")
        if (data?.url?.length) return data;
        return null;
    } catch {
        return null;
    }
}

export async function scrapeVidZee(tmdbId, type, season, episode) {
    try {
        // Run key fetch and server discovery in parallel to save time
        let [decryptKey, availableSrIds] = await Promise.all([
            getDerivedKey(),
            getAvailableServers(tmdbId, type, season, episode),
        ]);

        console.log(`[VidZee] Available servers: [${availableSrIds.join(',')}] | key="${decryptKey?.substring(0,8)}..."`);

        // Fetch all available servers in parallel
        const results = await Promise.allSettled(
            availableSrIds.map(srId => fetchServer(tmdbId, srId, type, season, episode))
        );

        const subtitleMap = new Map();
        let allUrls = [];
        let totalLinks = 0;

        for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value?.url) continue;
            const { url: streamUrls, tracks } = result.value;

            // Collect subtitles
            for (const track of (tracks || [])) {
                if (track.url && track.lang && !subtitleMap.has(track.lang)) {
                    subtitleMap.set(track.lang, {
                        url: track.url,
                        lang: track.lang,
                        label: track.label || track.lang,
                    });
                }
            }

            // Decrypt URLs from each server
            for (const su of (streamUrls || [])) {
                if (!su.link) continue;
                totalLinks++;
                const decrypted = decryptUrl(su.link, decryptKey);
                if (decrypted) allUrls.push(decrypted);
            }
        }

        console.log(`[VidZee] ${totalLinks} encrypted link(s) found, ${allUrls.length} decrypted`);

        // ── Key rotation detection ───────────────────────────────────────────
        // If we found server data but all decryptions failed, the cached key has rotated.
        // Force-bust the cache and retry with a fresh fetch from /api-key.
        if (totalLinks > 0 && allUrls.length === 0) {
            console.warn(`[VidZee] ⚠️  ALL ${totalLinks} decryptions failed — key likely rotated. Busting cache and retrying...`);
            _cachedDecryptKey = null;
            _cacheExpiry = 0;

            const freshKey = await getDerivedKey();
            if (freshKey !== decryptKey) {
                console.log(`[VidZee] 🔑 Fresh key fetched: "${freshKey?.substring(0,8)}..." — retrying decryption`);
                allUrls = [];
                for (const result of results) {
                    if (result.status !== 'fulfilled' || !result.value?.url) continue;
                    for (const su of (result.value.url || [])) {
                        if (!su.link) continue;
                        const decrypted = decryptUrl(su.link, freshKey);
                        if (decrypted) allUrls.push(decrypted);
                    }
                }
                console.log(`[VidZee] After key rotation retry: ${allUrls.length} stream(s) decrypted`);
            } else {
                console.warn('[VidZee] Fresh key identical to cached key — decryption format may have changed');
            }
        }

        const uniqueUrls = [...new Set(allUrls)];

        if (uniqueUrls.length === 0) {
            console.warn('[VidZee] ❌ No streams decrypted after all attempts — provider may be down or format changed');
            return null;
        }

        const sources = uniqueUrls.map(url => ({
            url,
            quality: 'auto',
            isM3U8: true,
            referer: BASE_URL + '/',
        }));

        return {
            success: true,
            provider: 'VidZee ⚡',
            sources,
            subtitles: Array.from(subtitleMap.values()),
        };
    } catch (e) {
        console.warn(`[VidZee] Error: ${e.message}`);
        return null;
    }
}
