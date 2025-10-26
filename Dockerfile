FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install yt-dlp

WORKDIR /app
COPY package.json package.json
COPY index.js index.js
COPY sources.txt sources.txt

# Ensure cache & tmp exist
RUN mkdir -p /app/cache /app/tmp

CMD ["npm", "start"]
