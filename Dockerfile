FROM node:18-slim

# Install ffmpeg + python3 + pip + yt-dlp
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

# Copy entrypoint and ensure executable
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
# Location of cookies file (used by yt-dlp + index.js)
ENV COOKIES_PATH="/app/secrets/cookies.txt"

# ENTRYPOINT runs first and prepares cookies
ENTRYPOINT ["/app/entrypoint.sh"]

# Then run Node after init
CMD ["node", "index.js"]
