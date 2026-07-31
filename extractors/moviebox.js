import axios from 'axios';
import https from 'https';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function scrapeMovieBox(title, year) {
  if (!title) return { success: false, error: 'Title is required for MovieBox search' };
  
  console.log(`[MovieBox] Searching "${title}" (${year || ''})...`);
  const searchUrl = `https://movieboxonline.net/search-result?keyword=${encodeURIComponent(title)}`;

  try {
    const res = await axios.get(searchUrl, { headers: HEADERS, httpsAgent: insecureAgent, timeout: 8000 });
    if (!res || !res.data) {
      return { success: false, error: 'Empty response data' };
    }

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // 1. Look for direct m3u8 or mp4 stream links
    const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    const mp4Match = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);

    if (m3u8Match) {
      console.log(`[MovieBox] ✅ Found M3U8: ${m3u8Match[0]}`);
      return {
        success: true,
        provider: 'MovieBox 🍿',
        providerId: 'moviebox',
        sources: [{ url: m3u8Match[0], quality: '1080p', isM3U8: true, noProxy: true }],
        subtitles: []
      };
    }

    if (mp4Match) {
      console.log(`[MovieBox] ✅ Found MP4: ${mp4Match[0]}`);
      return {
        success: true,
        provider: 'MovieBox 🍿',
        providerId: 'moviebox',
        sources: [{ url: mp4Match[0], quality: '1080p', isM3U8: false, noProxy: true }],
        subtitles: []
      };
    }

    // 2. Search Nuxt state payload for video items
    const nuxtState = html.match(/window\.__NUXT__=([\s\S]*?);<\/script>/)?.[1];
    if (nuxtState) {
      const cdnMediaMatch = nuxtState.match(/https?:\/\/pbcdn\.aoneroom\.com[^\s"'`)]+/i) || nuxtState.match(/https?:\/\/[^\s"'`)]+\.(m3u8|mp4)[^\s"'`)]*/i);
      if (cdnMediaMatch) {
        console.log(`[MovieBox] ✅ Found CDN Media URL in Nuxt State: ${cdnMediaMatch[0]}`);
        return {
          success: true,
          provider: 'MovieBox 🍿',
          providerId: 'moviebox',
          sources: [{ url: cdnMediaMatch[0], quality: '1080p', isM3U8: cdnMediaMatch[0].includes('.m3u8'), noProxy: true }],
          subtitles: []
        };
      }
    }

    console.log('[MovieBox] ❌ No direct stream URL in search payload');
    return { success: false, error: 'No stream found in search payload' };
  } catch (err) {
    console.log(`[MovieBox] ❌ Request failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}


