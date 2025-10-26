#!/bin/bash
set -e

mkdir -p /app/secrets
echo "$COOKIES_FILE" > /app/secrets/cookies.txt
chmod 600 /app/secrets/cookies.txt
exec "$@"