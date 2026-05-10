import axios from 'axios';

/**
 * AllDebrid Service v1.0
 * 
 * Interacts with AllDebrid API v4.
 * - Uploads magnets
 * - Polls for status
 * - Unlocks links for direct streaming
 */

const BASE_URL = 'https://api.alldebrid.com/v4';
const BASE_URL_V41 = 'https://api.alldebrid.com/v4.1';

export class AllDebrid {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = axios.create({
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        });
    }

    /**
     * Upload a magnet to AllDebrid.
     * If it's already "ready", returns the info immediately.
     */
    async uploadMagnet(magnet) {
        try {
            const resp = await this.client.post(`${BASE_URL}/magnet/upload`, null, {
                params: { magnets: [magnet] }
            });
            if (resp.data.status === 'success') {
                return resp.data.data.magnets[0];
            }
            throw new Error(resp.data.error?.message || 'Failed to upload magnet');
        } catch (e) {
            console.error('[AllDebrid] Upload error:', e.message);
            throw e;
        }
    }

    /**
     * Get status of a magnet by ID.
     */
    async getMagnetStatus(id) {
        try {
            const resp = await this.client.post(`${BASE_URL_V41}/magnet/status`, null, {
                params: { id }
            });
            if (resp.data.status === 'success') {
                return resp.data.data.magnets[0] || resp.data.data.magnets;
            }
            throw new Error(resp.data.error?.message || 'Failed to get magnet status');
        } catch (e) {
            console.error('[AllDebrid] Status error:', e.message);
            throw e;
        }
    }

    /**
     * Get files/links for a magnet ID.
     */
    async getMagnetFiles(id) {
        try {
            const resp = await this.client.post(`${BASE_URL_V41}/magnet/files`, null, {
                params: { 'id[]': id }
            });
            if (resp.data.status === 'success') {
                return resp.data.data.magnets[0];
            }
            throw new Error(resp.data.error?.message || 'Failed to get magnet files');
        } catch (e) {
            console.error('[AllDebrid] Files error:', e.message);
            throw e;
        }
    }

    /**
     * Unlock a link to get a direct streamable URL.
     */
    async unlockLink(link) {
        try {
            const resp = await this.client.post(`${BASE_URL}/link/unlock`, null, {
                params: { link }
            });
            if (resp.data.status === 'success') {
                return resp.data.data;
            }
            throw new Error(resp.data.error?.message || 'Failed to unlock link');
        } catch (e) {
            console.error('[AllDebrid] Unlock error:', e.message);
            throw e;
        }
    }

    /**
     * Helper: Convert magnet to direct stream link.
     * 1. Upload magnet
     * 2. If ready, pick the largest file and unlock its link.
     * 3. If not ready, wait or return status.
     */
    async resolveMagnet(magnet, fileIdx = null) {
        const uploadResult = await this.uploadMagnet(magnet);
        
        if (uploadResult.ready) {
            // Magnet is instantly ready (cached on AllDebrid servers)
            // We need to get the file links. magnet/status with ID returns 'files' property.
            const status = await this.getMagnetStatus(uploadResult.id);
            const files = status.files || [];
            
            if (files.length === 0) {
                // If files aren't in status, try magnet/files
                const filesData = await this.getMagnetFiles(uploadResult.id);
                if (filesData && filesData.files) files.push(...filesData.files);
            }

            if (files.length === 0) throw new Error('No files found in debrid magnet');

            // Pick file: by index if provided, else largest video file
            let targetFile;
            const videoFiles = files.filter(f => 
                /\.(mp4|mkv|avi|mov|wmv|ts|m4v)$/i.test(f.n || f.name)
            );

            if (fileIdx !== null && files[fileIdx]) {
                targetFile = files[fileIdx];
            } else {
                targetFile = videoFiles.sort((a, b) => (b.s || b.size) - (a.s || a.size))[0];
            }

            if (!targetFile) throw new Error('No streamable video file found');

            // targetFile.l or targetFile.link is the "unlocked" link if ready?
            // Actually, AllDebrid returns links in status for ready magnets.
            const link = targetFile.l || targetFile.link;
            if (!link) throw new Error('Ready magnet but no link found for file');

            // Unlock the link to get the final download URL
            const unlocked = await this.unlockLink(link);
            return {
                url: unlocked.link,
                filename: unlocked.filename,
                filesize: unlocked.filesize,
                streams: unlocked.streams
            };
        }

        return {
            ready: false,
            id: uploadResult.id,
            status: 'downloading',
            progress: 0
        };
    }
}
