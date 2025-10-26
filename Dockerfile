FROM node:18-slim

# Install ffmpeg + python3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json / lock file first for better caching
COPY package*.json ./

RUN npm install --omit=dev

# Copy app source
COPY . .

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV COOKIES_PATH="/app/secrets/cookies.txt"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
