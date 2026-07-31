import { proxyAxios } from '../utils/http.js';

const baseUrl = 'https://lmscript.xyz';

export async function scrapeLookMovie(id, type, season, episode, title, year) {
    try {
        // 1. Search for the media
        const searchPath = type === 'show' ? '/v1/shows' : '/v1/movies';
        const { data: searchRes } = await proxyAxios.get(`${baseUrl}${searchPath}`, {
            params: { 'filters[q]': title },
            timeout: 5000
        });

        const items = searchRes.items || [];
        const result = items.find(item => {
            const itemYear = Number(item.year);
            const targetYear = Number(year);
            return item.title.toLowerCase() === title.toLowerCase() && (itemYear === targetYear || !year);
        });

        if (!result) return null;

        // 2. Get the specific ID (Movie ID or Episode ID)
        let mediaId = null;
        if (type === 'movie') {
            mediaId = result.id_movie;
        } else {
            const { data: showDetails } = await proxyAxios.get(`${baseUrl}/v1/shows`, {
                params: { expand: 'episodes', id: result.id_show },
                timeout: 5000
            });

            const targetEpisode = showDetails.episodes?.find(e => 
                Number(e.season) === Number(season) && Number(e.episode) === Number(episode)
            );
            if (targetEpisode) mediaId = targetEpisode.id;
        }

        if (!mediaId) return null;

        // 3. Fetch streams and subtitles
        const viewPath = type === 'show' ? '/v1/episodes/view' : '/v1/movies/view';
        const { data: streamData } = await proxyAxios.get(`${baseUrl}${viewPath}`, {
            params: { expand: 'streams,subtitles', id: mediaId },
            timeout: 5000
        });

        // 4. Extract preferred stream (M3U8)
        const opts = ['auto', '1080p', '1080', '720p', '720', '480p', '480'];
        let videoUrl = null;
        for (const res of opts) {
            if (streamData.streams?.[res]) {
                videoUrl = streamData.streams[res];
                break;
            }
        }

        if (!videoUrl) return null;

        // 5. Extract subtitles
        const subtitles = (streamData.subtitles || []).map(sub => ({
            url: `${baseUrl}${sub.url}`,
            lang: sub.language,
            label: sub.language
        }));

        return {
            success: true,
            provider: 'LookMovie 🎬',
            sources: [{
                url: videoUrl,
                quality: 'auto',
                isM3U8: true,
                noProxy: false,
            }],
            subtitles
        };

    } catch (e) {
        return null;
    }
}
