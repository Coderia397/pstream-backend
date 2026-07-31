/**
 * Provider Health Service
 * 
 * Tracks provider reliability using Redis. Each provider has a score (0-100).
 * - Successful stream → score increases
 * - Stream error (403, timeout, fatal) → score drops
 * - Score < 50 → provider deprioritized in resolver
 * - Score < 20 → provider suspended for 30 minutes
 * 
 * Frontend calls POST /api/stream/report-error when HLS.js fires a fatal error.
 * The resolver reads health scores before building the race array.
 */

import { redisClient } from '../utils/redis.js';

const HEALTH_KEY_PREFIX = 'provider:health:';
const SUSPEND_KEY_PREFIX = 'provider:suspend:';
const ERROR_LOG_KEY_PREFIX = 'provider:errors:';

const INITIAL_SCORE = 100;
const SUCCESS_BOOST = 3;
const ERROR_PENALTY = 12;
const SUSPEND_THRESHOLD = 20;
const DEPRIORITIZE_THRESHOLD = 50;
const SUSPEND_TTL = 30 * 60; // 30 minutes
const HEALTH_TTL = 24 * 60 * 60; // 24 hours

const PROVIDER_ALIASES = [
    { id: 'vixsrc', test: /vixsrc/i },
    { id: 'lookmovie', test: /lookmovie/i },
    { id: 'watchflix', test: /watchflix/i },
    { id: 'bingr', test: /bingr/i },
    { id: 'fireflix', test: /fireflix/i },
    { id: 'oneshows', test: /1shows|oneshows/i },
    { id: 'cinemaos', test: /cinemaos/i },
    { id: 'aurorascreen', test: /aurorascreen/i },
    { id: 'miruro', test: /miruro/i },
    { id: 'bstsrs', test: /bstsrs/i },
    { id: 'dramacool', test: /dramacool/i },
    { id: 'moviebox', test: /moviebox/i },
    { id: 'nontongo', test: /nontongo/i },
];

export function canonicalProviderId(name) {
    const raw = String(name || '').trim().toLowerCase();
    if (!raw) return 'unknown';
    for (const alias of PROVIDER_ALIASES) {
        if (alias.test.test(raw)) return alias.id;
    }
    return raw.replace(/[^a-z0-9]/g, '_');
}

/**
 * Normalize provider name to a stable Redis key
 */
function providerKey(name) {
    return canonicalProviderId(name);
}

/**
 * Get provider health score (0-100). Returns 100 if unknown (benefit of the doubt).
 */
export async function getProviderHealth(providerName) {
    try {
        const key = HEALTH_KEY_PREFIX + providerKey(providerName);
        const score = await redisClient.get(key);
        return score !== null ? parseInt(score) : INITIAL_SCORE;
    } catch {
        return INITIAL_SCORE; // Redis unavailable → assume healthy
    }
}

/**
 * Check if a provider is currently suspended (too many failures).
 */
export async function isProviderSuspended(providerName) {
    try {
        const key = SUSPEND_KEY_PREFIX + providerKey(providerName);
        const suspended = await redisClient.get(key);
        return suspended === '1';
    } catch {
        return false;
    }
}

/**
 * Record a successful stream from a provider.
 */
export async function recordProviderSuccess(providerName) {
    try {
        const key = HEALTH_KEY_PREFIX + providerKey(providerName);
        const current = await getProviderHealth(providerName);
        const newScore = Math.min(INITIAL_SCORE, current + SUCCESS_BOOST);
        await redisClient.setex(key, HEALTH_TTL, newScore);
        console.log(`[Health] ${providerName}: ${current} → ${newScore} (+${SUCCESS_BOOST})`);
    } catch { /* Redis unavailable, ignore */ }
}

/**
 * Record a provider error (frontend HLS error or backend scrape failure).
 * Automatically suspends the provider if score drops below threshold.
 */
export async function recordProviderError(providerName, errorContext = {}) {
    try {
        const key = HEALTH_KEY_PREFIX + providerKey(providerName);
        const current = await getProviderHealth(providerName);
        const newScore = Math.max(0, current - ERROR_PENALTY);
        await redisClient.setex(key, HEALTH_TTL, newScore);

        // Log the error with context
        const logKey = ERROR_LOG_KEY_PREFIX + providerKey(providerName);
        const errEntry = JSON.stringify({
            ts: Date.now(),
            score: newScore,
            ...errorContext
        });
        await redisClient.lpush(logKey, errEntry);
        await redisClient.ltrim(logKey, 0, 49); // Keep last 50 errors
        await redisClient.expire(logKey, HEALTH_TTL);

        // Suspend if score too low
        if (newScore < SUSPEND_THRESHOLD) {
            const suspendKey = SUSPEND_KEY_PREFIX + providerKey(providerName);
            await redisClient.setex(suspendKey, SUSPEND_TTL, '1');
            console.warn(`[Health] ⚠️ ${providerName} SUSPENDED for 30min (score: ${newScore})`);
        } else {
            console.log(`[Health] ${providerName}: ${current} → ${newScore} (-${ERROR_PENALTY})`);
        }
    } catch { /* Redis unavailable, ignore */ }
}

/**
 * Get all provider health scores (for status endpoint).
 */
export async function getAllProviderHealth() {
    try {
        const providers = [
            'vaplayer', 'vidsrc_ru', 'vidzee', 'lookmovie', 'primesrc', 'vidsrcme'
        ];
        const result = {};
        for (const p of providers) {
            result[p] = {
                score: await getProviderHealth(p),
                suspended: await isProviderSuspended(p),
            };
        }
        return result;
    } catch {
        return {};
    }
}

/**
 * Filter and sort an array of providers by health.
 * Suspended providers are removed. Low-scoring ones move to the back.
 */
export async function filterByHealth(providers) {
    const results = [];
    for (const p of providers) {
        if (await isProviderSuspended(p.name)) {
            console.log(`[Health] Skipping suspended provider: ${p.name}`);
            continue;
        }
        const score = await getProviderHealth(p.name);
        results.push({ ...p, HealthScore: score });
    }
    // Sort: higher score = earlier in array
    return results.sort((a, b) => b.HealthScore - a.HealthScore);
}
