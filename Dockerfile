FROM node:20-slim

# Install dependencies (yt-dlp + ffmpeg)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
