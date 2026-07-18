import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { createChallenge, verifyChallenge } from './utils/challenge.js';
import { getProfile, updateProfile, deleteProfile } from './utils/db.js';
import { resolveStreaming, diagnoseProviders } from './resolver.js';
import { USER_AGENTS, getRandomUA } from './utils/constants.js';
import Redis from 'ioredis';
import { recordProviderError, recordProviderSuccess, getAllProviderHealth, canonicalProviderId } from './services/providerHealth.js';
import { getTorrentSources, streamTorrent, activeMap as torrentPool } from './services/torrent.js';
import { resolveTrailerId, getTrailerCacheStats } from './services/trailer.js';
import { AllDebrid } from './services/alldebrid.js';
import { scrapeVdrkCaptions } from './extractors/subs_vdrk.js';

dotenv.config();
// BUILD: 2026-04-16T06:50Z � SuperEmbed Stage1A, proxy?gigaAxios, raceExtractors v14.1

import { gigaAxios, proxyAxios, browserHttpsAgent } from './utils/http.js';

const app = express();
const PORT = process.env.PORT || 7860;

// --- REDIS (UPSTASH) ---
let redis = null;
if (process.env.REDIS_URL) {
    try {
        redis = new Redis(process.env.REDIS_URL);
        console.log('[Engine] Syncing with Cloud Redis...');
    } catch (e) {}
}
export { redis };

if (!process.env.JWT_SECRET) { console.error('[FATAL] JWT_SECRET env var is not set.'); process.exit(1); }
const JWT_SECRET = process.env.JWT_SECRET;

// CORS — whitelist only the frontend domain
const ALLOWED_ORIGINS = [
    'https://pstream-frontend.pages.dev',
    'https://pstream.watch',
    'https://www.pstream.watch',
    'https://ibrahimar397-pstream-giga.hf.space',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:4173'
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (curl, mobile apps, Hls.js segment fetches)
        if (!origin || ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.pages.dev')) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: Origin '${origin}' is not allowed`));
        }
    },
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use('/assets', express.static('assets'));

// Simple in-memory rate limiter for auth endpoints
const rateLimitMap = new Map();
function rateLimit(key, maxRequests = 10, windowMs = 60000) {
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    rateLimitMap.set(key, entry);
    return entry.count > maxRequests;
}

// --- ASSET RESOLVER (Local vs Remote) ---

const getAsset = (name, remote) => {
    try {
        if (fs.existsSync(`./assets/${name}`)) return `/assets/${name}`;
    } catch (e) {}
    return remote;
};

const LOGO = getAsset('pstream-logo.svg', 'https://raw.githubusercontent.com/Promarcos397/pstream-frontend/main/assets/logos/pstream-logo.svg');
const BG_IMG = getAsset('landing-bg.png', 'https://raw.githubusercontent.com/Promarcos397/pstream-frontend/main/assets/landing-bg.png');

// --- CINEMATIC DESIGN SYSTEM ---

const MASTER_DESIGN = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root { --p-red: #e50914; --p-dark: #000; --p-glass: rgba(0, 0, 0, 0.85); --p-border: rgba(255, 255, 255, 0.1); }
        * { box-sizing: border-box; }
        body { 
            background: #000; color: #fff; font-family: 'Consolas', monospace; 
            margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
            overflow: hidden; position: relative; -webkit-font-smoothing: antialiased;
        }
        .bg-layer { position: absolute; inset: 0; z-index: -10; }
        .bg-img { 
            position: absolute; inset: 0; background: url('${BG_IMG}') center/cover no-repeat; 
            opacity: 0.6; transform: scale(1.05); filter: blur(2px) brightness(0.4);
        }
        .bg-gradient { 
            position: absolute; inset: 0; 
            background: linear-gradient(to bottom, 0%, rgba(0,0,0,0) 50%, 100%), 
                        radial-gradient(circle at center, transparent 0%, black 90%); 
        }
        .container { position: relative; z-index: 100; width: 100%; max-width: 550px; padding: 2rem; animation: entry 1.5s ease-out; }
        
        .logo { 
            height: clamp(24px, 5vw, 30px); margin-bottom: 3.5rem; filter: drop-shadow(0 0 10px rgba(229, 9, 20, 0.3)); 
            transition: 0.4s; cursor: pointer; display: inline-block;
        }
        .logo:hover { filter: drop-shadow(0 0 20px rgba(229, 9, 20, 0.6)); transform: scale(1.05); }

        .card {
            background: var(--p-glass); border: 1px solid var(--p-border); border-radius: 4px;
            padding: 4rem 3rem; backdrop-filter: blur(24px); box-shadow: 0 40px 100px rgba(0,0,0,1);
            position: relative; overflow: hidden;
        }
        .card::after {
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(229, 9, 20, 0.5), transparent);
        }

        h1 { font-size: 1.8rem; font-weight: 900; margin: 0 0 0.5rem; letter-spacing: 2px; text-transform: uppercase; }
        .tagline { font-size: 0.7rem; color: rgba(255,255,255,0.35); margin-bottom: 3.5rem; text-transform: uppercase; letter-spacing: 4px; display: block; }

        .grid { display: grid; grid-template-cols: 1fr 1fr; gap: 2rem; margin-bottom: 3rem; }
        .grid-item { position: relative; padding-left: 12px; border-left: 2px solid var(--p-red); }
        .val { font-size: 1.1rem; font-weight: 900; color: #fff; display: block; }
        .lbl { font-size: 0.6rem; color: rgba(255,255,255,0.2); text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; font-weight: bold; }

        .status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 6px; background: #00ff55; box-shadow: 0 0 10px #00ff55; }
        .dot-offline { background: #ff0055; box-shadow: 0 0 10px #ff0055; }

        .btn-group { display: flex; flex-direction: column; gap: 1rem; }
        .btn {
            background: var(--p-red); color: #fff; text-decoration: none; padding: 1.2rem;
            border-radius: 2px; font-weight: 900; text-transform: uppercase; font-size: 0.8rem;
            letter-spacing: 2px; transition: 0.3s cubic-bezier(0.4, 0, 0.2, 1); text-align: center;
            box-shadow: 0 5px 20px rgba(229, 9, 20, 0.2);
        }
        .btn:hover { background: #ff0b17; transform: translateY(-3px); box-shadow: 0 12px 40px rgba(229, 9, 20, 0.5); }
        .btn-ghost { background: transparent; border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.5); box-shadow: none; }
        .btn-ghost:hover { border-color: rgba(255,255,255,0.4); color: #fff; background: rgba(255,255,255,0.05); }

        @keyframes entry { 
            from { opacity: 0; transform: translateY(15px) scale(0.98); } 
            to { opacity: 1; transform: translateY(0) scale(1); } 
        }
        .pulse { animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
    </style>
`;

// --- ROUTE: HOME ---

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <title>Pstream Engine</title>
        ${MASTER_DESIGN}
        <style>
            .hero-text { font-size: clamp(2.5rem, 8vw, 4.5rem); font-weight: 900; line-height: 1.1; margin-bottom: 1.5rem; letter-spacing: -2px; }
            .sub-text { font-size: 1.2rem; color: #fff; margin-bottom: 3.5rem; max-width: 600px; margin-left: auto; margin-right: auto; line-height: 1.6; }
            .main-btn { 
                display: inline-flex; align-items: center; justify-content: center; gap: 10px;
                background: var(--p-red); color: #fff; text-decoration: none; padding: 1.5rem 4rem;
                font-size: 1.6rem; font-weight: 900; border-radius: 4px; transition: 0.3s;
                box-shadow: 0 10px 40px rgba(229, 9, 20, 0.4);
            }
            .main-btn:hover { background: #ff0b17; transform: scale(1.02); box-shadow: 0 15px 50px rgba(229, 9, 20, 0.6); }
            .sub-link { 
                margin-top: 2rem; color: rgba(255,255,255,0.5); text-decoration: none; 
                font-size: 0.8rem; font-weight: 900; letter-spacing: 2px; text-transform: uppercase; 
                transition: 0.2s; display: inline-block;
            }
            .sub-link:hover { color: #fff; letter-spacing: 3px; }
        </style>
    </head>
    <body>
        <div class="bg-layer"><div class="bg-img"></div><div class="bg-gradient"></div></div>
        <div class="container" style="max-width: 900px">
            <a href="https://pstream.watch"><img src="${LOGO}" alt="Pstream" class="logo" /></a>
            
            <h1 class="hero-text">Unlimited power, series and more</h1>
            <p class="sub-text">Pstream Engine v5.0.0 is ready. Launch the hub to explore your collection or check system health below.</p>
            
            <div>
                <a href="https://pstream.watch" class="main-btn">
                    Get Started 
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </a>
            </div>

            <a href="/healthcheck" class="sub-link">System Diagnostics & Cluster Stats</a>
        </div>
    </body>
    </html>
    `);
});

// --- ROUTE: PING (keep-alive / wake-up) ---
// Ultra-lightweight. The frontend calls this on mount to wake the HF Space.
// Returns in <1ms. No DB, no providers, no heavy processing.
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, t: Date.now() });
});

// --- ROUTE: PROVIDER DEBUG (test each Stage 1A provider individually) ---
app.get('/api/debug-providers', async (req, res) => {
    const { tmdbId = '637', type = 'movie', season = '1', episode = '1' } = req.query;

    // Only the live roster — see resolver.js for why the others were retired.
    // This route previously imported ./extractors/vidzee.js, which does not
    // exist, so every call threw before reaching a single provider.
    const [
        { scrapeVixSrc },
        { scrapeLookMovie },
    ] = await Promise.all([
        import('./extractors/vixsrc.js'),
        import('./extractors/lookmovie.js'),
    ]);

    const test = async (name, fn) => {
        const start = Date.now();
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...args) => { warns.push(args.join(' ')); origWarn(...args); };
        try {
            const result = await Promise.race([
                fn(),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT_12s')), 12000))
            ]);
            console.warn = origWarn;
            const rawSources = (result?.sources || []).filter(s => !s.isEmbed);
            return {
                name,
                ok: !!result?.success && rawSources.length > 0,
                provider: result?.provider,
                rawSources: rawSources.length,
                embedSources: (result?.sources?.length || 0) - rawSources.length,
                ms: Date.now() - start,
                warns: warns.slice(-3),
            };
        } catch (e) {
            console.warn = origWarn;
            return { name, ok: false, error: e.message, warns: warns.slice(-3), ms: Date.now() - start };
        }
    };

    const results = await Promise.allSettled([
        test('VixSrc',    () => scrapeVixSrc(tmdbId, type, season, episode)),
        test('LookMovie', () => scrapeLookMovie(tmdbId, type === 'movie' ? 'movie' : 'show', season, episode, req.query.title || '', req.query.year || '')),
    ]);

    res.json({ tmdbId, type, policy: 'no-embed', results: results.map(r => r.value || { error: r.reason?.message }) });
});

// --- ROUTE: HEALTH CHECK ---

app.get('/healthcheck', async (req, res) => {
    const mem = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
    const rss = Math.floor(process.memoryUsage().rss / 1024 / 1024);
    const cpuUsage = process.cpuUsage();
    const cpu = Math.round((((cpuUsage.user + cpuUsage.system) / 1000) / Math.max(process.uptime(), 1)) / 10) / 10;
    const uptime = Math.floor(process.uptime());

    const providers = [
        { name: 'Vyla Aggregator', url: 'https://vyla-api.pages.dev' },
        { name: 'VaPlayer', url: 'https://streamdata.vaplayer.ru' },
        { name: 'VidZee', url: 'https://player.vidzee.wtf' },
        { name: 'VidSrc.ru', url: 'https://vsembed.ru' },
        { name: 'LookMovie API', url: 'https://lmscript.xyz' },
        { name: 'Torrentio', url: 'https://torrentio.strem.fun' },
    ];
    const probeProvider = async (provider) => {
        const started = Date.now();
        try {
            const resp = await gigaAxios.get(provider.url, {
                timeout: 5000,
                maxRedirects: 2,
                validateStatus: () => true,
            });
            const status = resp.status;
            // 2xx/3xx/4xx all prove the host is reachable from backend network.
            const ok = status >= 200 && status < 500;
            return { ...provider, ok, status, latencyMs: Date.now() - started };
        } catch (e) {
            return { ...provider, ok: false, status: 0, latencyMs: Date.now() - started, error: e.message };
        }
    };
    const providerStatus = await Promise.all(providers.map(probeProvider));
    const providerUpCount = providerStatus.filter(p => p.ok).length;
    const providerHealth = await getAllProviderHealth();
    const suspendedCount = Object.values(providerHealth || {}).filter((p) => p?.suspended).length;
    const redisStatus = !!redis;

    if (req.headers.accept?.includes('text/html')) {
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <title>Pstream Diagnostics</title>
            ${MASTER_DESIGN}
            <style>
                .grid { grid-template-cols: 1fr 1fr 1fr; margin-bottom: 2rem !important; }
                .card { padding: 3rem 2rem; max-width: 600px; }
                .provider-list { 
                    display: grid; grid-template-cols: 1fr 1fr; gap: 0.8rem; 
                    margin-top: 2rem; padding: 1.5rem; background: rgba(255,255,255,0.03); 
                    border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);
                }
                .p-link { 
                    font-size: 0.65rem; color: rgba(255,255,255,0.4); text-decoration: none; 
                    display: flex; align-items: center; transition: 0.2s;
                }
                .p-link:hover { color: var(--p-red); transform: translateX(4px); }
                .p-dot { width: 4px; height: 4px; border-radius: 50%; background: #00ff55; margin-right: 8px; box-shadow: 0 0 5px #00ff55; }
            </style>
        </head>
        <body>
            <div class="bg-layer"><div class="bg-img"></div><div class="bg-gradient"></div></div>
            <div class="container" style="max-width: 600px">
                <a href="/"><img src="${LOGO}" alt="Pstream" class="logo" /></a>
                <div class="card">
                    <h1>DIAGNOSTICS</h1>
                    <span class="tagline">Engine Performance Data</span>
                    <div class="grid">
                        <div class="grid-item">
                            <span class="val">${uptime}s</span>
                            <span class="lbl">Uptime</span>
                        </div>
                        <div class="grid-item">
                            <span class="val">${mem}MB</span>
                            <span class="lbl">Heap Used</span>
                        </div>
                        <div class="grid-item">
                            <span class="val">${rss}MB</span>
                            <span class="lbl">RSS</span>
                        </div>
                        <div class="grid-item">
                            <span class="val">${cpu}%</span>
                            <span class="lbl">CPU Avg</span>
                        </div>
                        <div class="grid-item">
                            <span class="val">${providerUpCount}/${providerStatus.length}</span>
                            <span class="lbl">Providers Up</span>
                        </div>
                        <div class="grid-item">
                            <span class="val"><span class="status-dot ${redisStatus ? '' : 'dot-offline'}"></span>${redisStatus ? 'Online' : 'Off'}</span>
                            <span class="lbl">Redis</span>
                        </div>
                        <div class="grid-item">
                            <span class="val">${suspendedCount}</span>
                            <span class="lbl">Suspended</span>
                        </div>
                    </div>

                    <span class="lbl" style="text-align: left; display: block; margin-left: 5px">Cluster Relays</span>
                    <div class="provider-list">
                        ${providerStatus.map(p => `
                            <a href="${p.url}" target="_blank" class="p-link">
                                <span class="p-dot ${p.ok ? '' : 'dot-offline'}"></span>
                                ${p.name} ${p.status ? `<span style="opacity:.6;margin-left:6px">(${p.status}, ${p.latencyMs}ms)</span>` : `<span style="opacity:.6;margin-left:6px">(offline)</span>`}
                            </a>
                        `).join('')}
                    </div>

                    <div class="btn-group" style="margin-top: 2rem">
                        <a href="/" class="btn">Return to Core</a>
                    </div>
                </div>
            </div>
        </body>
        </html>
        `);
    } else {
        res.json({
            status: 'live',
            uptime,
            memory: { heapMb: mem, rssMb: rss },
            cpuAvgPercent: cpu,
            redis: redisStatus,
        });
    }
});

// ─── /admin — Giga Backend Admin Dashboard ─────────────────────────────────
// Protected by ADMIN_SECRET env var.  Access: GET /admin?token=YOUR_SECRET
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const _adminReqLog = [];
const MAX_ADMIN_LOG = 50;
function recordAdminReq(tmdbId, type, provider, latencyMs, ok) {
    _adminReqLog.unshift({ ts: Date.now(), tmdbId, type, provider, latencyMs, ok });
    if (_adminReqLog.length > MAX_ADMIN_LOG) _adminReqLog.length = MAX_ADMIN_LOG;
}

app.get('/admin', async (req, res) => {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (ADMIN_SECRET && token !== ADMIN_SECRET) {
        return res.status(401).send('401 — pass ?token=YOUR_ADMIN_SECRET');
    }
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const uptimeSec = Math.round(process.uptime());
    const uptimeStr = `${Math.floor(uptimeSec/3600)}h ${Math.floor((uptimeSec%3600)/60)}m`;
    const redisUp = !!redis;
    const ph = await getAllProviderHealth().catch(() => ({}));
    const provs = [
        { name:'VaPlayer',  url:'https://streamdata.vaplayer.ru' },
        { name:'VidZee',    url:'https://player.vidzee.wtf' },
        { name:'VidSrc.ru', url:'https://vsembed.ru' },
        { name:'LookMovie', url:'https://lmscript.xyz' },
        { name:'Vyla',      url:'https://vyla-api.pages.dev' },
        { name:'CineSu',    url:'https://cine.su' },
    ];
    const probed = await Promise.all(provs.map(async p => {
        const t = Date.now();
        try { const r = await gigaAxios.get(p.url,{timeout:4000,validateStatus:()=>true,maxRedirects:1}); return {...p,ok:r.status<500,status:r.status,ms:Date.now()-t}; }
        catch(e) { return {...p,ok:false,status:0,ms:Date.now()-t}; }
    }));
    const upCount = probed.filter(p=>p.ok).length;
    const phRows = Object.entries(ph).map(([id,h])=>{
        const total=(h.successCount||0)+(h.failCount||0);
        const rate=total?Math.round((h.failCount||0)/total*100):0;
        const col=h.suspended?'#ef4444':rate>50?'#f97316':'#22c55e';
        return `<tr><td>${id}</td><td style="color:${col}">${h.suspended?'suspended':rate>50?'degraded':'healthy'}</td><td>${h.successCount||0}</td><td>${h.failCount||0}</td><td>${h.avgLatencyMs?Math.round(h.avgLatencyMs)+'ms':'—'}</td></tr>`;
    }).join('')||'<tr><td colspan="5" style="color:#444">Play a title first</td></tr>';
    const reqRows = _adminReqLog.slice(0,15).map(r=>{
        const ago=Math.round((Date.now()-r.ts)/1000);
        return `<tr><td style="color:#555">${ago}s ago</td><td>${r.tmdbId||'—'} (${r.type||'?'})</td><td>${r.provider||'—'}</td><td>${r.latencyMs?r.latencyMs+'ms':'—'}</td><td style="color:${r.ok?'#22c55e':'#ef4444'}">${r.ok?'✓':'✗'}</td></tr>`;
    }).join('')||'<tr><td colspan="5" style="color:#444">No requests yet</td></tr>';
    const provRows = probed.map(p=>`<tr><td>${p.name}</td><td style="color:${p.ok?'#22c55e':'#ef4444'}">${p.ok?`✓ ${p.status}`:`✗ ${p.status||'offline'}`}</td><td style="color:#555">${p.ms}ms</td><td><a href="${p.url}" target="_blank" style="color:#e50914;font-size:.7rem">${p.url}</a></td></tr>`).join('');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Giga Admin</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#080808;color:#e5e5e5;font-family:Consolas,monospace;padding:24px 18px;font-size:13px}
h1{color:#e50914;font-size:1.25rem;font-weight:700}.sub{color:#444;font-size:.7rem;margin-bottom:24px;margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}
.card{background:#111;border:1px solid #1c1c1c;border-radius:10px;padding:14px}.card .lbl{font-size:.58rem;color:#444;text-transform:uppercase;letter-spacing:2px;margin-bottom:5px}.card .val{font-size:1.5rem;font-weight:700;color:#fff}
.red{color:#ef4444!important}.green{color:#22c55e!important}.amber{color:#f97316!important}
h2{font-size:.6rem;color:#444;text-transform:uppercase;letter-spacing:2px;margin:18px 0 8px}
table{width:100%;border-collapse:collapse;background:#111;border-radius:10px;overflow:hidden;margin-bottom:18px}
th{background:#161616;color:#444;text-align:left;padding:7px 10px;font-size:.58rem;text-transform:uppercase;letter-spacing:1.5px}
td{padding:7px 10px;border-top:1px solid #161616;color:#aaa;font-size:.72rem}
.btn{display:inline-block;padding:5px 12px;background:#e50914;color:#fff;border:none;border-radius:6px;text-decoration:none;font-size:.68rem;cursor:pointer;margin-right:6px}
.btn.g{background:transparent;border:1px solid #2a2a2a;color:#777}</style></head><body>
<h1>⚙ Giga Backend</h1><div class="sub">${new Date().toUTCString()}</div>
<div class="grid">
<div class="card"><div class="lbl">Uptime</div><div class="val">${uptimeStr}</div></div>
<div class="card"><div class="lbl">Heap</div><div class="val">${mem}MB</div></div>
<div class="card"><div class="lbl">RSS</div><div class="val">${rss}MB</div></div>
<div class="card"><div class="lbl">Redis</div><div class="val ${redisUp?'green':'red'}">${redisUp?'ON':'OFF'}</div></div>
<div class="card"><div class="lbl">Providers</div><div class="val ${upCount<3?'red':upCount<5?'amber':'green'}">${upCount}/${probed.length}</div></div>
<div class="card"><div class="lbl">Log Entries</div><div class="val">${_adminReqLog.length}</div></div>
</div>
<div style="margin-bottom:18px">
<a class="btn" href="#" onclick="fetch('/api/cache/clear',{method:'POST'}).then(r=>r.json()).then(d=>alert(d.message||'Done'));return false">🗑 Clear Cache</a>
<a class="btn g" href="/diagnostics">Diagnostics</a>
<a class="btn g" href="javascript:location.reload()">↻ Refresh</a>
</div>
<h2>Live Provider Connectivity</h2><table><thead><tr><th>Provider</th><th>Status</th><th>Latency</th><th>URL</th></tr></thead><tbody>${provRows}</tbody></table>
<h2>Self-Healing Engine Health</h2><table><thead><tr><th>Provider ID</th><th>Status</th><th>✓</th><th>✗</th><th>Avg</th></tr></thead><tbody>${phRows}</tbody></table>
<h2>Recent Stream Requests</h2><table><thead><tr><th>When</th><th>Content</th><th>Provider</th><th>Latency</th><th></th></tr></thead><tbody>${reqRows}</tbody></table>
</body></html>`);
});

// ─── /proxy/subtitle — VTT Subtitle Proxy ─────────────────────────────────
// yt-dlp subtitle URLs (googlevideo.com) are blocked by browser CORS policy
// when used directly in <track src="...">. We proxy them here so the browser
// receives the content from our domain with proper Access-Control-Allow-Origin.
app.get('/proxy/subtitle', async (req, res) => {
    const raw = req.query.url;
    if (!raw || typeof raw !== 'string') {
        return res.status(400).send('Missing ?url= parameter');
    }
    let targetUrl;
    try {
        targetUrl = decodeURIComponent(raw);
        new URL(targetUrl); // validate
    } catch {
        return res.status(400).send('Invalid URL');
    }
    // Only allow subtitle CDN hosts — security guard
    const allowed = ['googlevideo.com', 'youtube.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com'];
    const host = new URL(targetUrl).hostname;
    if (!allowed.some(d => host.endsWith(d))) {
        return res.status(403).send('Host not allowed');
    }
    try {
        const upstream = await gigaAxios.get(targetUrl, {
            responseType: 'text',
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; PStreamProxy/2.0)',
                'Accept': 'text/vtt,text/*,*/*',
            },
        });
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.send(upstream.data);
    } catch (e) {
        return res.status(502).send(`Subtitle fetch failed: ${e.message}`);
    }
});

// ─── /api/media-probe — Server-side MKV/MP4 Header Probe ──────────────────
// The browser cannot fetch Debrid CDN URLs directly due to CORS. This endpoint
// fetches the first 2MB of the file from the server side (no CORS restriction)
// and returns the raw bytes to the frontend for EBML/MP4 track extraction.
app.get('/api/media-probe', async (req, res) => {
    const raw = req.query.url;
    if (!raw || typeof raw !== 'string') {
        return res.status(400).json({ error: 'Missing ?url= parameter' });
    }
    let targetUrl;
    try {
        targetUrl = decodeURIComponent(raw);
        new URL(targetUrl); // validate
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
        const upstream = await gigaAxios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
                'Range': 'bytes=0-2097151', // First 2MB — enough to read MKV/MP4 headers
                'User-Agent': getRandomUA(),
                'Accept': '*/*',
            },
            maxContentLength: 2 * 1024 * 1024, // Hard cap at 2MB
        });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(Buffer.from(upstream.data));
    } catch (e) {
        const status = e.response?.status || 502;
        return res.status(status).json({ error: `Probe failed: ${e.message}` });
    }
});

// --- GIGA PROXY ---

// 1. Full Proxy Manifest Rewriter (Intercepts /proxy/stream)
// Proxies BOTH .m3u8 and .ts segments to solve CORS and mask the browser.
// Uses identical IP as the scraper (native HF) to satisfy VidLink IP-Locking.
function rewriteFullProxyManifest(text, baseUrl, reqProtocol, reqHost, activeReferer) {
    const lines = text.split(/\r?\n/);
    const origin = (() => { try { return new URL(activeReferer).origin; } catch(_) { return ''; } })();
    const headers = JSON.stringify({ referer: activeReferer, origin });
    const headersParam = `&headers=${encodeURIComponent(headers)}`;

    return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        
        if (trimmed.startsWith('#')) {
            // Target sub-playlists in URI= tags
            if (/URI=/i.test(trimmed)) {
                return trimmed.replace(/URI=(['"]?)(.*?)\1/i, (match, quote, p2) => {
                    let absoluteUrl = p2;
                    try { absoluteUrl = new URL(p2, baseUrl).href; } catch (e) { return match; }
                    
                    const isSubManifest = /[.\/]m3u8/i.test(absoluteUrl) || /manifest/i.test(absoluteUrl) || /m3u/i.test(absoluteUrl);
                    const proxyPath = isSubManifest ? '/proxy/stream' : '/proxy/stream'; // Unify
                    return `URI=${quote}${reqProtocol}://${reqHost}${proxyPath}?url=${encodeURIComponent(absoluteUrl)}${headersParam}${quote}`;
                });
            }
            return trimmed;
        }
        
        let absoluteUrl = trimmed;
        try { absoluteUrl = new URL(trimmed, baseUrl).href; } catch (e) { return trimmed; }
        
        // Wrap EVERYTHING in our proxy back-channel to avoid CORS and hide the browser Origin
        return `${reqProtocol}://${reqHost}/proxy/stream?url=${encodeURIComponent(absoluteUrl)}${headersParam}`;
    }).join('\n');
}


// --- GIGA PROXY ---

// Safely parse headers for spoofing
function extractSpoofedHeaders(req, targetUrl, defaultReferer) {
    const rawReqUrl = req.originalUrl || req.url;
    const mainSearchParams = new URL(rawReqUrl, `http://${req.get('host')}`).searchParams;
    let customHeaders = {};

    const headersParam = mainSearchParams.get('headers') || req.query.headers;
    if (headersParam) {
        try { customHeaders = JSON.parse(headersParam); } catch (e) {}
    }

    try {
        const nested = new URL(targetUrl).searchParams.get('headers');
        if (nested) {
            const parsed = JSON.parse(nested);
            customHeaders = { ...customHeaders, ...parsed };
        }
    } catch (e) {}

    const referer = customHeaders.referer || mainSearchParams.get('referer') || defaultReferer;
    const origin = customHeaders.origin || (referer ? new URL(referer).origin : '');

    return {
        "User-Agent": getRandomUA(),
        "Referer": referer,
        "Origin": origin,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "Connection": "keep-alive"
    };
}



// 1. Unified Full Proxy Route (Proxies EVERYTHING natively with matched IPs)
app.get('/proxy/stream', async (req, res) => {
    try {
        const urlStr = req.query.url;
        if (!urlStr) return res.status(400).send('No URL provided');

        // Safe bounded URL decode (max 5 iterations, no infinite loop)
        let targetUrl = String(urlStr);
        for (let i = 0; i < 5; i++) {
            try {
                const decoded = decodeURIComponent(targetUrl);
                if (decoded === targetUrl) break;
                targetUrl = decoded;
            } catch(e) { break; }
        }
        // Patch persistent NGINX double-encoding traps
        targetUrl = targetUrl.replace(/%252F/g, '/').replace(/%2F/gi, '/').replace(/%253D/g, '=').replace(/%3D/gi, '=');


        // Fast-fail: CDN domains that block HF datacenter IPs — these return 403 from our proxy
        // nicheauthorityengine.site / brightpathsignals.com = VaPlayer CDNs (confirmed 403 in prod logs 2026-04-24)
        // VaPlayer rotates disposable CDN domains — all block HF datacenter IPs.
        // Add each new domain here as they rotate so the proxy fast-fails
        // (returning CDN_BLOCK) rather than waiting for a 403 upstream.
        const CDN_BLOCKLIST = [
            // VaPlayer/VidZee/VidSrc domains that previously blocked HF IPs.
            // Now proxied via ScraperAPI (residential proxy rotation).
        ];
        try {
            const targetHost = new URL(targetUrl).hostname;
            if (CDN_BLOCKLIST.some(blocked => targetHost.endsWith(blocked))) {
                console.warn(`[Proxy] Fast-fail: CDN block on ${targetHost}`);
                return res.status(403).json({ error: 'CDN_BLOCK', message: 'CDN blocks datacenter IPs — use noProxy=true' });
            }
        } catch (_) {}
        // Detect M3U8 by URL pattern — includes /playlist/ (VixSrc), .m3u8, /manifest, etc.
        const isM3U8 = /\.m3u8/i.test(targetUrl)
            || /\/manifest/i.test(targetUrl)
            || /\/playlist\//i.test(targetUrl)   // VixSrc: /playlist/{id}?token=...
            || /\/master\b/i.test(targetUrl)      // /master.m3u8 variants
            || /m3u/i.test(targetUrl);
        const fetchHeaders = extractSpoofedHeaders(req, targetUrl, targetUrl);
        const clientRange = req.headers['range'] || req.headers['Range'];
        if (clientRange) {
            fetchHeaders['Range'] = clientRange;
        }

        let finalFetchUrl = '';
        let edgeBasePath = '';

        // --- SNIPER: ZERO-PROXY EDGE BYPASS (Improved Selective Parsing) ---
        const hostParam = targetUrl.match(/[?&]host=([^&]+)/);
        if (hostParam && targetUrl.includes('storm.vodvidl.site')) {
            const edgeHost = decodeURIComponent(hostParam[1]);
            
            // Capture full path including query params (important for IP-signed tokens!)
            // We only want to strip our own helper params (host and headers)
            let rawPath = targetUrl.split('?')[0].replace(/.*\/proxy\//, '/'); 
            let queryParams = targetUrl.split('?')[1] || '';
            
            // Clean out the 'host=' and 'headers=' from the query string
            queryParams = queryParams.split('&')
                .filter(p => !p.startsWith('host=') && !p.startsWith('headers='))
                .join('&');
            
            finalFetchUrl = `${edgeHost}${rawPath}${queryParams ? `?${queryParams}` : ''}`;
            
            // Create the base path for relative fragments
            const pathParts = rawPath.split('/');
            pathParts.pop(); 
            edgeBasePath = `${edgeHost}${pathParts.join('/')}/`;
            
            console.log(`[Sniper] Targeting Media Edge Directly: ${edgeHost}`);
        } else {
            // Standard fetch safely encoded
            try {
                finalFetchUrl = new URL(targetUrl).href;
            } catch(e) {
                finalFetchUrl = encodeURI(targetUrl);
            }
        }

        // Manifests → text (so URLs inside can be rewritten).
        // ALL other requests (video/audio segments, even extensionless CDN URLs) → stream.
        // IMPORTANT: Never fetch binary segments as 'text' — it corrupts binary data.
        // The isM3U8 regex already covers /playlist/ (VixSrc) and all known manifest shapes.
        
        // Use proxyAxios (ScraperAPI) for known blocked domains, even for segments.
        // VaPlayer rotates CDN domains — ALL of these block HF datacenter IPs directly.
        const blockedPatterns = [
            // VaPlayer CDN rotation domains (confirmed blocking HF IPs)
            'contentmonetizationlab.site', 'smartmarketingacademy.site',
            'personalbrandgrowth.site', 'wealthcreationmethod.site',
            'neonhorizonworkshops.com', 'wanderlynest.com', 'orchidpixelgardens.com',
            'brightpathsignals.com', 'cloudnestra.com',
            // Other known blocked providers
            'vidzee', 'vsembed', 'vidsrc'
        ];
        const isBlockedDomain = blockedPatterns.some(p => targetUrl.includes(p) || (fetchHeaders.Referer || '').includes(p));
        
        const activeAxios = (isM3U8 || isBlockedDomain) ? proxyAxios : gigaAxios;
        const responseType = isM3U8 ? 'text' : 'stream';

        const activeAxiosOptions = {
            headers: fetchHeaders,
            responseType,
            timeout: isM3U8 ? 20000 : 45000,
        };

        let response;
        try {
            response = await activeAxios.get(finalFetchUrl, activeAxiosOptions);
        } catch (proxyErr) {
            // Failover: 407 (Auth), 403 (Forbidden/Blocked), ECONNREFUSED (Dead Proxy), or 5xx (Server/Proxy Errors)
            const status = proxyErr.response?.status;
            if (status === 407 || status === 403 || status === 429 || status >= 500 || proxyErr.code === 'ECONNREFUSED' || (proxyErr.message || '').includes('407')) {
                console.warn(`[Proxy Failover] Proxy rejected/failed (${status || proxyErr.code}). Retrying direct...`);
                try {
                    response = await gigaAxios.get(finalFetchUrl, { ...activeAxiosOptions, httpsAgent: undefined });
                } catch (directErr) {
                    throw directErr;
                }
            } else {
                throw proxyErr;
            }
        }

        // Handle 4xx from upstream (not from proxy — proxy errors would throw above)
        if (response.status >= 400) {
            let upstreamHost = 'unknown';
            try { upstreamHost = new URL(finalFetchUrl).hostname; } catch(e) {}
            console.error(`[Upstream Rejected] ${response.status} from ${upstreamHost}`);
            return res.status(response.status).json({ 
                error: `Upstream Rejected`, 
                status: response.status, 
                target: finalFetchUrl.substring(0, 80) 
            });
        }

        const hostMatch = targetUrl.match(/[?&]host=([^&]+)/);
        return handleResponse(response, targetUrl, isM3U8, (hostMatch ? decodeURIComponent(hostMatch[1]) : null), fetchHeaders, res, edgeBasePath, req);

    } catch (e) {
        const status = e.response?.status || 500;
        const msg = e.response?.data?.message || e.message;
        console.error(`[Sniper Fatal] ${status} - ${msg}`);
        res.status(status).json({
            success: false,
            error: msg,
            stack: e.stack,
            message: "Sniper reported an upstream failure. This provider might be temporarily blocked or down."
        });
    }
});

// Helper to handle the manifest/segment response logic
function handleResponse(response, targetUrl, isM3U8, edgeHost, fetchHeaders, res, edgeBasePath = '', req = null) {
    // Secondary M3U8 detection via Content-Type.
    // This only activates when isM3U8=true (response.data is text).
    // When isM3U8=false, response.data is a binary stream — don't inspect it.
    const contentType = response.headers?.['content-type'] || '';
    const isActuallyM3U8 = isM3U8
        || (typeof response.data === 'string' && (
            /mpegurl/i.test(contentType)
            || /m3u8/i.test(contentType)
            || response.data.trimStart().startsWith('#EXTM3U')
        ));

    if (isActuallyM3U8) {
        let manifestContent = response.data;
        const currentUrl = new URL(targetUrl);
        const baseUrl = currentUrl.origin + currentUrl.pathname.substring(0, currentUrl.pathname.lastIndexOf('/') + 1);

        // --- NEW: ROBUST MANIFEST REWRITER ---
        const reqProto = (req?.headers?.['x-forwarded-proto']) || 'https';
        const reqHost = req?.get?.('host') || 'ibrahimar397-pstream-giga.hf.space';
        const rewritten = manifestContent.replace(/^(?!#)(\S+)/gm, (match) => {
            let absoluteUrl;
            try {
                if (match.startsWith('http')) {
                    absoluteUrl = match;
                } else if (match.startsWith('/')) {
                    absoluteUrl = currentUrl.origin + match;
                } else {
                    absoluteUrl = baseUrl + match;
                }

                // Rewrite to correct /proxy/stream?url=... route
                const headersParam = encodeURIComponent(JSON.stringify(fetchHeaders));
                return `${reqProto}://${reqHost}/proxy/stream?url=${encodeURIComponent(absoluteUrl)}&headers=${headersParam}`;
            } catch (e) {
                return match;
            }
        });

        // Also handle #EXT-X-KEY (encryption keys) which are often missed by simple line replacement
        const finalRewritten = rewritten.replace(/URI="(?!data:)([^"]+)"/g, (match, uri) => {
            try {
                let absoluteUri;
                if (uri.startsWith('http')) {
                    absoluteUri = uri;
                } else if (uri.startsWith('/')) {
                    absoluteUri = currentUrl.origin + uri;
                } else {
                    absoluteUri = baseUrl + uri;
                }
                const headersParam = encodeURIComponent(JSON.stringify(fetchHeaders));
                return `URI="/proxy/stream?url=${encodeURIComponent(absoluteUri)}&headers=${headersParam}"`;
            } catch (e) {
                return match;
            }
        });

        // ── ENGLISH AUDIO FILTER ──────────────────────────────────────────────
        // For master manifests (contain EXT-X-STREAM-INF), strip non-English
        // EXT-X-MEDIA audio entries so HLS.js only sees the English track.
        // This stops VixSrc (and similar providers) from defaulting to Italian/Spanish.
        const isMasterManifest = finalRewritten.includes('#EXT-X-STREAM-INF');
        let filteredManifest = finalRewritten;

        if (isMasterManifest) {
            const lines = finalRewritten.split('\n');
            const outputLines = [];

            // Collect all audio language codes that exist
            const audioLangCodes = [];
            for (const line of lines) {
                if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
                    const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
                    if (langMatch) audioLangCodes.push(langMatch[1].toLowerCase());
                }
            }

            // Determine which languages to keep — prefer English, fall back to all
            const hasEnglish = audioLangCodes.some(l => l.startsWith('en'));
            const allowedLangs = hasEnglish
                ? audioLangCodes.filter(l => l.startsWith('en'))
                : audioLangCodes; // no English found → keep all

            let skipNextUri = false;
            for (const line of lines) {
                const trimmed = line.trim();

                // EXT-X-MEDIA audio line — check LANGUAGE attribute
                if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('TYPE=AUDIO')) {
                    const langMatch = trimmed.match(/LANGUAGE="([^"]+)"/i);
                    const lang = langMatch ? langMatch[1].toLowerCase() : 'en';
                    if (!allowedLangs.some(al => lang.startsWith(al))) {
                        // Drop non-English audio group — also need to fix AUDIO= refs in EXT-X-STREAM-INF
                        continue;
                    }
                }

                outputLines.push(line);
            }

            filteredManifest = outputLines.join('\n');

            if (hasEnglish) {
                console.log(`[Manifest] Filtered audio tracks to English only. Dropped: ${audioLangCodes.filter(l => !l.startsWith('en')).join(', ')}`);
            }
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(filteredManifest);
    } else {
        // Binary segment stream (responseType was 'stream') or fallback text
        res.status(response.status || 200);
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        if (response.headers['content-range']) {
            res.setHeader('Content-Range', response.headers['content-range']);
        }
        if (response.headers['accept-ranges']) {
            res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
        }
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        
        // response.data is a stream when responseType='stream', a string/buffer otherwise
        if (response.data && typeof response.data.pipe === 'function') {
            return response.data.pipe(res);
        } else {
            return res.send(response.data);
        }
    }
}


// Legacy routes for temporary backward compatibility
app.get('/proxy/m3u8', (req, res) => res.redirect(301, `/proxy/stream?${new URL(req.url, 'http://x').search}`));
app.get('/proxy/video', (req, res) => res.redirect(301, `/proxy/stream?${new URL(req.url, 'http://x').search}`));
app.get('/proxy/subtitles/opensubtitles', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'No URL provided' });
    try {
        const response = await gigaAxios.get(url, {
            headers: {
                'X-User-Agent': req.headers['x-user-agent'] || 'VLSub 0.10.2',
                'User-Agent': getRandomUA(),
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        res.json(response.data);
    } catch (e) {
        console.warn(`[OpenSubtitles Proxy] ${e.response?.status || e.message}`);
        res.json([]); // Return empty array so frontend doesn't break
    }
});

// --- INTRO & SUBTITLE PROXIES ---
// IntroDB 403 fix: the public API now requires an Origin header to match their CORS policy.
// We forward as if coming from the browser.
app.get('/api/introdb/media', async (req, res) => {
    const { tmdb_id, season, episode } = req.query;
    try {
        const url = `https://api.theintrodb.org/v2/media?tmdb_id=${tmdb_id}${season ? `&season=${season}` : ''}${episode ? `&episode=${episode}` : ''}`;
        const response = await gigaAxios.get(url, {
            headers: {
                'Origin': 'https://pstream.watch',
                'Referer': 'https://pstream.watch/',
                'Accept': 'application/json'
            },
            timeout: 8000
        });
        res.json(response.data);
    } catch (e) {
        console.warn(`[IntroDB Media] ${e.response?.status || e.message} - returning empty`);
        res.json({ segments: [] }); // Return empty instead of 500 so frontend doesn't crash
    }
});

app.get('/api/introdb/subtitles', async (req, res) => {
    const { tmdb_id, type, season, episode } = req.query;
    try {
        const introUrl = `https://api.theintrodb.org/api/subtitles?tmdb_id=${tmdb_id}&type=${type}${season ? `&season=${season}` : ''}${episode ? `&episode=${episode}` : ''}`;
        
        const [introRes, vdrkSubs] = await Promise.all([
            gigaAxios.get(introUrl, {
                headers: { 'Origin': 'https://pstream.watch', 'Referer': 'https://pstream.watch/', 'Accept': 'application/json' },
                timeout: 8000
            }).catch(() => ({ data: { subtitles: [] } })),
            scrapeVdrkCaptions(tmdb_id, type, season, episode).catch(() => [])
        ]);

        const introSubs = introRes.data?.subtitles || [];
        const combined = [...introSubs];

        // Merge VDRK subs, avoiding duplicates by URL
        for (const sub of vdrkSubs) {
            if (!combined.some(s => s.url === sub.url)) {
                combined.push({
                    url: sub.url,
                    lang: sub.lang || 'en',
                    label: sub.label || 'Unknown',
                    isVdrk: true
                });
            }
        }

        res.json({ subtitles: combined });
    } catch (e) {
        console.warn(`[Subtitle Resolution] ${e.message} - returning empty`);
        res.json({ subtitles: [] });
    }
});



const ytSearchCache = new Map();
const YT_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const YT_SEARCH_EMPTY_TTL_MS = 2 * 60 * 1000;
let ytSearchCircuitOpenUntil = 0;
const YT_SEARCH_CIRCUIT_MS = 60 * 1000;

// YouTube Search Proxy — no API key required fallback for trailer search.
// Returns only video IDs to keep payload small and stable.
app.get('/api/youtube/search', async (req, res) => {
    const rawQ = String(req.query.q || '').trim();
    const maxResultsRaw = Number(req.query.maxResults || 5);
    const maxResults = Math.min(Math.max(maxResultsRaw || 5, 1), 10);

    if (!rawQ) {
        return res.status(400).json({ error: 'q is required', videoIds: [] });
    }

    const cacheKey = `${rawQ}::${maxResults}`;
    const cacheHit = ytSearchCache.get(cacheKey);
    if (cacheHit && cacheHit.expiresAt > Date.now()) {
        return res.json(cacheHit.payload);
    }
    if (Date.now() < ytSearchCircuitOpenUntil) {
        return res.json(putCache({ videoIds: [], source: 'circuit-open' }, 15 * 1000));
    }

    const uniqueIds = (ids) => [...new Set((ids || []).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)))].slice(0, maxResults);
    const putCache = (payload, ttlMs) => {
        ytSearchCache.set(cacheKey, { payload, expiresAt: Date.now() + ttlMs });
        return payload;
    };

    // 1) Primary: scrape official YouTube search HTML from backend network.
    try {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(rawQ)}&sp=EgIQAQ%3D%3D`;
        // Use plain axios transport for YouTube search to avoid proxy/TLS chain
        // instability observed in HF logs for this specific host.
        const ytResp = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUA(),
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml',
                'Referer': 'https://www.youtube.com/',
            },
            timeout: 12000,
            responseType: 'text',
        });

        const html = String(ytResp.data || '');
        const ids = uniqueIds([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]));
        if (ids.length > 0) {
            return res.json(putCache({ videoIds: ids, source: 'youtube-html' }, YT_SEARCH_CACHE_TTL_MS));
        }
    } catch (e) {
        console.warn(`[YouTubeSearch] youtube-html failed: ${e?.response?.status || e.message}`);
    }

    // 2) Secondary: DuckDuckGo HTML results can provide youtube.com/watch links
    // even when direct youtube.com TLS is unstable from this runtime.
    try {
        const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(`${rawQ} official trailer site:youtube.com/watch`)}`;
        const ddgResp = await axios.get(ddgUrl, {
            headers: {
                'User-Agent': getRandomUA(),
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml',
            },
            timeout: 10000,
            responseType: 'text',
        });
        const ddgHtml = String(ddgResp.data || '');
        const ddgIds = uniqueIds([
            ...ddgHtml.matchAll(/[?&]v=([A-Za-z0-9_-]{11})/g),
            ...ddgHtml.matchAll(/youtube\.com\/watch%3Fv%3D([A-Za-z0-9_-]{11})/g),
            ...ddgHtml.matchAll(/youtu\.be\/([A-Za-z0-9_-]{11})/g),
        ].map(m => m[1]));

        if (ddgIds.length > 0) {
            return res.json(putCache({ videoIds: ddgIds, source: 'duckduckgo-html' }, YT_SEARCH_CACHE_TTL_MS));
        }
    } catch (e) {
        console.warn(`[YouTubeSearch] duckduckgo-html failed: ${e?.response?.status || e.message}`);
    }

    // 3) Last resort: Invidious public API instances.
    const invidiousInstances = [
        'https://yewtu.be',
        'https://invidious.privacyredirect.com',
    ];

    for (const instance of invidiousInstances) {
        try {
            const apiUrl = `${instance}/api/v1/search?q=${encodeURIComponent(rawQ)}&type=video&sort=relevance`;
            const invResp = await gigaAxios.get(apiUrl, {
                headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json' },
                timeout: 9000,
            });

            const arr = Array.isArray(invResp.data) ? invResp.data : [];
            const ids = uniqueIds(arr.map(item => item?.videoId).filter(Boolean));
            if (ids.length > 0) {
                return res.json(putCache({ videoIds: ids, source: `invidious:${instance}` }, YT_SEARCH_CACHE_TTL_MS));
            }
        } catch (e) {
            console.warn(`[YouTubeSearch] invidious failed (${instance}): ${e?.response?.status || e.message}`);
        }
    }

    ytSearchCircuitOpenUntil = Date.now() + YT_SEARCH_CIRCUIT_MS;
    return res.json(putCache({ videoIds: [], source: 'none' }, YT_SEARCH_EMPTY_TTL_MS));
});

// --- GIGA API ENDPOINTS ---

function sanitizeNoProxySources(sources = []) {
    // These old patterns once needed force-proxy but are now in the CDN_BLOCKLIST;
    // keeping the array for any future host-level overrides if needed.
    const forceProxyHostPatterns = [
        /creativeentrepreneurhub\.site$/i,
        /digitalassetlaunchpad\.site$/i,
        /startupmomentumengine\.site$/i,
    ];

    return (sources || []).map((source) => {
        if (!source) return source;
        const rawUrl = String(source.url || '');
        let host = '';
        try { host = new URL(rawUrl).hostname; } catch (_) {}

        // NOTE: VaPlayer override (isVaPlayer → noProxy=false) intentionally REMOVED.
        // VaPlayer CDN domains block HF datacenter IPs, so the proxy was causing 403s.
        // noProxy:true (browser-direct) is the correct mode for VaPlayer.
        const hostNeedsProxy = forceProxyHostPatterns.some((p) => p.test(host));
        if (source.noProxy && hostNeedsProxy) {
            return { ...source, noProxy: false };
        }
        return source;
    });
}

// Progress stub — returns empty array so MovieCard doesn't flood the console with 404s
// (Full watch-progress persistence is handled client-side via localStorage)
app.get('/api/profiles/:profileId/progress/:movieId', (req, res) => {
    res.json([]);
});

// --- DIAGNOSE ENDPOINT (per-provider diagnostic report) ---
// GET /api/stream/diagnose?tmdbId=637&type=movie[&season=1&episode=1&title=Maverick&year=2022]
// Runs EVERY provider individually (no short-circuit) — takes up to 25s.
// Returns full per-provider status, failure reasons, source previews.
// Use this to understand exactly which providers are working and why.
app.get('/api/stream/diagnose', async (req, res) => {
    const { tmdbId, type, season = '1', episode = '1', title = '', year = '' } = req.query;
    if (!tmdbId || !type) return res.status(400).json({ error: 'tmdbId and type are required' });
    try {
        console.log(`[Diagnose] Request for ${title || tmdbId} (${type})`);
        const report = await diagnoseProviders(tmdbId, type, season, episode, title, year);
        return res.json({ success: true, ...report });
    } catch (e) {
        console.error(`[Diagnose] Fatal error: ${e.message}`);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/stream', async (req, res) => {
    const { tmdbId, type, season, episode, imdbId, title, year, force } = req.query;
    if (!tmdbId || !type) return res.status(400).json({ success: false, error: 'tmdbId and type are required' });
    try {
        const reqProto = req.headers['x-forwarded-proto'] || 'https';
        const reqHost  = req.get('host');

        // ── Redis cache check ────────────────────────────────────────────────
        // Cache wrapper allows provider-specific freshness windows:
        // short-lived token providers (VixSrc/VaPlayer) expire quickly,
        // stable providers can keep a longer TTL.
        const STREAM_CACHE_TTL_DEFAULT = 90; // seconds
        const STREAM_CACHE_TTL_TOKENIZED = 15; // seconds
        const redisCacheKey = `stream:${tmdbId}:${type}:${season || 1}:${episode || 1}`;

        // ?force=1 → client has confirmed the cached result is dead (403/410).
        // Delete it from Redis so the fresh resolve doesn't immediately re-serve it.
        if (force && redis) {
            try {
                await redis.del(redisCacheKey);
                console.log(`[Backend Cache] 🗑️ Force-busted Redis key: ${redisCacheKey}`);
            } catch (_) {}
        }

        if (redis && !force) {
            try {
                const cached = await redis.get(redisCacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    const isWrapped = !!parsed?.data && !!parsed?.meta;
                    const streamData = isWrapped ? parsed.data : parsed;
                    const cacheTs = isWrapped ? parsed.meta.ts : 0;
                    const maxAgeSeconds = isWrapped ? (parsed.meta.maxAgeSeconds || STREAM_CACHE_TTL_DEFAULT) : STREAM_CACHE_TTL_DEFAULT;
                    if (cacheTs && ((Date.now() - cacheTs) > (maxAgeSeconds * 1000))) {
                        console.log(`[Backend Cache] ⏳ Stale cache bypass for ${redisCacheKey}`);
                        await redis.del(redisCacheKey);
                    } else {
                    console.log(`[Backend Cache] ✅ Redis HIT for ${redisCacheKey}`);
                    // Still rewrite manifest proxies for this request's host
                    if (streamData?.sources) {
                        streamData.sources = streamData.sources.map(source => {
                            if (!source.cachedManifest) return source;
                            const baseUrl = source.manifestBaseUrl || source.url;
                            const rewritten = rewriteFullProxyManifest(source.cachedManifest, baseUrl, reqProto, reqHost, source.referer || '');
                            return { ...source, directManifest: rewritten, cachedManifest: undefined };
                        });
                    }
                    streamData.sources = sanitizeNoProxySources(streamData.sources || []);
                    return res.json(streamData);
                    }
                }
            } catch (redisErr) {
                console.warn('[Backend Cache] Redis read failed:', redisErr.message);
            }
        }

        const streamData = await resolveStreaming(tmdbId, type, season, episode, title, year);

        // ── Process cachedManifest sources ──────────────────────────────────
        if (streamData?.sources) {
            streamData.sources = streamData.sources.map(source => {
                if (!source.cachedManifest) return source;
                const baseUrl = source.manifestBaseUrl || source.url;
                const rewritten = rewriteFullProxyManifest(source.cachedManifest, baseUrl, reqProto, reqHost, source.referer || '');
                return { ...source, directManifest: rewritten, cachedManifest: undefined };
            });
            streamData.sources = sanitizeNoProxySources(streamData.sources);
        }

        // ── Write to Redis if success ────────────────────────────────────────
        // Only cache if we have real M3U8 sources. Embedding iframes (isEmbed=true)
        // must NOT be cached — they are often session-bound or short-lived URLs.
        // Cache if we have any real non-embed source (M3U8 OR direct MP4/MKV from Vyla)
        const hasRealSources = streamData?.sources?.some(s => !s.isEmbed && (s.isM3U8 || s.url));
        if (redis && streamData?.success && hasRealSources) {
            try {
                const providers = (streamData.sources || []).map(s => `${s.provider || ''}`.toLowerCase());
                // Short TTL for providers with signed/expiring tokens:
                // VaPlayer, VidZee, Vyla/VidZee, Vyla/VixSrc, Cloudflare Workers URLs
                const hasFragileProvider = providers.some(p =>
                    p.includes('vaplayer') || p.includes('vidzee') ||
                    p.includes('vyla/vidzee') || p.includes('vyla/vixsrc')
                ) || (streamData.sources || []).some(s => /workers\.dev/i.test(s.url || ''));
                const ttl = hasFragileProvider ? STREAM_CACHE_TTL_TOKENIZED : STREAM_CACHE_TTL_DEFAULT;
                const cachePayload = {
                    data: streamData,
                    meta: {
                        ts: Date.now(),
                        maxAgeSeconds: ttl,
                        providers: providers.filter(Boolean)
                    }
                };
                await redis.set(redisCacheKey, JSON.stringify(cachePayload), 'EX', ttl);
                console.log(`[Backend Cache] 💾 Cached ${redisCacheKey} for ${ttl}s`);
            } catch (redisErr) {
                console.warn('[Backend Cache] Redis write failed:', redisErr.message);
            }
        }

        res.json(streamData);
    } catch (e) {
        console.error(`[API Stream Error] ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- AUTH SYSTEM (Challenge/Sync) ---

app.get('/api/auth/challenge', async (req, res) => {
    const { publicKey } = req.query;
    if (!publicKey) return res.status(400).json({ error: 'Public key required' });
    // Rate limit: 10 challenges per minute per IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (rateLimit(`challenge:${ip}`, 10, 60000)) {
        return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }
    try {
        const challenge = await createChallenge(publicKey);
        res.json({ challenge });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/verify', async (req, res) => {
    const { publicKey, signature, challenge, displayName, isSignUp } = req.body;
    // Rate limit: 5 verify attempts per minute per IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (rateLimit(`verify:${ip}`, 5, 60000)) {
        return res.status(429).json({ error: 'Too many verification attempts. Please wait a minute.' });
    }
    try {
        const isValid = await verifyChallenge(publicKey, signature, challenge);
        if (isValid) {
            let profile = await getProfile(publicKey);
            if (!profile) {
                if (isSignUp) {
                    // New account: create the profile row with their chosen display_name
                    profile = await updateProfile(publicKey, { display_name: displayName || 'Guest' });
                } else {
                    return res.status(404).json({ error: 'Account not found. Please create an account or check your recovery phrase.' });
                }
            } else if (isSignUp && displayName) {
                // Returning to a pre-existing account via signup flow — still update the name
                profile = await updateProfile(publicKey, { display_name: displayName });
            }
            const token = jwt.sign({ publicKey }, JWT_SECRET, { expiresIn: '30d' });
            res.json({ success: true, token, profile });
        } else {
            res.status(401).json({ error: 'Signature verification failed' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

app.get('/api/sync', authenticateToken, async (req, res) => {
    try { res.json(await getProfile(req.user.publicKey)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync', authenticateToken, async (req, res) => {
    try { 
        res.json({ success: true, profile: await updateProfile(req.user.publicKey, req.body.updates) }); 
    } catch (e) { 
        console.error('[Sync] Error:', e.message);
        res.status(500).json({ error: `Sync failed: ${e.message}` }); 
    }
});

app.delete('/api/sync', authenticateToken, async (req, res) => {
    try { await deleteProfile(req.user.publicKey); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Provider Health Reporting (self-healing error loop) ───────────────────────
// Frontend calls this when HLS.js fires a fatal error on a stream
app.post('/api/stream/report-error', async (req, res) => {
    try {
        const { provider, providerId, tmdbId, type, season, episode, error, errorCode } = req.body;
        const normalizedProvider = canonicalProviderId(providerId || provider);
        if (!normalizedProvider) return res.status(400).json({ error: 'Missing provider' });
        await recordProviderError(normalizedProvider, { tmdbId, type, error, errorCode });
        if (redis && tmdbId && type) {
            const key = `stream:${tmdbId}:${type}:${season || 1}:${episode || 1}`;
            try {
                await redis.del(key);
                console.log(`[HealthReport] Cache cleared: ${key}`);
            } catch (_) {}
        }
        console.log(`[HealthReport] Error reported for ${normalizedProvider}: ${error || errorCode}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false }); // Non-critical, always return 200-ish
    }
});

// Frontend calls this when a stream plays successfully (positive signal)
app.post('/api/stream/report-success', async (req, res) => {
    try {
        const { provider, providerId } = req.body;
        const normalizedProvider = canonicalProviderId(providerId || provider);
        if (normalizedProvider) await recordProviderSuccess(normalizedProvider);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// Admin: view all provider health scores
app.get('/api/providers/health', async (req, res) => {
    try {
        const health = await getAllProviderHealth();
        res.json({ success: true, providers: health, ts: Date.now() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── TORRENTIO PROXY ───────────────────────────────────────────────────────────
//
// GET /api/torrent/sources?imdbId=tt1375666&type=movie
// GET /api/torrent/sources?imdbId=tt0903747&type=series&season=1&episode=1
//
// Proxies Torrentio (the open-source Stremio addon) to get magnet links for
// any IMDB ID. Used by the frontend as a last-resort stream source after all
// regular providers have failed (and only for authenticated users).
//
// Torrentio scans real-time availability from YTS, RARBG, 1337x etc.
// It returns info_hash (not full magnets) + metadata for quality/seeder count.
//
// IMPORTANT: This route only returns metadata (magnets/infoHashes).
// Actual video streaming happens via /api/torrent/stream (WebTorrent server-side)
// which is intentionally NOT implemented here yet — it carries HF bandwidth risk.
// For now, the frontend can use the magnet links with a client-side player
// or we can implement server-side streaming separately on a dedicated HF space.
//
// Rate limited: 30 req/min per IP (Torrentio has generous limits but we respect them)

app.get('/api/torrent/sources', async (req, res) => {
    const { imdbId, type = 'movie', season, episode, title, tmdbId, nocache } = req.query;

    if (!imdbId && !title) return res.status(400).json({ error: 'imdbId or title required' });

    try {
        const bypassRedis = nocache === 'true' ? null : redis;
        const [sources, subtitles] = await Promise.all([
            getTorrentSources(imdbId, type, season, episode, title, bypassRedis),
            (tmdbId || imdbId) ? scrapeVdrkCaptions(tmdbId || imdbId, type, season, episode).catch(() => []) : Promise.resolve([])
        ]);
        res.json({ streams: sources, subtitles });
    } catch (e) {
        console.error('[TorrentSources] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── TORRENT STREAM ────────────────────────────────────────────────────────────
//
// POST /api/torrent/stream
// Body: { imdbId, type, season?, episode?, magnetOverride? }
//
// Login-gated last-resort streaming pipeline:
//   1. Look up best magnet from Torrentio (Redis-cached 24h)
//   2. Add magnet to server-side WebTorrent instance pool
//   3. Stream the video file back to client with Range support
//
// The frontend calls this only after 2 failed attempts with regular providers.
// Continuous range requests from the video player keep the HF Space awake.

app.post('/api/torrent/stream', async (req, res) => {
    const { imdbId, type = 'movie', season, episode, magnetOverride, fileIdx, title } = req.body || {};

    if (!imdbId && !magnetOverride && !title) {
        return res.status(400).json({ error: 'imdbId, magnetOverride or title is required' });
    }

    try {
        let magnetUri = magnetOverride || null;
        let resolvedFileIdx = fileIdx != null ? parseInt(fileIdx) : null;

        // Fetch global Debrid Key
        const debridKey = process.env.ALLDEBRID_API_KEY;

        // If no magnetOverride given, fetch from various sources
        if (!magnetUri) {
            const sources = await getTorrentSources(imdbId, type, season, episode, title, redis);
            if (!sources.length) {
                return res.status(404).json({ error: 'No torrent sources found for this title' });
            }
            const best      = sources[0]; // already sorted: best quality + seeders
            magnetUri       = best.magnet;
            resolvedFileIdx = best.fileIdx != null ? best.fileIdx : null;
            console.log(`[TorrentStream] Best: ${best.quality} @ ${best.seeders} seeders — ${best.name}`);
        }

        if (!magnetUri) {
            return res.status(500).json({ error: 'Could not resolve magnet link' });
        }

        // --- DEBRID PIPELINE ---
        if (debridKey) {
            console.log(`[TorrentStream] User has Debrid. Attempting AllDebrid resolution...`);
            const debrid = new AllDebrid(debridKey);
            try {
                const resolved = await debrid.resolveMagnet(magnetUri, resolvedFileIdx);
                if (resolved.url) {
                    console.log(`[TorrentStream] AllDebrid SUCCESS: ${resolved.url.substring(0, 50)}...`);
                    // Return the direct link to the frontend
                    return res.json({ 
                        success: true, 
                        url: resolved.url, 
                        filename: resolved.filename,
                        filesize: resolved.filesize,
                        isDebrid: true 
                    });
                } else if (resolved.id) {
                    console.log(`[TorrentStream] AllDebrid: Magnet added but not ready (ID: ${resolved.id})`);
                    return res.json({
                        success: true,
                        isDebrid: true,
                        ready: false,
                        id: resolved.id,
                        status: 'downloading'
                    });
                }
            } catch (debridErr) {
                console.error(`[TorrentStream] AllDebrid Error: ${debridErr.message}. Falling back to WebTorrent.`);
            }
        }

        // --- WEBTORRENT FALLBACK ---
        // Set CORS headers explicitly (range requests need this)
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

        await streamTorrent(magnetUri, resolvedFileIdx, req, res);

    } catch (e) {
        console.error(`[TorrentStream] Error: ${e.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Torrent stream failed: ${e.message}` });
        }
    }
});

// OPTIONS preflight for torrent stream (browser sends this before POST/GET with Range)
app.options('/api/torrent/stream', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.sendStatus(204);
});

// GET /api/torrent/stream — streams a torrent file as HTTP with Range support.
// No auth required — AllDebrid key is global (backend .env), not per-user.
// infoHash is the fastest path — no Torrentio lookup needed.
app.get('/api/torrent/stream', async (req, res) => {
    const { infoHash, imdbId, type = 'movie', season, episode, fileIdx, title } = req.query;

    if (!infoHash && !imdbId) {
        return res.status(400).json({ error: 'infoHash or imdbId required' });
    }

    try {
        let magnetUri = null;
        let resolvedFileIdx = fileIdx != null ? parseInt(fileIdx) : null;

        // Use global Debrid Key
        const debridKey = process.env.ALLDEBRID_API_KEY;

        if (infoHash) {
            // Fast path: build magnet directly from infoHash (no external lookup needed)
            const trackers = [
                'udp://open.demonii.com:1337',
                'udp://tracker.openbittorrent.com:80',
                'udp://tracker.coppersurfer.tk:6969',
                'udp://glotorrents.pw:6969',
                'udp://tracker.opentrackr.org:1337',
                'udp://torrent.gresille.org:80',
            ].map(t => `tr=${encodeURIComponent(t)}`).join('&');
            magnetUri = `magnet:?xt=urn:btih:${infoHash}&${trackers}`;
        } else {
            // Slow path: fetch from Torrentio
            const sources = await getTorrentSources(imdbId, type, season, episode, title, redis);
            if (!sources.length) return res.status(404).json({ error: 'No torrent sources found' });
            const best = sources[0];
            magnetUri = best.magnet;
            resolvedFileIdx = best.fileIdx ?? 0;
        }

        // --- ALLDEBRID ONLY — no WebTorrent fallback ---
        if (!debridKey) {
            return res.status(503).json({ error: 'AllDebrid not configured on server' });
        }

        const debrid = new AllDebrid(debridKey);
        const resolved = await debrid.resolveMagnet(magnetUri, resolvedFileIdx);

        if (!resolved?.url) {
            console.warn(`[TorrentStream GET] AllDebrid: magnet not cached yet (id=${resolved?.id})`);
            return res.status(503).json({ error: 'AllDebrid: magnet not ready. Try again in a moment.' });
        }

        console.log(`[TorrentStream GET] ✅ AllDebrid SUCCESS → ${resolved.url.substring(0, 60)}...`);
        return res.redirect(resolved.url);

    } catch (e) {
        console.error(`[TorrentStream GET] Error: ${e.message}`);
        if (!res.headersSent) res.status(503).json({ error: `AllDebrid failed: ${e.message}` });
    }
});




// ── KEEP-ALIVE PING ───────────────────────────────────────────────────────────
// Frontend pings this every 30s when user is idle to prevent HF Space sleep.
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── TORRENT POOL STATUS ───────────────────────────────────────────────────────
// Auth-gated diagnostic endpoint: shows active torrent count, file info, RAM.
// GET /api/torrent/status
app.get('/api/torrent/status', authenticateToken, (req, res) => {
    const mem = process.memoryUsage();
    const torrents = [];
    for (const [hash, entry] of torrentPool.entries()) {
        torrents.push({
            infoHash:    hash,
            name:        entry.torrent?.name || 'unknown',
            streamCount: entry.streamCount,
            idleSecs:    Math.round((Date.now() - entry.lastActive) / 1000),
            sizeMB:      entry.torrent?.length ? +(entry.torrent.length / 1e6).toFixed(1) : null,
            progress:    entry.torrent?.progress != null ? +(entry.torrent.progress * 100).toFixed(1) : null,
            speedKBs:    entry.torrent?.downloadSpeed ? +(entry.torrent.downloadSpeed / 1e3).toFixed(1) : null,
            peers:       entry.torrent?.numPeers ?? null,
        });
    }
    res.json({
        active:   torrents.length,
        maxPool:  60,
        torrents,
        memory: {
            heapMB: +(mem.heapUsed / 1e6).toFixed(1),
            rssMB:  +(mem.rss / 1e6).toFixed(1),
        },
    });
});


// ── /trailer/resolve ─────────────────────────────────────────────────────────
// Given a movie title + year, searches YouTube via yt-dlp (4K first, official
// trailer fallback) and returns the best matching video ID.
// Stream delivery is the frontend's job (Piped CDN) — we only resolve the ID.
app.get('/trailer/resolve', async (req, res) => {
    const { title, year, type = 'movie', tmdbIds } = req.query;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const ids = tmdbIds ? String(tmdbIds).split(',').filter(Boolean) : [];
    try {
        const result = await resolveTrailerId(
            String(title), String(year || ''), String(type), ids
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/trailer/cache', (_req, res) => res.json(getTrailerCacheStats()));

// ── /trailer/stream ───────────────────────────────────────────────────────────
// Proxies the Piped /streams/{videoId} call server-side.
// The Piped API blocks CORS for arbitrary browser origins — calling from
// the backend has no such restriction. The returned DASH/HLS URLs point to
// pipedproxy CDN which DOES have open CORS (Piped's own web app needs it).
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.projectsegfau.lt',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.in.projectsegfau.lt',
    'https://api.piped.privacydev.net',
];

const _pipedStreamCache = new Map(); // videoId → { ts, data }
const PIPED_CACHE_TTL   = 20 * 60 * 1000; // 20 min (DASH URLs expire ~30 min)

app.get('/trailer/stream', async (req, res) => {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    // Cache check
    const hit = _pipedStreamCache.get(videoId);
    if (hit && Date.now() - hit.ts < PIPED_CACHE_TTL) {
        return res.json(hit.data);
    }

    let lastErr = null;
    for (const base of PIPED_INSTANCES) {
        try {
            const response = await gigaAxios.get(`${base}/streams/${videoId}`, {
                timeout: 10000,
                headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
            });
            const data = response.data;

            // Piped DASH manifest — set for all regular (non-livestream) videos
            const dash = data.dash || null;
            // Piped HLS manifest — set only for livestreams
            const hls  = data.hls  || null;

            if (!dash && !hls) {
                lastErr = new Error('Piped returned no playable manifest');
                continue;
            }

            // Subtitle — prefer English VTT
            const subtitles = Array.isArray(data.subtitles) ? data.subtitles : [];
            const sub = subtitles.find(s =>
                (s.code === 'en' || s.code === 'en-US') &&
                (s.mimeType === 'text/vtt' || s.mimeType === 'application/ttml+xml')
            );

            const result = {
                streamUrl:  dash || hls,
                isDASH:     !!dash,
                isHLS:      !dash && !!hls,
                subtitleUrl: sub?.url || null,
                videoId,
                proxyUrl:   data.proxyUrl || null,
                instance:   base,
            };

            _pipedStreamCache.set(videoId, { ts: Date.now(), data: result });
            return res.json(result);

        } catch (e) {
            lastErr = e;
            console.warn(`[Piped] ${base} failed for ${videoId}: ${e.message}`);
        }
    }

    res.status(502).json({ error: `All Piped instances failed: ${lastErr?.message}` });
});

// ── /trailer/cobalt ───────────────────────────────────────────────────────────
// Cobalt handles YouTube extraction on their servers (no HF IP ban issues).
// Key fix: use a PLAIN axios instance — gigaAxios has browser nav headers
// (Sec-Fetch-Mode:navigate, Accept:text/html) that break JSON API calls.

// _cobaltAxios: clean axios with no browser nav headers (gigaAxios would break JSON API calls)
const _cobaltAxios = axios.create({ timeout: 18000 });


// Cobalt v10 API format — instances in priority order (remove dead ones fast)
const COBALT_INSTANCES = [
    { base: 'https://api.cobalt.tools',           api: '/' },
    { base: 'https://cobalt.api.lostfiles.pro',   api: '/' },
    { base: 'https://cobalt.ggtyler.dev',          api: '/' },
    { base: 'https://cob.janw.xyz',                api: '/' },
    // Older v7/v8 instances (different endpoint + field names)
    { base: 'https://co.wuk.sh',                   api: '/api/json', legacy: true },
];

// Invidious instances for 720p fallback (these proxy streams with CORS)
const INVIDIOUS_INSTANCES = [
    'https://invidious.jing.rocks',
    'https://vid.priv.au',
    'https://invidious.privacyredirect.com',
];

const _cobaltCache = new Map(); // videoId → { ts, url }
const COBALT_CACHE_TTL = 25 * 60 * 1000; // 25 min

async function tryInvidiousFallback(videoId) {
    for (const base of INVIDIOUS_INSTANCES) {
        try {
            const { data } = await _cobaltAxios.get(
                `${base}/api/v1/videos/${videoId}?fields=formatStreams`,
                { headers: { Accept: 'application/json' } }
            );
            // formatStreams = combined video+audio (up to 720p), proxied through Invidious
            const streams = data.formatStreams || [];
            // Prefer 720p, then 480p, then whatever's available
            const best = streams.sort((a, b) =>
                parseInt(b.resolution) - parseInt(a.resolution)
            )[0];
            if (best?.url) {
                console.log(`[Invidious] ✅ ${videoId} → ${best.qualityLabel} via ${base}`);
                return { url: best.url, quality: best.qualityLabel, source: 'invidious' };
            }
        } catch (e) {
            console.warn(`[Invidious] ${base} failed: ${e.message}`);
        }
    }
    return null;
}

app.get('/trailer/cobalt', async (req, res) => {
    const { videoId, quality = '1080' } = req.query;
    if (!videoId || !/^[a-zA-Z0-9_-]{8,15}$/.test(String(videoId))) {
        return res.status(400).json({ error: 'invalid videoId' });
    }

    const vid = String(videoId);

    // Cache check
    const hit = _cobaltCache.get(vid);
    if (hit && Date.now() - hit.ts < COBALT_CACHE_TTL) {
        return res.json({ url: hit.url, cached: true });
    }

    const ytUrl = `https://www.youtube.com/watch?v=${vid}`;
    const videoQuality = ['144','240','360','480','720','1080','1440','2160','max']
        .includes(String(quality)) ? String(quality) : '1080';

    const errors = [];

    // ── Try Cobalt instances ──────────────────────────────────────────────────
    for (const { base, api, legacy } of COBALT_INSTANCES) {
        try {
            const body = legacy
                ? { url: ytUrl, vQuality: videoQuality, vCodec: 'h264', isAudioOnly: false, filenamePattern: 'basic' }
                : { url: ytUrl, videoQuality, downloadMode: 'auto', youtubeVideoCodec: 'h264', filenameStyle: 'basic' };

            const cobaltRes = await _cobaltAxios.post(`${base}${api}`, body, {
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            });

            const d = cobaltRes.data;
            const status = d.status;
            const url    = d.url;

            if ((status === 'tunnel' || status === 'stream' || status === 'redirect') && url) {
                _cobaltCache.set(vid, { ts: Date.now(), url });
                console.log(`[Cobalt] ✅ ${vid} → ${status} (${videoQuality}p) via ${base}`);
                return res.json({ url, status, quality: videoQuality, source: 'cobalt' });
            }

            const errMsg = d?.error?.code || d?.text || `unexpected status: ${status}`;
            errors.push(`${base}: ${errMsg}`);
            console.warn(`[Cobalt] ${base} returned error status: ${errMsg}`);

        } catch (e) {
            const detail = e.response
                ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 120)}`
                : e.message;
            errors.push(`${base}: ${detail}`);
            console.warn(`[Cobalt] ${base} failed: ${detail}`);
        }
    }

    // ── Invidious fallback (720p proxied, reliable CORS) ─────────────────────
    const inv = await tryInvidiousFallback(vid);
    if (inv) {
        _cobaltCache.set(vid, { ts: Date.now(), url: inv.url });
        return res.json({ url: inv.url, quality: inv.quality, source: 'invidious' });
    }

    console.error(`[Cobalt] All sources failed for ${vid}:\n${errors.join('\n')}`);
    res.status(502).json({ error: 'All stream sources failed', detail: errors });
});

// ─── HLS Audio Transcoding Pipeline ────────────────────────────────────────────
// Solves AC3/DTS browser incompatibility for Debrid-sourced MKV files.
//
// Strategy (fastest path wins):
//   1. ffprobe audio tracks → check for native AAC/Opus track
//   2a. AAC/Opus found  → remux only (c:copy). Zero quality loss, ~instant.
//   2b. AC3/DTS only    → transcode to AAC. Copy video stream, no re-encode.
//   3.  Serve HLS segments from /tmp/hls-<sessionId>/
//   4.  Auto-cleanup sessions after 30min inactivity.
//
// The CDN URL is server-IP-locked (AllDebrid resolves it on the server).
// Server can fetch and transcode it freely — the client just receives HLS.

const HLS_SESSIONS = new Map();
const HLS_TEMP_BASE = os.tmpdir();
const HLS_SESSION_TTL = 30 * 60 * 1000; // 30 min

// Auto-cleanup stale sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of HLS_SESSIONS) {
        if (now - s.lastAccess > HLS_SESSION_TTL) {
            try { s.proc?.kill('SIGKILL'); } catch (_) {}
            try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
            HLS_SESSIONS.delete(id);
            console.log(`[HLS] ♻️ Cleaned session ${id}`);
        }
    }
}, 5 * 60 * 1000);

// Probe all audio streams with ffprobe (~200ms, no download)
async function hlsProbeAudio(url) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-select_streams', 'a',
            '-i', url,
        ]);
        let out = '';
        proc.stdout.on('data', d => out += d);
        proc.on('close', () => {
            try { resolve(JSON.parse(out).streams || []); }
            catch { resolve([]); }
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { try { proc.kill(); } catch (_) {} resolve([]); }, 9000);
    });
}

// Pick the best audio track — prefer AAC/Opus (remux), else take first (transcode)
function hlsPickTrack(streams) {
    const SAFE = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
    const safe = streams.find(s => SAFE.some(c => (s.codec_name || '').toLowerCase().startsWith(c)));
    if (safe) return { streamIndex: streams.indexOf(safe), codec: safe.codec_name, transcode: false };
    if (streams[0]) return { streamIndex: 0, codec: streams[0].codec_name, transcode: true };
    return { streamIndex: 0, codec: 'unknown', transcode: true };
}

// ─── POST /api/hls/stream — Start a transcode session ───────────────────────
// Body: { url: string }   (or query ?url=)
// Returns: { manifestUrl, sessionId, audioCodec, outputCodec, remuxed }
app.all('/api/hls/stream', async (req, res) => {
    const raw = req.method === 'POST' ? req.body?.url : req.query.url;
    if (!raw) return res.status(400).json({ error: 'Missing url' });

    let sourceUrl;
    try { sourceUrl = decodeURIComponent(String(raw)); new URL(sourceUrl); }
    catch { return res.status(400).json({ error: 'Invalid URL' }); }

    // Detect Safari → serve AAC; Chrome/FF → still AAC (widest compat for HLS)
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isSafari = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium');
    const outputCodec = isSafari ? 'aac' : 'aac'; // Both AAC — HLS TS containers need AAC for widest support
    const ffmpegAudioCodec = 'aac';

    console.log(`[HLS] 🔍 Probing: ${sourceUrl.substring(0, 70)}...`);
    const streams = await hlsProbeAudio(sourceUrl);
    const track = hlsPickTrack(streams);
    console.log(`[HLS] 🎵 Audio: ${track.codec} (track ${track.streamIndex}) → ${track.transcode ? `transcode→${outputCodec}` : 'remux(copy)'}`);

    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionDir = path.join(HLS_TEMP_BASE, `hls-${sessionId}`);
    const manifestFile = path.join(sessionDir, 'index.m3u8');

    try { fs.mkdirSync(sessionDir, { recursive: true }); }
    catch (e) { return res.status(500).json({ error: 'Failed to create session dir' }); }

    const ffArgs = [
        '-i', sourceUrl,
        '-map', '0:v:0',                               // first video stream, pass-through
        '-map', `0:a:${track.streamIndex}`,             // best audio stream
        '-c:v', 'copy',                                // video: no re-encode
        ...(track.transcode
            ? ['-c:a', ffmpegAudioCodec, '-b:a', '192k', '-ac', '2'] // transcode surround → stereo AAC
            : ['-c:a', 'copy']),                        // already AAC — just remux
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments+delete_segments',
        '-hls_delete_threshold', '3',
        '-hls_segment_filename', path.join(sessionDir, 'seg%05d.ts'),
        manifestFile,
    ];

    const proc = spawn('ffmpeg', ffArgs);
    let ffError = null;

    proc.stderr.on('data', chunk => {
        const msg = chunk.toString();
        if (msg.match(/error|invalid|failed/i)) {
            console.warn(`[FFmpeg ${sessionId.slice(-6)}] ${msg.slice(0, 120).trim()}`);
        }
    });
    proc.on('error', e => { ffError = e.message; console.error(`[HLS] FFmpeg error: ${e.message}`); });
    proc.on('close', code => {
        console.log(`[HLS] Session ${sessionId.slice(-6)} done (exit ${code})`);
        const s = HLS_SESSIONS.get(sessionId);
        if (s) s.proc = null;
    });

    HLS_SESSIONS.set(sessionId, { dir: sessionDir, proc, lastAccess: Date.now() });

    // Wait up to 12s for manifest to appear (first segment write triggers it)
    const ready = await new Promise(resolve => {
        const deadline = Date.now() + 12000;
        const poll = setInterval(() => {
            if (ffError) { clearInterval(poll); return resolve(false); }
            if (fs.existsSync(manifestFile)) { clearInterval(poll); return resolve(true); }
            if (Date.now() > deadline) { clearInterval(poll); return resolve(false); }
        }, 250);
    });

    if (!ready) {
        try { proc.kill('SIGKILL'); } catch (_) {}
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        HLS_SESSIONS.delete(sessionId);
        return res.status(502).json({ error: ffError || 'FFmpeg did not produce a manifest in time', audioCodec: track.codec });
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers.host;
    const manifestUrl = `${proto}://${host}/api/hls/seg/${sessionId}/index.m3u8`;

    console.log(`[HLS] ✅ Session ready: ${manifestUrl}`);
    res.json({
        ok: true,
        sessionId,
        manifestUrl,
        audioCodec: track.codec,
        outputCodec,
        remuxed: !track.transcode,
        tracksFound: streams.length,
    });
});

// ─── GET /api/hls/seg/:sessionId/:file — Serve HLS segments ─────────────────
app.get('/api/hls/seg/:sessionId/:file', (req, res) => {
    const { sessionId, file } = req.params;
    const session = HLS_SESSIONS.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session expired or not found' });

    session.lastAccess = Date.now();

    const safeName = path.basename(file); // prevent path traversal
    const filePath = path.join(session.dir, safeName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Segment not ready' });
    }

    const ext = path.extname(safeName).toLowerCase();
    res.setHeader('Content-Type', ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath);
});

// ─── DELETE /api/hls/session/:sessionId — Manual cleanup ─────────────────────
app.delete('/api/hls/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const s = HLS_SESSIONS.get(sessionId);
    if (s) {
        try { s.proc?.kill('SIGKILL'); } catch (_) {}
        try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
        HLS_SESSIONS.delete(sessionId);
    }
    res.json({ ok: true, sessionId });
});

app.listen(PORT, () => {
    console.log(`[Engine] Online on port ${PORT}`);
});


// Cobalt (https://cobalt.tools) handles YouTube extraction on their servers.
// We call their API from giga backend (no CORS), they return a tunnel URL

