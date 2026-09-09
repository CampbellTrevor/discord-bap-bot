FROM node:22-bookworm-slim

# EJS is bundled by yt-dlp[default]; Node is its JavaScript runtime.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]' \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/yt-dlp/bin:${PATH}" NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN node scripts/verify-runtime.mjs
ENV PORT=10000 DATA_DIR=/var/data
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.mjs"]
