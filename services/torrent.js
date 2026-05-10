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
import axios       from 'axios';

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
 * @param {string} imdbId   - e.g. "tt1375666"
 * @param {string} type     - "movie" | "series"
 * @param {number} season   - TV only
 * @param {number} episode  - TV only
 * @returns {Array<{name, infoHash, magnet, seeders, quality, fileIdx}>} sorted best-first
 */
export async function getTorrentSources(imdbId, type, season, episode, redisClient = null) {
    const mergedKey = `torrent_merged:${imdbId}:${type}:${season || ''}:${episode || ''}`;
    if (redisClient) {
        try {
            const cached = await redisClient.get(mergedKey);
            if (cached) { console.log(`[Torrent] Cache HIT: ${mergedKey}`); return JSON.parse(cached); }
        } catch (_) {}
    }

    const [torrentioResult, cometResult, mediaFusionResult, apibayResult] = await Promise.allSettled([
        fetchTorrentioSources(imdbId, type, season, episode),
        fetchCometSources(imdbId, type, season, episode),
        fetchMediaFusionSources(imdbId, type, season, episode),
        fetchApiBaySources(imdbId, type, season, episode),
    ]);

    const torrentio   = torrentioResult.status    === 'fulfilled' ? torrentioResult.value    : [];
    const comet       = cometResult.status        === 'fulfilled' ? cometResult.value        : [];
    const mediaFusion = mediaFusionResult.status  === 'fulfilled' ? mediaFusionResult.value  : [];
    const apibay      = apibayResult.status       === 'fulfilled' ? apibayResult.value       : [];
    console.log(`[Torrent] Torrentio=${torrentio.length} Comet=${comet.length} MediaFusion=${mediaFusion.length} APiBay=${apibay.length}`);

    // Merge — Torrentio entries have fileIdx so they take priority
    const seen    = new Set();
    const merged  = [];
    const qRank   = { '4k': 0, '1080p': 1, '720p': 2, '480p': 3, 'unknown': 4 };

    for (const src of [...torrentio, ...comet, ...mediaFusion, ...apibay]) {
        const h = (src.infoHash || '').toLowerCase();
        if (!h || seen.has(h)) continue;
        seen.add(h);
        merged.push(src);
    }

    merged.sort((a, b) => {
        const qa = qRank[a.quality] ?? 5, qb = qRank[b.quality] ?? 5;
        if (qa !== qb) return qa - qb;
        return b.seeders - a.seeders;
    });

    console.log(`[Torrent] ${merged.length} unique sources. Best: ${merged[0]?.quality} @ ${merged[0]?.seeders} seeders`);

    if (redisClient && merged.length) {
        try { await redisClient.set(mergedKey, JSON.stringify(merged), 'EX', 43200); } catch (_) {}
    }
    return merged;
}

// ── Internal: fetch from Torrentio ────────────────────────────────────────────
async function fetchTorrentioSources(imdbId, type, season, episode) {
    let url;
    if (type === 'movie' || type === 'film') {
        url = `${TORRENTIO_BASE}/${TORRENTIO_OPTIONS}/stream/movie/${imdbId}.json`;
    } else {
        url = `${TORRENTIO_BASE}/${TORRENTIO_OPTIONS}/stream/series/${imdbId}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }
    console.log(`[Torrentio] Fetching: ${url}`);
    const resp = await axios.get(url, { timeout: 12000, headers: { 'Accept': 'application/json' } });
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
}

// ── Internal: fetch from Comet ────────────────────────────────────────────────
async function fetchCometSources(imdbId, type, season, episode) {
    const COMET_BASE = 'https://comet.strem.fun';
    let url;
    if (type === 'movie' || type === 'film') {
        url = `${COMET_BASE}/stream/movie/${imdbId}.json`;
    } else {
        url = `${COMET_BASE}/stream/series/${imdbId}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }
    
    try {
        console.log(`[Comet] Fetching: ${url}`);
        const resp = await axios.get(url, { timeout: 10000 });
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

// ── Internal: fetch from MediaFusion ──────────────────────────────────────────
async function fetchMediaFusionSources(imdbId, type, season, episode) {
    const MF_BASE = 'https://mediafusion.fun';
    let url;
    if (type === 'movie' || type === 'film') {
        url = `${MF_BASE}/stream/movie/${imdbId}.json`;
    } else {
        url = `${MF_BASE}/stream/series/${imdbId}:${parseInt(season)||1}:${parseInt(episode)||1}.json`;
    }

    try {
        console.log(`[MediaFusion] Fetching: ${url}`);
        const resp = await axios.get(url, { timeout: 10000 });
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
async function fetchApiBaySources(imdbId, type, season, episode) {
    const VIDEO_CATS = new Set(['200','201','202','205','206','207','208','500','501','502','503','504']);
    const TRACKERS = 'tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce';

    console.log(`[APiBay] Fetching: https://apibay.org/q.php?q=${imdbId}`);
    const resp = await axios.get(`https://apibay.org/q.php?q=${imdbId}`, {
        timeout: 8000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });

    const results = resp.data;
    if (!Array.isArray(results) || results[0]?.name === 'No results returned') return [];

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
