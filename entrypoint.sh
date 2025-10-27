#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting container initialization..."

# Ensure secrets dir exists
mkdir -p /app/secrets
echo "[ENTRYPOINT] COOKIES_B64 detected, restoring cookies.txt..."
echo "$COOKIES_B64" | base64 -d > /app/secrets/cookies.txt
echo "[ENTRYPOINT] cookies.txt restored from base64."


# Debug file info
ls -l /app/secrets/cookies.txt || true

echo "[ENTRYPOINT] Initialization complete. Launching app..."
exec "$@"
