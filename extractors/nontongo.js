import axios from 'axios';
import https from 'https';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function scrapeNontonGo(tmdbId, type, season = 1, episode = 1) {
  if (!tmdbId) return { success: false, error: 'TMDB ID is required' };

  console.log(`[NontonGo] Scraping ${type} ${tmdbId}...`);
  const viewUrl = type === 'movie' || type === 'film'
    ? `https://nontongo.win/stream/movie_upcloud/view1.php?id=${tmdbId}&type=movie`
    : `https://nontongo.win/stream/tv_upcloud/view1.php?id=${tmdbId}&s=${season}&e=${episode}`;

  try {
    const res = await axios.get(viewUrl, {
      headers: { ...HEADERS, Referer: 'https://nontongo.win/' },
      httpsAgent: insecureAgent,
      timeout: 8000
    });

    const html = String(res.data);
    const sourcesMatch = html.match(/const\s+sources\s*=\s*(\[[^\]]+\])/i) || html.match(/sources\s*:\s*(\[[^\]]+\])/i);

    if (!sourcesMatch) {
      console.log('[NontonGo] ❌ No sources array found in view page');
      return { success: false, error: 'No sources array found' };
    }

    const rawSources = JSON.parse(sourcesMatch[1]);
    const sources = rawSources.map(s => ({
      url: s.file,
      quality: s.label || 'auto',
      isM3U8: s.file.includes('.m3u8'),
      noProxy: true
    }));

    console.log(`[NontonGo] ✅ Found ${sources.length} direct stream sources! Best: ${sources[sources.length - 1]?.quality || 'auto'}`);

    return {
      success: true,
      provider: 'NontonGo 🍿',
      providerId: 'nontongo',
      sources,
      subtitles: []
    };
  } catch (err) {
    console.log(`[NontonGo] ❌ Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}


