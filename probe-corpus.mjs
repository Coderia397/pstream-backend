/**
 * Provider hit-rate measurement.
 *
 * The single-title probe proves the extractors work. This answers the actual
 * question: of the titles that fail, how many are "genuinely not in either
 * catalogue" (a ceiling only more providers can raise) versus "we have it but
 * our matching or networking lost it" (fixable in this repo)?
 *
 * Run:  node probe-corpus.mjs            # both providers, paced
 *       node probe-corpus.mjs --fast     # no pacing (risks rate-limiting your IP)
 *
 * NOTE: run this from the SAME IP that serves users (the phone) for numbers
 * that reflect production. A dev IP can be rate-limited differently — we've
 * already seen VixSrc fail here and succeed on the phone for the same title.
 */
import { scrapeVixSrc } from './extractors/vixsrc.js';
import { scrapeLookMovie } from './extractors/lookmovie.js';

const FAST = process.argv.includes('--fast');
const PACE_MS = FAST ? 0 : 1500;   // be kind to the providers / your IP

// Deliberately mixed: blockbusters, older, foreign, punctuation-heavy titles
// (which stress LookMovie's exact-match), very recent, and TV.
const CORPUS = [
  { tmdb: 550,     type: 'movie', title: 'Fight Club',                 year: 1999 },
  { tmdb: 27205,   type: 'movie', title: 'Inception',                  year: 2010 },
  { tmdb: 155,     type: 'movie', title: 'The Dark Knight',            year: 2008 },
  { tmdb: 680,     type: 'movie', title: 'Pulp Fiction',               year: 1994 },
  { tmdb: 13,      type: 'movie', title: 'Forrest Gump',               year: 1994 },
  { tmdb: 807,     type: 'movie', title: 'Se7en',                      year: 1995 }, // punctuation/numeral
  { tmdb: 10681,   type: 'movie', title: 'WALL·E',                     year: 2008 }, // interpunct
  { tmdb: 194,     type: 'movie', title: 'Amélie',                     year: 2001 }, // accent
  { tmdb: 496243,  type: 'movie', title: 'Parasite',                   year: 2019 }, // foreign
  { tmdb: 372058,  type: 'movie', title: 'Your Name.',                 year: 2016 }, // trailing period
  { tmdb: 315162,  type: 'movie', title: 'Puss in Boots: The Last Wish', year: 2022 }, // colon
  { tmdb: 693134,  type: 'movie', title: 'Dune: Part Two',             year: 2024 },
  { tmdb: 872585,  type: 'movie', title: 'Oppenheimer',                year: 2023 },
  { tmdb: 1022789, type: 'movie', title: 'Inside Out 2',               year: 2024 },
  { tmdb: 533535,  type: 'movie', title: 'Deadpool & Wolverine',       year: 2024 }, // ampersand
  { tmdb: 762441,  type: 'movie', title: 'A Quiet Place: Day One',     year: 2024 },
  { tmdb: 1241982, type: 'movie', title: 'Moana 2',                    year: 2024 },
  { tmdb: 558449,  type: 'movie', title: 'Gladiator II',               year: 2024 }, // roman numeral
  { tmdb: 402431,  type: 'movie', title: 'Wicked',                     year: 2024 },
  { tmdb: 1184918, type: 'movie', title: 'The Wild Robot',             year: 2024 },
  { tmdb: 1396, s: 1, e: 1, type: 'tv', title: 'Breaking Bad',         year: 2008 },
  { tmdb: 1399, s: 1, e: 1, type: 'tv', title: 'Game of Thrones',      year: 2011 },
  { tmdb: 66732, s: 1, e: 1, type: 'tv', title: 'Stranger Things',     year: 2016 },
  { tmdb: 94605, s: 1, e: 1, type: 'tv', title: 'Arcane',              year: 2021 },
  { tmdb: 87739, s: 1, e: 1, type: 'tv', title: 'The Queen\'s Gambit', year: 2020 }, // apostrophe
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Classify an outcome so failures are actionable, not just counted. */
function classify(res, err, ms) {
  if (err) {
    const m = String(err.message || err);
    if (/timeout|abort|ETIMEDOUT/i.test(m)) return { code: 'TIMEOUT', detail: m.slice(0, 60) };
    if (/ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed/i.test(m)) return { code: 'NETWORK', detail: m.slice(0, 60) };
    return { code: 'THREW', detail: m.slice(0, 60) };
  }
  if (res?.success && res.sources?.length) {
    return { code: 'OK', detail: res.sources[0].quality || '?' };
  }
  return { code: 'MISS', detail: res?.error ? String(res.error).slice(0, 60) : 'no sources' };
}

async function probe(fn, label, item) {
  const t0 = Date.now();
  try {
    const res = await fn();
    const ms = Date.now() - t0;
    return { label, ms, ...classify(res, null, ms) };
  } catch (err) {
    const ms = Date.now() - t0;
    return { label, ms, ...classify(null, err, ms) };
  }
}

const results = [];
console.log(`\n=== PROVIDER HIT-RATE MEASUREMENT (${CORPUS.length} titles) ===`);
console.log(`pacing: ${PACE_MS}ms between titles\n`);

for (const item of CORPUS) {
  const name = `${item.title}${item.type === 'tv' ? ` S${item.s}E${item.e}` : ''}`;
  const [vix, lm] = await Promise.all([
    probe(() => scrapeVixSrc(item.tmdb, item.type, item.s ?? 1, item.e ?? 1), 'vixsrc', item),
    probe(() => scrapeLookMovie(null, item.type, item.s ?? 1, item.e ?? 1, item.title, item.year), 'lookmovie', item),
  ]);
  const anyOk = vix.code === 'OK' || lm.code === 'OK';
  results.push({ name, vix, lm, anyOk });
  console.log(
    `${anyOk ? '✅' : '❌'} ${name.padEnd(32)} ` +
    `vix=${vix.code.padEnd(7)}(${String(vix.ms).padStart(5)}ms)  ` +
    `lm=${lm.code.padEnd(7)}(${String(lm.ms).padStart(5)}ms)` +
    (anyOk ? '' : `   [vix:${vix.detail}] [lm:${lm.detail}]`)
  );
  if (PACE_MS) await sleep(PACE_MS);
}

// ── Summary ──────────────────────────────────────────────────────────────────
const n = results.length;
const served = results.filter(r => r.anyOk).length;
const tally = (label) => {
  const c = {};
  for (const r of results) { const k = r[label].code; c[k] = (c[k] || 0) + 1; }
  return c;
};
const pct = (x) => `${((x / n) * 100).toFixed(0)}%`;

console.log(`\n=== RESULT ===`);
console.log(`  titles served by at least one provider : ${served}/${n}  (${pct(served)})`);
console.log(`  titles served by NEITHER               : ${n - served}/${n}  (${pct(n - served)})`);
console.log(`\n  per-provider outcome counts:`);
console.log(`    vixsrc   `, tally('vix'));
console.log(`    lookmovie`, tally('lm'));

const bothMiss = results.filter(r => !r.anyOk);
if (bothMiss.length) {
  console.log(`\n  --- the failures, and WHY ---`);
  for (const r of bothMiss) {
    console.log(`    ${r.name}`);
    console.log(`       vixsrc:    ${r.vix.code} — ${r.vix.detail}`);
    console.log(`       lookmovie: ${r.lm.code} — ${r.lm.detail}`);
  }
  const transient = bothMiss.filter(r =>
    ['TIMEOUT', 'NETWORK', 'THREW'].includes(r.vix.code) ||
    ['TIMEOUT', 'NETWORK', 'THREW'].includes(r.lm.code)).length;
  console.log(`\n  Of ${bothMiss.length} total failures:`);
  console.log(`    ~${transient} involve a timeout/network/throw  → FIXABLE here (retries, timeouts)`);
  console.log(`    ~${bothMiss.length - transient} are clean MISSes            → catalogue gap, only more providers help`);
}
console.log('');
