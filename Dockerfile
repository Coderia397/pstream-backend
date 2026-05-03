FROM node:20-slim

# yt-dlp-exec requires Python + yt-dlp binary at install time
# ffmpeg is needed for merging audio/video streams if ever used
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Bundle source
COPY . .

EXPOSE 7860
ENV PORT=7860
# Tell yt-dlp-exec to use the pip-installed binary (always latest)
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp

CMD [ "node", "index.js" ]
