@echo off
REM Stream YouTube to Icecast using yt-dlp + ffmpeg

SET YT_URL=https://www.youtube.com/watch?v=C7BtGs1w6hA&list=PLbnQ_chfspAASQE5rvE2vRusXt3tOSv4T&index=28&pp=gAQBiAQB8AUB
SET COOKIES_PATH="C:\Users\Asus\Documents\GitHub\railway-autodjnode\railway-autodjnode\cookies.txt"
SET ICECAST_URL=icecast://source:ricalgen127@interchange.proxy.rlwy.net:41091/live2

yt-dlp --extract-audio --audio-format mp3 --output - "%YT_URL%" | ffmpeg -re -i pipe:0 -acodec libmp3lame -ab 128k -content_type audio/mpeg -f mp3 "%ICECAST_URL%"
