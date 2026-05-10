/**
 * P-Stream Giga Engine Resolver v21.0.0
 *
 * PROVIDERS (extractor fallback pipeline — fires only if AllDebrid fails):
 *   Vyla      — aggregator, 14+ sources.   ~2-3s
 *   VaPlayer  — fast clean JSON API.        ~2.4s
 *   CineSu    — direct 1080p HLS.           ~1-2s
 *   VixSrc    — clean, no auth.             ~3-4s
 *   VidSrc.ru — 3-hop HTML chain.           ~7.7s
 *   LookMovie — title-search based.         ~7.4s
 *
 * REMOVED: VidZee (HF-blocked CDN), SmashyStream, MoviesAPI,
 *          PrimeSrc, VidSrc.me (duplicate), ApiBay (→ torrent.js).
 *
 * POLICY: No embeds. Raw M3U8 or direct MP4/MKV only.
 * All providers race in parallel with a 15s hard timeout.
 * After first success, a short grace window collects additional winners.
 */

import { scrapeVyla }                      from './extractors/vyla.js';
import { extractVaPlayer }                 from './extractors/vaplayer.js';
import { scrapeCineSu }                    from './extractors/cinesu.js';
import { scrapeVixSrc }                    from './extractors/vixsrc.js';
import { scrapeVidSrc as scrapeVidSrcRu }  from './extractors/vidsrcru.js';
import { scrapeLookMovie }                 from './extractors/lookmovie.js';
import { filterByHealth }                  from './services/providerHealth.js';

// ── Quality ranking ─────────────────────────────────────────────────────────
const QUALITY_RANK = {
    '4k': 0, '2160p': 0,
    '1440p': 1,
    '1080p': 2,
    '720p':  3,
    '480p':  4,
    '360p':  5,
    '240p':  6,
    'hd':    7,
    'auto':  8,
    'unknown': 9,
};

function qualityScore(q = '') {
    return QUALITY_RANK[q.toLowerCase()] ?? 9;
}

// ── Type ranking (HLS adaptive = best for streaming) ────────────────────────
const TYPE_RANK = { hls: 0, mp4: 1, mkv: 2 };

function typeScore(src) {
    if (src.isM3U8) return 0;
    const ext = (src.url || '').split('?')[0].split('.').pop().toLowerCase();
    return TYPE_RANK[ext] ?? 3;
}

// ── CDN hostname deduplication ───────────────────────────────────────────────
const MAX_PER_CDN_HOST = 3;

function getCdnHost(url = '') {
    try { return new URL(url).hostname; } catch (_) { return url; }
}

// ── Bad CDN blacklist ────────────────────────────────────────────────────────
const BAD_CDN_HOSTS = [
    'automatedrevenuehub.site',
    'tmstrd.justhd.tv',
];

function isBadCdn(url = '') {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return BAD_CDN_HOSTS.some(b => host.includes(b));
    } catch (_) { return false; }
}

// ── Merge and rank sources from multiple providers ───────────────────────────
function mergeAndRankSources(results) {
    const urlSeen    = new Set();
    const hostCount  = new Map();
    const allSources = [];

    for (const result of results) {
        for (const src of (result.sources || [])) {
            if (src.isEmbed || !src.url)     continue;
            if (isBadCdn(src.url))           continue;
            if (urlSeen.has(src.url))        continue;

            const host  = getCdnHost(src.url);
            const count = hostCount.get(host) || 0;
            if (count >= MAX_PER_CDN_HOST)   continue;

            urlSeen.add(src.url);
            hostCount.set(host, count + 1);
            allSources.push({
                ...src,
                provider:   src.provider   || result.provider   || result._providerName || 'unknown',
                providerId: src.providerId || result._providerId || 'unknown',
                _providerElapsedMs: result._elapsedMs || 9999,
            });
        }
    }

    // Sort: quality → type → provider speed
    allSources.sort((a, b) => {
        const qd = qualityScore(a.quality) - qualityScore(b.quality);
        if (qd !== 0) return qd;
        const td = typeScore(a) - typeScore(b);
        if (td !== 0) return td;
        return (a._providerElapsedMs || 9999) - (b._providerElapsedMs || 9999);
    });

    return allSources;
}

// ── Subtitle merger ──────────────────────────────────────────────────────────
function mergeSubtitleArrays(results) {
    const seen = new Set();
    const subs = [];
    for (const result of results) {
        for (const sub of (result.subtitles || [])) {
            const key = `${sub.url}|${sub.lang || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            subs.push(sub);
        }
    }
    return subs;
}

// ── Single extractor runner with timing + diagnostics ───────────────────────
async function runExtractorDiag(provider, timeoutMs = 15000) {
    const start = Date.now();

    try {
        const raw = await Promise.race([
            provider.run(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`TIMEOUT`)), timeoutMs)
            )
        ]);

        const elapsed = Date.now() - start;

        if (!raw?.success || !raw.sources?.length) {
            return { success: false, _providerName: provider.name, _providerId: provider.id,
                     _elapsedMs: elapsed, _status: 'no_sources', _failReason: raw?.error || 'empty' };
        }
        if (raw.sources.every(s => s.isEmbed)) {
            return { success: false, _providerName: provider.name, _providerId: provider.id,
                     _elapsedMs: elapsed, _status: 'embed_only', _failReason: 'no-embed policy' };
        }

        return { ...raw, _elapsedMs: elapsed, _providerName: provider.name, _providerId: provider.id, _status: 'success' };

    } catch (err) {
        const elapsed = Date.now() - start;
        const isTimeout = err.message === 'TIMEOUT';
        console.warn(`[Race] ✗ ${provider.name} (${isTimeout ? 'timeout' : 'error'}): ${err.message}`);
        return { success: false, _providerName: provider.name, _providerId: provider.id,
                 _elapsedMs: elapsed, _status: isTimeout ? 'timeout' : 'error',
                 _failReason: err.message };
    }
}

// ── Race all providers, collect successes ────────────────────────────────────
const SOURCE_THRESHOLD_FOR_EARLY_EXIT = 4;
const GRACE_SHORT_MS = 300;
const GRACE_LONG_MS  = 1400;

function collectExtractorResults(extractors, timeoutMs) {
    return new Promise(resolve => {
        let settled   = 0;
        const total   = extractors.length;
        let resolved  = false;
        let graceTimer = null;
        const successes = [];

        if (total === 0) { resolve([]); return; }

        const finalize = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(masterTimer);
            if (graceTimer) clearTimeout(graceTimer);

            const totalSrc = successes.reduce((n, r) => n + (r.sources?.filter(s => !s.isEmbed).length || 0), 0);
            if (successes.length) {
                console.log(`[Race] ✅ ${successes.length}/${total} providers → ${totalSrc} raw sources`);
            } else {
                console.warn(`[Race] ❌ All ${total} providers failed`);
            }
            resolve(successes);
        };

        const masterTimer = setTimeout(() => {
            console.warn(`[Race] ⏱ Master timeout (${timeoutMs}ms)`);
            finalize();
        }, timeoutMs);

        extractors.forEach(provider => {
            runExtractorDiag(provider, Math.floor(timeoutMs * 0.9)).then(result => {
                if (resolved) return;
                settled++;

                if (result._status === 'success') {
                    const srcCount = result.sources?.filter(s => !s.isEmbed).length || 0;
                    successes.push(result);
                    console.log(`[Race] ✅ ${result._providerName} in ${result._elapsedMs}ms → ${srcCount} source(s)`);

                    if (!graceTimer) {
                        const graceMs = srcCount >= SOURCE_THRESHOLD_FOR_EARLY_EXIT ? GRACE_SHORT_MS : GRACE_LONG_MS;
                        graceTimer = setTimeout(finalize, graceMs);
                    }
                }

                if (settled === total) finalize();
            });
        });
    });
}


// ── Main resolver ────────────────────────────────────────────────────────────

export async function resolveStreaming(tmdbId, type, season, episode, title, year) {
    console.log(`[Resolver] ${title || tmdbId} (${type}${type === 'tv' ? ` S${season}E${episode}` : ''})`);

    const allProviders = [
        { id: 'vyla',      name: 'Vyla',      run: () => scrapeVyla(tmdbId, type, season, episode) },
        { id: 'vaplayer',  name: 'VaPlayer',  run: () => extractVaPlayer({ tmdbId, type, season, episode }) },
        { id: 'cinesu',    name: 'CineSu',    run: () => scrapeCineSu(tmdbId, type, season, episode) },
        { id: 'vixsrc',    name: 'VixSrc',    run: () => scrapeVixSrc(tmdbId, type, season, episode) },
        { id: 'vidsrc_ru', name: 'VidSrc.ru', run: () => scrapeVidSrcRu(tmdbId, type, season, episode) },
        { id: 'lookmovie', name: 'LookMovie', run: () => title
            ? scrapeLookMovie(tmdbId, type === 'movie' ? 'movie' : 'show', season, episode, title, year)
            : Promise.resolve({ success: false, _skipReason: 'no title' }) },
    ];

    const healthy = await filterByHealth(allProviders);
    const active  = healthy.length ? healthy : allProviders;

    console.log(`[Resolver] 🏁 Racing: ${active.map(p => p.name).join(', ')}`);
    const results = await collectExtractorResults(active, 15000);

    if (results.length) {
        const sources   = mergeAndRankSources(results);
        const subtitles = mergeSubtitleArrays(results);

        if (sources.length) {
            const winner = [...results].sort((a, b) => (a._elapsedMs || 0) - (b._elapsedMs || 0))[0];
            console.log(`[Resolver] ✅ ${sources.length} sources from ${results.length} provider(s). Best: ${sources[0]?.quality} via ${sources[0]?.provider}`);
            return {
                success:    true,
                provider:   winner.provider   || winner._providerName,
                providerId: winner._providerId || 'unknown',
                sources,
                subtitles,
            };
        }
    }

    console.warn(`[Resolver] ❌ All providers failed for: ${title || tmdbId}`);
    return {
        success: false,
        error: 'No stream found. All providers are currently unavailable.',
    };
}


// ── Diagnostic endpoint ──────────────────────────────────────────────────────

export async function diagnoseProviders(tmdbId, type, season = '1', episode = '1', title = '', year = '') {
    const providers = [
        { id: 'vyla',      name: 'Vyla',      run: () => scrapeVyla(tmdbId, type, season, episode) },
        { id: 'vaplayer',  name: 'VaPlayer',  run: () => extractVaPlayer({ tmdbId, type, season, episode }) },
        { id: 'cinesu',    name: 'CineSu',    run: () => scrapeCineSu(tmdbId, type, season, episode) },
        { id: 'vixsrc',    name: 'VixSrc',    run: () => scrapeVixSrc(tmdbId, type, season, episode) },
        { id: 'vidsrc_ru', name: 'VidSrc.ru', run: () => scrapeVidSrcRu(tmdbId, type, season, episode) },
        { id: 'lookmovie', name: 'LookMovie', run: () => scrapeLookMovie(tmdbId, type === 'movie' ? 'movie' : 'show', season, episode, title, year) },
    ];

    const startAll = Date.now();
    console.log(`[Diagnose] ${title || tmdbId} (${type})...`);

    const results = await Promise.all(providers.map(p => runExtractorDiag(p, 25000)));

    return {
        tmdbId, type, season, episode,
        title: title || null,
        elapsedMs: Date.now() - startAll,
        providers: results.map(r => ({
            id:        r._providerId,
            name:      r._providerName,
            status:    r._status,
            elapsedMs: r._elapsedMs,
            failReason: r._failReason || null,
            rawSources: r.sources?.filter(s => !s.isEmbed).length || 0,
        })),
    };
}
