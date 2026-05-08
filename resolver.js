/**
 * P-Stream Giga Engine Resolver v19.0.0
 * "CineSu + VidSrc Mirror Expansion + Source Depth"
 *
 * ══ PROVIDER STATUS (2026-05-02) ═══════════════════════════════════════════
 *
 * ✅ VaPlayer  (streamdata.vaplayer.ru) — fast clean JSON API.          ~2.4s
 * ✅ VidZee    (player.vidzee.wtf)      — AES decrypt, CDN noProxy.    ~8s
 * ✅ VidSrc.ru (vsembed.ru + 12 mirrors)— 3-hop HTML chain.             ~7.7s
 * ✅ LookMovie (lmscript.xyz)           — title-search based.           ~7.4s
 * ✅ Vyla      (vyla-api.pages.dev)     — aggregator: 02Embed, CineSu, ~2-3s
 *                                         VidNest (7 sources), subtitles.
 * ✅ CineSu    (cine.su)                — direct 1080p HLS, HEAD probe. ~1-2s
 *
 * ══ POLICY ════════════════════════════════════════════════════════════════
 *
 * NO EMBED FALLBACKS. Every source must be a raw M3U8 or direct MP4/MKV URL.
 * If all providers fail → return error. No iframes, no in-browser embeds.
 *
 * ══ ARCHITECTURE ══════════════════════════════════════════════════════════
 *
 * Stage 1 (25s timeout): All providers race in parallel.
 *   - VaPlayer + Vyla: fastest (~2-3s each). Vyla alone delivers 14+ sources.
 *   - VidZee / VidSrc.ru / LookMovie: slower backup sources.
 *   - After first success, 2s grace window collects additional winners.
 *   - All results merged, deduplicated by CDN hostname, quality-sorted.
 *
 * ══ SMART SOURCE RANKING ══════════════════════════════════════════════════
 *
 * Final source list sorted by:
 *   1. Quality (4K > 1080p > 720p > auto/unknown)
 *   2. Type (HLS > MP4 > MKV) — HLS enables adaptive bitrate
 *   3. Provider speed (faster provider = earlier in list)
 *
 * ══ CDN DEDUPLICATION ═════════════════════════════════════════════════════
 *
 * Sources sharing the same CDN hostname are capped at MAX_PER_CDN_HOST = 3.
 * Prevents 8 VidZee tokens from the same CDN flooding the source list.
 *
 * ══ DIAGNOSABILITY ════════════════════════════════════════════════════════
 *
 * Every extractor result carries:
 *   _elapsedMs     — timing
 *   _providerName  — canonical name
 *   _failReason    — human-readable failure reason (on failure)
 *   _status        — 'success' | 'no_sources' | 'error' | 'timeout'
 */

import { scrapeVidZee }       from './extractors/vidzee.js';
import { scrapeVidSrc as scrapeVidSrcRu } from './extractors/vidsrcru.js';
import { extractVaPlayer }    from './extractors/vaplayer.js';
import { scrapeLookMovie }    from './extractors/lookmovie.js';
import { scrapeVyla }         from './extractors/vyla.js';
import { scrapeCineSu }       from './extractors/cinesu.js';
import { scrapeVdrkCaptions } from './extractors/subs_vdrk.js';
import { scrapeVixSrc }       from './extractors/vixsrc.js';
import { filterByHealth }     from './services/providerHealth.js';

// ── Quality ranking ────────────────────────────────────────────────────────
const QUALITY_RANK = {
    '4k': 0, '2160p': 0,
    '1440p': 1,
    '1080p': 2,
    '720p': 3,
    '480p': 4,
    '360p': 5,
    '240p': 6,
    'hd': 7,
    'auto': 8,
    'unknown': 9,
};

function qualityScore(q = '') {
    return QUALITY_RANK[q.toLowerCase()] ?? 9;
}

// ── Type ranking (HLS adaptive = best for streaming) ──────────────────────
const TYPE_RANK = { hls: 0, mp4: 1, mkv: 2 };

function typeScore(src) {
    if (src.isM3U8) return 0; // HLS
    const ext = (src.url || '').split('?')[0].split('.').pop().toLowerCase();
    return TYPE_RANK[ext] ?? 3;
}

// ── CDN hostname deduplication ─────────────────────────────────────────────
const MAX_PER_CDN_HOST = 3;

function getCdnHost(url = '') {
    try { return new URL(url).hostname; } catch (_) { return url; }
}

function deduplicateSourcesByCdn(sources) {
    const hostCount = new Map();
    return sources.filter(src => {
        const host = getCdnHost(src.url);
        const count = hostCount.get(host) || 0;
        if (count >= MAX_PER_CDN_HOST) return false;
        hostCount.set(host, count + 1);
        return true;
    });
}

// ── Bad CDN Blacklist ──────────────────────────────────────────────────────
const BAD_CDN_HOSTS = [
    'automatedrevenuehub.site', // Known to serve HTML ad payloads instead of m3u8
    'tmstrd.justhd.tv'          // Frequently returns Cloudflare/HTML instead of video chunks
];

function isBadCdn(url = '') {
    try { 
        const host = new URL(url).hostname.toLowerCase();
        return BAD_CDN_HOSTS.some(bad => host.includes(bad));
    } catch (_) { 
        return false; 
    }
}

// ── Smart source merger & sorter ───────────────────────────────────────────
function mergeAndRankSources(results) {
    const urlSeen    = new Set();
    const allSources = [];

    // Collect all unique non-embed sources from all successful providers
    for (const result of results) {
        for (const src of (result.sources || [])) {
            if (src.isEmbed) continue;
            if (!src.url)    continue;
            if (isBadCdn(src.url)) {
                console.log(`[Resolver] Dropped blacklisted CDN source: ${src.url}`);
                continue;
            }
            if (urlSeen.has(src.url)) continue;
            urlSeen.add(src.url);
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
        const qa = qualityScore(a.quality);
        const qb = qualityScore(b.quality);
        if (qa !== qb) return qa - qb;

        const ta = typeScore(a);
        const tb = typeScore(b);
        if (ta !== tb) return ta - tb;

        return (a._providerElapsedMs || 9999) - (b._providerElapsedMs || 9999);
    });

    // Cap sources per CDN host to avoid flooding with tokens from same dead CDN
    return deduplicateSourcesByCdn(allSources);
}

// ── Subtitle merger ────────────────────────────────────────────────────────
function mergeSubtitleArrays(results) {
    const subSeen = new Set();
    const subs    = [];
    for (const result of results) {
        for (const sub of (result.subtitles || [])) {
            const key = `${sub.url}|${sub.lang || ''}`;
            if (subSeen.has(key)) continue;
            subSeen.add(key);
            subs.push(sub);
        }
    }
    return subs;
}


// ── Structured extractor runner ────────────────────────────────────────────

async function runExtractorDiag(provider, timeoutMs = 18000) {
    const start = Date.now();
    let status = 'error';
    let failReason = null;
    let result = null;

    try {
        const raw = await Promise.race([
            provider.run(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`TIMEOUT_${timeoutMs}ms`)), timeoutMs)
            )
        ]);

        const elapsed = Date.now() - start;

        if (!raw) {
            status = 'no_sources';
            failReason = 'Extractor returned null';
        } else if (!raw.success) {
            status = 'no_sources';
            failReason = raw.error || 'success=false';
        } else if (!raw.sources?.length) {
            status = 'no_sources';
            failReason = 'empty sources array';
        } else if (raw.sources.every(s => s.isEmbed)) {
            // Policy: reject embed-only results
            status = 'embed_only';
            failReason = 'All sources are embeds — rejected by no-embed policy';
        } else {
            status = 'success';
            result = { ...raw, _elapsedMs: elapsed, _providerName: provider.name, _providerId: provider.id, _status: 'success' };
        }

        return result || {
            success: false,
            provider: provider.name,
            _providerName: provider.name,
            _providerId: provider.id,
            _elapsedMs: elapsed,
            _status: status,
            _failReason: failReason,
        };

    } catch (err) {
        const elapsed = Date.now() - start;
        const isTimeout = /TIMEOUT_/.test(err.message) || err.name === 'TimeoutError';
        status = isTimeout ? 'timeout' : 'error';
        failReason = isTimeout
            ? `Timed out after ${elapsed}ms`
            : `Exception: ${err.message}`;

        console.warn(`[Race] ✗ ${provider.name} (${status}): ${failReason}`);

        return {
            success: false,
            provider: provider.name,
            _providerName: provider.name,
            _providerId: provider.id,
            _elapsedMs: elapsed,
            _status: status,
            _failReason: failReason,
        };
    }
}


/**
 * Race all providers in parallel.
 * After first success → wait graceAfterFirstMs for more providers to finish.
 * Returns array of all successful results (for merging).
 */
// Minimum sources from a single provider needed to exit the grace window early.
// Vyla returns 7+ — hitting this threshold lets us skip waiting for slow providers.
const SOURCE_THRESHOLD_FOR_EARLY_EXIT = 4;
const GRACE_SHORT_MS  = 300;   // if first winner has >= SOURCE_THRESHOLD sources
const GRACE_LONG_MS   = 1400;  // if first winner has fewer sources — wait for backup

function collectExtractorResults(extractors, timeoutMs) {
    return new Promise(resolve => {
        let settled = 0;
        const total = extractors.length;
        let resolved = false;
        let graceTimer = null;
        const successes = [];
        const allDiagnostics = [];

        if (total === 0) { resolve([]); return; }

        const finalize = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(masterTimer);
            if (graceTimer) clearTimeout(graceTimer);

            console.log(`[Race] ── Final summary ──────────────────────────────`);
            for (const d of allDiagnostics) {
                const icon = d._status === 'success' ? '✅' : d._status === 'embed_only' ? '🚫' : '❌';
                console.log(`[Race] ${icon} ${d._providerName} → ${d._status} [${d._elapsedMs}ms]${d._failReason ? ` (${d._failReason})` : ''}`);
            }
            if (successes.length === 0) {
                console.warn(`[Race] ❌ ALL providers failed.`);
            } else {
                const totalSources = successes.reduce((n, r) => n + (r.sources?.filter(s => !s.isEmbed).length || 0), 0);
                console.log(`[Race] ✅ ${successes.length}/${total} succeeded → ${totalSources} raw sources total`);
            }
            console.log(`[Race] ────────────────────────────────────────────────`);

            resolve(successes);
        };

        const masterTimer = setTimeout(() => {
            console.warn(`[Race] ⏱ Master timeout (${timeoutMs}ms).`);
            finalize();
        }, timeoutMs);

        extractors.forEach(provider => {
            runExtractorDiag(provider, Math.floor(timeoutMs * 0.9)).then(diagResult => {
                if (resolved) return;

                allDiagnostics.push(diagResult);
                settled++;

                if (diagResult._status === 'success') {
                    const srcCount = diagResult.sources?.filter(s => !s.isEmbed).length || 0;
                    successes.push(diagResult);
                    console.log(`[Race] ✅ ${diagResult._providerName} in ${diagResult._elapsedMs}ms → ${srcCount} raw source(s)`);

                    // Priority Race: Exit immediately on first success
                    console.log(`[Race] ⚡ Priority exit triggered by first winner`);
                    finalize();
                }

                if (settled === total) finalize();
            });
        });
    });
}


// ── Main resolver ─────────────────────────────────────────────────────────────

export async function resolveStreaming(tmdbId, type, season, episode, title, year) {
    console.log(`[Resolver v19] ${title || tmdbId} (${type}${type === 'tv' ? ` S${season}E${episode}` : ''})`);

    // External subtitles fetched in background — never blocks stream delivery
    const externalSubsPromise = scrapeVdrkCaptions(tmdbId, type, season, episode).catch(() => []);

    const mergeExternalSubs = async (result) => {
        if (!result) return result;
        try {
            // 800ms cap — external subs are a nice-to-have, not worth delaying stream delivery
            const externalSubs = await Promise.race([
                externalSubsPromise,
                new Promise(resolve => setTimeout(() => resolve([]), 800))
            ]);
            if (externalSubs?.length) {
                result.subtitles = [...(result.subtitles || []), ...externalSubs];
            }
        } catch (_) {}
        return result;
    };

    // ══ Stage 1: Full parallel race — ALL M3U8/direct-stream providers ══════
    //
    // Vyla (~2-3s) is the new heavyweight — returns 14+ sources from multiple
    // underlying providers in a single HTTP call. VaPlayer is fastest for its
    // own CDN. VidZee/VidSrc.ru/LookMovie add depth.
    //
    // No embed fallbacks. If zero raw sources found → return error.
    const providers = [
        {
            id: 'vyla',
            name: 'Vyla Aggregator',
            run: () => scrapeVyla(tmdbId, type, season, episode)
        },
        {
            id: 'cinesu',
            name: 'CineSu',
            run: () => scrapeCineSu(tmdbId, type, season, episode)
        },
        {
            id: 'vaplayer',
            name: 'VaPlayer',
            run: () => extractVaPlayer({ tmdbId, type, season, episode })
        },
        {
            id: 'vixsrc',
            name: 'VixSrc',
            run: () => scrapeVixSrc(tmdbId, type, season, episode)
        },
        {
            id: 'vidzee',
            name: 'VidZee',
            run: () => scrapeVidZee(tmdbId, type, season, episode)
        },
        {
            id: 'vidsrc_ru',
            name: 'VidSrc.ru',
            run: () => scrapeVidSrcRu(tmdbId, type, season, episode)
        },
        {
            id: 'lookmovie',
            name: 'LookMovie',
            run: () => (title
                ? scrapeLookMovie(tmdbId, type === 'movie' ? 'movie' : 'show', season, episode, title, year)
                : Promise.resolve({ success: false, _skipReason: 'no title provided' })
            )
        },
    ];

    const healthyProviders = await filterByHealth(providers);
    const activeProviders = healthyProviders.length ? healthyProviders : providers;

    console.log(`[Resolver] Racing ${activeProviders.length} provider(s): ${activeProviders.map(p => p.name).join(', ')}`);

    const stageResults = await collectExtractorResults(activeProviders, 22000);

    if (stageResults.length) {
        const mergedSources   = mergeAndRankSources(stageResults);
        const mergedSubtitles = mergeSubtitleArrays(stageResults);

        if (mergedSources.length) {
            // Use the fastest successful provider as the nominal "winner" for metadata
            const winner = [...stageResults].sort((a, b) => (a._elapsedMs || 0) - (b._elapsedMs || 0))[0];

            const result = {
                success:    true,
                provider:   winner.provider || winner._providerName,
                providerId: winner._providerId || 'unknown',
                sources:    mergedSources,
                subtitles:  mergedSubtitles,
                _diagnostics: {
                    stage: 1,
                    providerCount:  stageResults.length,
                    sourceCount:    mergedSources.length,
                    winnerProvider: winner._providerName,
                    winnerElapsedMs: winner._elapsedMs,
                    allProviders: stageResults.map(r => ({
                        name: r._providerName,
                        sources: r.sources?.filter(s => !s.isEmbed).length || 0,
                        ms: r._elapsedMs,
                    })),
                },
            };

            console.log(`[Resolver] ✅ Done: ${mergedSources.length} ranked sources from ${stageResults.length} provider(s). Top: ${mergedSources[0]?.quality} ${mergedSources[0]?.provider}`);
            return mergeExternalSubs(result);
        }
    }

    // ══ No raw sources from any provider ═══════════════════════════════════
    console.warn(`[Resolver] ❌ All providers failed for: ${title || tmdbId}`);
    return {
        success: false,
        error: 'No stream found. All providers are currently unavailable. Please try again in a moment.',
        _diagnostics: {
            stage: 'all_failed',
            note: 'Check /api/stream/diagnose for per-provider detail',
        },
    };
}


// ── Diagnostic helper ──────────────────────────────────────────────────────────

export async function diagnoseProviders(tmdbId, type, season = '1', episode = '1', title = '', year = '') {
    const DIAG_TIMEOUT = 25000;

    const allProviders = [
        { id: 'vyla',      name: 'Vyla Aggregator', run: () => scrapeVyla(tmdbId, type, season, episode) },
        { id: 'cinesu',    name: 'CineSu',          run: () => scrapeCineSu(tmdbId, type, season, episode) },
        { id: 'vaplayer',  name: 'VaPlayer',        run: () => extractVaPlayer({ tmdbId, type, season, episode }) },
        { id: 'vidzee',    name: 'VidZee',          run: () => scrapeVidZee(tmdbId, type, season, episode) },
        { id: 'vidsrc_ru', name: 'VidSrc.ru',       run: () => scrapeVidSrcRu(tmdbId, type, season, episode) },
        { id: 'lookmovie', name: 'LookMovie',       run: () => scrapeLookMovie(tmdbId, type === 'movie' ? 'movie' : 'show', season, episode, title, year) },
    ];

    const startAll = Date.now();
    console.log(`[Diagnose] Running full diagnostic for ${title || tmdbId} (${type})...`);

    const results = await Promise.all(
        allProviders.map(p => runExtractorDiag(p, DIAG_TIMEOUT))
    );

    const report = {
        tmdbId, type, season, episode,
        title: title || null,
        elapsedMs: Date.now() - startAll,
        policy: 'no-embed — only raw M3U8/MP4/MKV sources accepted',
        providers: results.map(r => {
            const out = {
                id:        r._providerId,
                name:      r._providerName,
                status:    r._status,
                elapsedMs: r._elapsedMs,
            };
            if (r._failReason) out.failReason = r._failReason;
            if (r.sources?.length) {
                const rawSources = r.sources.filter(s => !s.isEmbed);
                out.rawSourceCount   = rawSources.length;
                out.embedSourceCount = r.sources.length - rawSources.length;
                out.sources = rawSources.map(s => ({
                    urlPreview: s.url ? s.url.substring(0, 100) + (s.url.length > 100 ? '…' : '') : null,
                    quality:  s.quality,
                    isM3U8:   !!s.isM3U8,
                    noProxy:  !!s.noProxy,
                    provider: s.provider,
                }));
            }
            if (r.subtitles?.length) out.subtitleCount = r.subtitles.length;
            return out;
        }),
    };

    const successCount = results.filter(r => r._status === 'success').length;
    const totalRawSources = results.reduce((n, r) => n + (r.sources?.filter(s => !s.isEmbed).length || 0), 0);
    console.log(`[Diagnose] ✅ ${successCount}/${allProviders.length} providers, ${totalRawSources} raw sources. Total: ${report.elapsedMs}ms`);

    return report;
}
