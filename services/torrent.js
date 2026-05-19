/**
 * Torrent Stream Service — v1.0 (2026-05-02)
 *
 * Implements server-side torrent → HTTP streaming pipeline:
 *
 *   1. Query Torrentio REST API for magnet links by IMDB ID
 *   2. Pick the best magnet (highest seeders, best quality)
 *   3. Add magnet to WebTorrent instance
 *   4. Stream the largest video file as piped HTTP response
 *      (supports Range requests for seek support)
 *
 * Design constraints:
 *   - Login-gated: called only after auth check in index.js route
 *   - Last resort: only triggered after 2 regular source failures
 *   - No debrid: we stream directly from torrent peers
 *   - HF Space keep-alive: continuous range requests from video player
 *     keep the Space awake during active playback sessions
 *   - Concurrent limits: each WebTorrent instance uses ~50-100MB RAM.
 *     Free HF tier has 16GB, so cap at 60 active torrents.
 *
 * CORS: handled by the calling route in index.js
 * Redis: Torrentio results cached for 24h to reduce API pressure
 */

import WebTorrent  from 'webtorrent';
import { proxyAxios, BROWSER_HEADERS } from '../utils/http.js';

// ── Torrentio config ──────────────────────────────────────────────────────────
// Torrentio is a public Stremio addon that indexes torrent sources.
// It's IMDB-ID-based and returns quality-sorted magnet links.
const TORRENTIO_BASE = 'https://torrentio.strem.fun';

// Filters: only english-language, highest quality first
// Providers: YTS (movies), RARBG leftovers, 1337x, TPB, ruTorrent mirrors
const TORRENTIO_OPTIONS = [
    'providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex',
    'qualityfilter=scr,cam',
    'sort=qualityseeders',
].join('|');

// ── WebTorrent pool ───────────────────────────────────────────────────────────
const MAX_ACTIVE = 60;
let   client     = null;
export const activeMap = new Map(); // infoHash → { torrent, lastActive, streamCount }

function getClient() {
    if (!client) {
        client = new WebTorrent({
            // Increase max connections for better peer discovery
            maxConns: 55,
            utp: true,  // UDP-based transport for better NAT traversal
        });
        client.on('error', err => console.error('[Torrent] Client error:', err.message));
        console.log('[Torrent] WebTorrent client initialized');
    }
    return client;
}

// ── Cleanup old torrents ──────────────────────────────────────────────────────
// Remove torrents that have been idle > 30min to free RAM
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function cleanupIdleTorrents() {
    const now = Date.now();
    for (const [hash, entry] of activeMap.entries()) {
        if (entry.streamCount <= 0 && (now - entry.lastActive) > IDLE_TIMEOUT_MS) {
            console.log(`[Torrent] Removing idle torrent: ${hash}`);
            entry.torrent.destroy();
            activeMap.delete(hash);
        }
    }
}

setInterval(cleanupIdleTorrents, 5 * 60 * 1000); // run every 5min

// ── Torrentio + APiBay dual-source pipeline ───────────────────────────────────
/**
 * Fetch magnets from BOTH Torrentio and APiBay simultaneously.
 * Merges, deduplicates by infoHash, sorts by quality → seeders.
 *
 * @param {string} imdbId      - e.g. "tt1375666"
 * @param {string} type        - "movie" | "series"
 * @param {number} season      - TV only
 * @param {number} episode     - TV only
 * @param {string} movieTitle  - Optional text title fallback
 * @param {object} redisClient - Optional cache client
 * @returns {Array<{name, infoHash, magnet, seeders, quality, fileIdx}>} sorted best-first
 */
export async function getTorrentSources(imdbId, type, season, episode, movieTitle = '', redisClient = null) {
    if ((!imdbId || imdbId === 'pending') && (!movieTitle || movieTitle === 'pending')) {
        console.warn('[Torrent] Skipping search: no valid ID or Title');
        return [];
    }

    const mergedKey = `torrent_merged:${imdbId || 'no_id'}:${type}:${season || ''}:${episode || ''}:${movieTitle || ''}`;
    if (redisClient) {
        try {
            const cached = await redisClient.get(mergedKey);
            if (cached) { console.log(`[Torrent] Cache HIT: ${mergedKey}`); return JSON.parse(cached); }
        } catch (_) {}
    }

    const cleanTitle = (movieTitle || '').replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();

    const [apibayResult, ytsResult, eztvResult, knightResult, bitSearchResult, cometResult, mfResult, torrentioResult] = await Promise.allSettled([
        fetchApiBaySources(imdbId, type, season, episode, cleanTitle),
        fetchYTSSources(imdbId, cleanTitle),
        fetchEZTVSources(imdbId, cleanTitle, season, episode),
        fetchJackettioSources(imdbId, type, season, episode),
        fetchBitSearchSources(imdbId, type, season, episode),
        fetchCometSources(imdbId, type, season, episode),
        fetchMediaFusionSources(imdbId, type, season, episode),
        fetchTorrentioSources(imdbId, type, season, episode),
    ]);
 
    const apibay      = apibayResult.status       === 'fulfilled' ? apibayResult.value       : [];
    const yts         = ytsResult.status          === 'fulfilled' ? ytsResult.value          : [];
    const eztv        = eztvResult.status         === 'fulfilled' ? eztvResult.value         : [];
    const jackettio   = knightResult.status       === 'fulfilled' ? knightResult.value       : [];
    const bitSearch   = bitSearchResult.status    === 'fulfilled' ? bitSearchResult.value    : [];
    const comet       = cometResult.status        === 'fulfilled' ? cometResult.value        : [];
    const mediaFusion = mfResult.status           === 'fulfilled' ? mfResult.value           : [];
    const torrentio   = torrentioResult.status    === 'fulfilled' ? torrentioResult.value    : [];

    console.log(`[Torrent] TPB=${apibay.length} YTS=${yts.length} EZTV=${eztv.length} Jackettio=${jackettio.length} BitSearch=${bitSearch.length} Comet=${comet.length} MF=${mediaFusion.length} Torrentio=${torrentio.length}`);

    // Merge — Torrentio entries have fileIdx so they take priority
    const seen    = new Set();
    const merged  = [];
    const qRank   = { '4k': 0, '1080p': 1, '720p': 2, '480p': 3, 'unknown': 4 };

    for (const src of [...apibay, ...yts, ...eztv, ...jackettio, ...bitSearch, ...comet, ...mediaFusion, ...torrentio]) {
        const h = (src.infoHash || '').toLowerCase();
        if (!h || seen.has(h)) continue;
        seen.add(h);
        merged.push(src);
    }

    const nonEngKeywords = ['french', 'truefrench', 'vf', 'vostfr', 'ita', 'german', 'ger', 'spa', 'espanol', 'latino'];
    const detectLanguagePenalty = (name) => {
        const n = (name || '').toLowerCase();
        for (const kw of nonEngKeywords) {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            if (regex.test(n) && !n.includes('multi')) return 100;
        }
        return 0;
    };

    merged.sort((a, b) => {
        // Priority 1: Language (English/Original first)
        const la = detectLanguagePenalty(a.name), lb = detectLanguagePenalty(b.name);
        if (la !== lb) return la - lb;

        // Priority 2: Quality
        const qa = qRank[a.quality] ?? 5, qb = qRank[b.quality] ?? 5;
        if (qa !== qb) return qa - qb;

        // Priority 3: Seeders
        return (b.seeders || 0) - (a.seeders || 0);
    });

    console.log(`[Torrent] ${merged.length} unique sources. Best: ${merged[0]?.quality} @ ${merged[0]?.seeders} seeders`);

    if (redisClient && merged.length) {
        try { await redisClient.set(mergedKey, JSON.stringify(merged), 'EX', 43200); } catch (_) {}
    }
    return merged;
}

// ── Internal: fetch from Torrentio ────────────────────────────────────────────
async function fetchTorrentioSources(imdbId, type, season, episode) {
    if (!imdbId || imdbId === 'pending') return [];
    
    let url;
    if (type === 'movie' || type === 'film') {
        url = `${TORRENTIO_BASE}/${TORRENTIO_OPTIONS}/stream/movie/${imdbId}.json`;
    } else {
        url = `${TORRENTIO_BASE}/${TORRENTIO_OPTIONS}/stream/series/${imdbId}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }
    console.log(`[Torrentio] Fetching: ${url}`);
    
    try {
        const resp = await proxyAxios.get(url, { 
            timeout: 3000, 
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' } 
        });
        const streams = resp.data?.streams || [];
        if (!streams.length) { console.warn('[Torrentio] No streams'); return []; }

    return streams.map(s => {
        const nameLine  = s.name  || '';
        const titleLine = s.title || '';
        const seedMatch = titleLine.match(/\ud83d\udc64\s*(\d+)/);
        const seeders   = seedMatch ? parseInt(seedMatch[1]) : 0;
        const filename  = titleLine.split('\n')[0];

        let quality = 'unknown';
        if (/4k|2160p/i.test(nameLine) || /4k|2160p/i.test(filename)) quality = '4k';
        else if (/1080p/i.test(nameLine) || /1080p/i.test(filename))  quality = '1080p';
        else if (/720p/i.test(nameLine)  || /720p/i.test(filename))   quality = '720p';
        else if (/480p/i.test(nameLine)  || /480p/i.test(filename))   quality = '480p';

        const TRACKERS = 'tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce';
        return {
            name: filename.trim() || nameLine.trim(),
            infoHash: s.infoHash,
            magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(filename.trim())}&${TRACKERS}` : null,
            seeders, quality, fileIdx: s.fileIdx ?? null, source: 'torrentio',
        };
    }).filter(s => s.infoHash);
    } catch (e) {
        console.warn(`[Torrentio] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from YTS ──────────────────────────────────────────────────
async function fetchYTSSources(imdbId, title) {
    if (!imdbId || imdbId === 'pending') return [];
    const url = `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}`;
    try {
        console.log(`[YTS] Fetching: ${url}`);
        const resp = await proxyAxios.get(url, { timeout: 3000, headers: BROWSER_HEADERS });
        const movie = resp.data?.data?.movies?.[0];
        if (!movie || !movie.torrents) return [];

        return movie.torrents.map(t => ({
            name: `${movie.title} (${movie.year}) [${t.quality}] [YTS]`,
            infoHash: t.hash.toLowerCase(),
            magnet: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}`,
            seeders: t.seeds || 0,
            quality: t.quality === '2160p' ? '4k' : t.quality,
            fileIdx: null,
            source: 'yts'
        }));
    } catch (e) {
        console.warn(`[YTS] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from EZTV ─────────────────────────────────────────────────
async function fetchEZTVSources(imdbId, title, season, episode) {
    if (!imdbId || imdbId === 'pending') return [];
    // EZTV API uses the numeric part of IMDB ID
    const idNumeric = imdbId.replace(/\D/g, '');
    const url = `https://eztv.re/api/get-torrents?imdb_id=${idNumeric}`;
    try {
        console.log(`[EZTV] Fetching: ${url}`);
        const resp = await proxyAxios.get(url, { timeout: 3000, headers: BROWSER_HEADERS });
        const torrents = resp.data?.torrents || [];
        
        const s = parseInt(season);
        const e = parseInt(episode);
        
        return torrents
            .filter(t => parseInt(t.season) === s && parseInt(t.episode) === e)
            .map(t => ({
                name: t.title,
                infoHash: t.hash.toLowerCase(),
                magnet: t.magnet_url,
                seeders: t.seeds || 0,
                quality: /1080p/i.test(t.title) ? '1080p' : (/720p/i.test(t.title) ? '720p' : 'unknown'),
                fileIdx: null,
                source: 'eztv'
            }));
    } catch (e) {
        console.warn(`[EZTV] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from Comet ────────────────────────────────────────────────
async function fetchCometSources(imdbId, type, season, episode) {
    if (!imdbId || imdbId === 'pending') return [];
    const COMET_BASE = 'https://comet.elfhosted.com';
    let idStr = imdbId;
    if (/^\d+$/.test(imdbId)) idStr = `tmdb:${imdbId}`;

    let url;
    if (type === 'movie' || type === 'film') {
        url = `${COMET_BASE}/stream/movie/${idStr}.json`;
    } else {
        url = `${COMET_BASE}/stream/series/${idStr}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }
    
    try {
        console.log(`[Comet] Fetching: ${url}`);
        const resp = await proxyAxios.get(url, { timeout: 3000, headers: BROWSER_HEADERS });
        const streams = resp.data?.streams || [];
        return streams.map(s => {
            const title = s.title || '';
            const seedMatch = title.match(/👤\s*(\d+)/);
            const seeders = seedMatch ? parseInt(seedMatch[1]) : 0;
            
            let quality = 'unknown';
            if (/4k|2160p/i.test(title)) quality = '4k';
            else if (/1080p/i.test(title)) quality = '1080p';
            else if (/720p/i.test(title)) quality = '720p';
            
            return {
                name: title.split('\n')[0],
                infoHash: s.infoHash,
                magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : null,
                seeders, quality, fileIdx: s.fileIdx ?? null, source: 'comet',
            };
        }).filter(s => s.infoHash);
    } catch (e) {
        console.warn(`[Comet] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from Jackettio ────────────────────────────────────────
async function fetchJackettioSources(imdbId, type, season, episode) {
    if (!imdbId || imdbId === 'pending') return [];
    const BASE = 'https://jackettio.elfhosted.com';
    let idStr = imdbId;
    if (/^\d+$/.test(imdbId)) idStr = `tmdb:${imdbId}`;

    let url;
    if (type === 'movie' || type === 'film') {
        url = `${BASE}/stream/movie/${idStr}.json`;
    } else {
        url = `${BASE}/stream/series/${idStr}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }
    
    try {
        console.log(`[Jackettio] Fetching: ${url}`);
        const resp = await proxyAxios.get(url, { timeout: 3000, headers: BROWSER_HEADERS });
        const streams = resp.data?.streams || [];
        return streams.map(s => {
            const title = s.title || '';
            const seedMatch = title.match(/👤\s*(\d+)/);
            const seeders = seedMatch ? parseInt(seedMatch[1]) : 0;
            
            let quality = 'unknown';
            if (/4k|2160p/i.test(title)) quality = '4k';
            else if (/1080p/i.test(title)) quality = '1080p';
            else if (/720p/i.test(title)) quality = '720p';
            
            return {
                name: title.split('\n')[0],
                infoHash: s.infoHash,
                magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : null,
                seeders, quality, fileIdx: s.fileIdx ?? null, source: 'jackettio',
            };
        }).filter(s => s.infoHash);
    } catch (e) {
        console.warn(`[Jackettio] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from BitSearch ────────────────────────────────────────────
async function fetchBitSearchSources(imdbId, type, season, episode) {
    if (!imdbId || imdbId === 'pending') return [];
    // BitSearch can be reached via a community Stremio addon or direct API if available.
    // Here we use a reliable community mirror.
    const BASE = 'https://bitsearch.strem.fun';
    let idStr = imdbId;
    if (/^\d+$/.test(imdbId)) idStr = `tmdb:${imdbId}`;

    let url;
    if (type === 'movie' || type === 'film') {
        url = `${BASE}/stream/movie/${idStr}.json`;
    } else {
        url = `${BASE}/stream/series/${idStr}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }
    
    try {
        console.log(`[BitSearch] Fetching: ${url}`);
        const resp = await proxyAxios.get(url, { timeout: 3000, headers: BROWSER_HEADERS });
        const streams = resp.data?.streams || [];
        return streams.map(s => {
            const title = s.title || '';
            const seeders = s.seeders || 0;
            
            let quality = 'unknown';
            if (/4k|2160p/i.test(title)) quality = '4k';
            else if (/1080p/i.test(title)) quality = '1080p';
            else if (/720p/i.test(title)) quality = '720p';
            
            return {
                name: title.split('\n')[0],
                infoHash: s.infoHash,
                magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : null,
                seeders, quality, fileIdx: s.fileIdx ?? null, source: 'bitsearch',
            };
        }).filter(s => s.infoHash);
    } catch (e) {
        console.warn(`[BitSearch] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from MediaFusion ──────────────────────────────────────────
async function fetchMediaFusionSources(imdbId, type, season, episode) {
    if (!imdbId || imdbId === 'pending') return [];
    const MF_BASE = 'https://mediafusion.elfhosted.com';
    let idStr = imdbId;
    if (/^\d+$/.test(imdbId)) idStr = `tmdb:${imdbId}`;

    let url;
    if (type === 'movie' || type === 'film') {
        url = `${MF_BASE}/stream/movie/${idStr}.json`;
    } else {
        url = `${MF_BASE}/stream/series/${idStr}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }

    try {
        console.log(`[MediaFusion] Fetching: ${url}`);
        const resp = await proxyAxios.get(url, { timeout: 3000, headers: BROWSER_HEADERS });
        const streams = resp.data?.streams || [];
        return streams.map(s => {
            const title = s.description || s.title || '';
            const seedMatch = title.match(/👤\s*(\d+)/);
            const seeders = seedMatch ? parseInt(seedMatch[1]) : 0;

            let quality = 'unknown';
            if (/4k|2160p/i.test(title)) quality = '4k';
            else if (/1080p/i.test(title)) quality = '1080p';
            else if (/720p/i.test(title)) quality = '720p';

            return {
                name: title.split('\n')[0],
                infoHash: s.infoHash,
                magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : null,
                seeders, quality, fileIdx: s.fileIdx ?? null, source: 'mediafusion',
            };
        }).filter(s => s.infoHash);
    } catch (e) {
        console.warn(`[MediaFusion] Error: ${e.message}`);
        return [];
    }
}

// ── Internal: fetch from APiBay (The Pirate Bay API) ─────────────────────────
async function fetchApiBaySources(imdbId, type, season, episode, title = '') {
    const VIDEO_CATS = new Set(['200','201','202','205','206','207','208','500','501','502','503','504']);
    const TRACKERS = 'tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce';

    let query = imdbId;
    if (!query || query === 'pending') query = title;
    if (!query) return [];

    console.log(`[APiBay] Fetching: https://apibay.org/q.php?q=${query}`);
    try {
        const resp = await proxyAxios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
            timeout: 3000,
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' },
        });

        const results = resp.data;
        if (!Array.isArray(results) || results[0]?.name === 'No results returned') {
            // Fallback to title search if IMDB ID failed
            if (query === imdbId && title) {
                return fetchApiBaySources('', type, season, episode, title);
            }
            return [];
        }

        let filtered = results.filter(t => VIDEO_CATS.has(t.category) && parseInt(t.seeders) > 0);

        // For TV, filter by season+episode pattern if possible
        if (type !== 'movie' && season && episode) {
            const s = String(season).padStart(2, '0');
            const e = String(episode).padStart(2, '0');
            const pat = new RegExp(`[Ss]0*${season}[Ee]0*${episode}|S${s}E${e}|${season}x${e}`, 'i');
            const tv = filtered.filter(t => pat.test(t.name));
            if (tv.length > 0) filtered = tv;
        }

        const detectQuality = (name) => {
            const n = name.toLowerCase();
            if (/4k|2160p|uhd/.test(n)) return '4k';
            if (/1080p|fhd/.test(n))    return '1080p';
            if (/720p|hd/.test(n))      return '720p';
            if (/480p|sd/.test(n))      return '480p';
            return 'unknown';
        };

        return filtered
            .map(t => ({
                name:     t.name,
                infoHash: t.info_hash.toLowerCase(),
                magnet:   `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}&${TRACKERS}`,
                seeders:  parseInt(t.seeders) || 0,
                quality:  detectQuality(t.name),
                fileIdx:  null,
                source:   'apibay',
            }))
            .filter(t => t.infoHash)
            .slice(0, 30);
    } catch (e) {
        console.warn(`[APiBay] Error: ${e.message}`);
        return [];
    }
}



// ── Stream a torrent file to an HTTP response ─────────────────────────────────
/**
 * Adds magnet to WebTorrent pool, waits for metadata, then pipes the
 * largest video file as a streaming HTTP response with Range support.
 *
 * @param {string}       magnetUri  - Full magnet link
 * @param {number|null}  fileIdx    - Specific file index (Torrentio provides this)
 * @param {object}       req        - Express request (for Range header)
 * @param {object}       res        - Express response
 */
export async function streamTorrent(magnetUri, fileIdx, req, res) {
    const wt = getClient();

    // Check active torrent pool capacity
    if (activeMap.size >= MAX_ACTIVE) {
        cleanupIdleTorrents();
        if (activeMap.size >= MAX_ACTIVE) {
            res.status(503).json({ error: 'Torrent pool at capacity. Try again shortly.' });
            return;
        }
    }

    return new Promise((resolve, reject) => {
        // Extract infoHash from magnet to check if already loaded
        const infoHashMatch = magnetUri.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        const infoHash      = infoHashMatch?.[1]?.toLowerCase();

        // Reuse existing torrent if already in pool
        const existing = infoHash ? activeMap.get(infoHash) : null;
        const torrent  = existing?.torrent ?? null;

        const startStream = (t) => {
            // Pick correct file: by fileIdx if provided, else largest video file
            let file;
            const videoFiles = t.files.filter(f =>
                /\.(mp4|mkv|avi|mov|wmv|ts|m4v)$/i.test(f.name)
            );

            if (fileIdx != null && t.files[fileIdx]) {
                file = t.files[fileIdx];
            } else {
                file = videoFiles.sort((a, b) => b.length - a.length)[0];
            }

            if (!file) {
                res.status(404).json({ error: 'No video file found in torrent' });
                resolve();
                return;
            }

            console.log(`[Torrent] Streaming: ${file.name} (${(file.length / 1e9).toFixed(2)}GB)`);

            // Update active tracker
            const entry = activeMap.get(infoHash) || { torrent: t, lastActive: Date.now(), streamCount: 0 };
            entry.streamCount++;
            entry.lastActive = Date.now();
            activeMap.set(infoHash, entry);

            const totalSize = file.length;
            const rangeHeader = req.headers['range'];

            let start = 0;
            let end   = totalSize - 1;

            if (rangeHeader) {
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                start = parseInt(parts[0], 10);
                end   = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
                end   = Math.min(end, totalSize - 1);
            }

            const chunkSize = end - start + 1;

            res.writeHead(rangeHeader ? 206 : 200, {
                'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
                'Accept-Ranges':  'bytes',
                'Content-Length': chunkSize,
                'Content-Type':   'video/mp4',
                'Cache-Control':  'no-cache',
            });

            const stream = file.createReadStream({ start, end });

            stream.pipe(res);

            stream.on('error', (err) => {
                console.error(`[Torrent] Stream error: ${err.message}`);
                entry.streamCount = Math.max(0, entry.streamCount - 1);
                entry.lastActive  = Date.now();
                resolve();
            });

            res.on('close', () => {
                entry.streamCount = Math.max(0, entry.streamCount - 1);
                entry.lastActive  = Date.now();
                console.log(`[Torrent] Client disconnected from ${file.name}`);
                resolve();
            });
        };

        if (torrent) {
            // Already loaded — start streaming immediately
            console.log(`[Torrent] Reusing existing torrent: ${infoHash}`);
            startStream(torrent);
        } else {
            // Add new torrent and wait for metadata
            console.log(`[Torrent] Adding new magnet: ${magnetUri.substring(0, 80)}...`);

            const timeout = setTimeout(() => {
                console.warn('[Torrent] Metadata timeout (30s)');
                res.status(504).json({ error: 'Torrent metadata timeout. Peers may be unavailable.' });
                resolve();
            }, 30000);

            wt.add(magnetUri, { path: '/tmp/pstream_torrent_cache' }, (t) => {
                clearTimeout(timeout);
                console.log(`[Torrent] Metadata ready: ${t.name}`);

                activeMap.set(infoHash || t.infoHash, {
                    torrent:     t,
                    lastActive:  Date.now(),
                    streamCount: 0,
                });

                startStream(t);
            });
        }
    });
}
