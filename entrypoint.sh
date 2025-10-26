#!/usr/bin/env sh
set -e

# Always create secrets dir
mkdir -p /app/secrets

# Force cookies file write if COOKIES_FILE is present
if [ -n "$COOKIES_FILE" ]; then
    echo "$COOKIES_FILE" > /app/secrets/cookies.txt
fi

# Set correct permissions
chmod 600 /app/secrets/cookies.txt || true

# Exec app
exec "$@"
