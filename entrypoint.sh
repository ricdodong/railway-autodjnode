#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting container initialization..."

# Ensure secrets dir exists
mkdir -p /app/secrets

# If COOKIES_B64 env exists, decode it into /app/secrets/cookies.txt
if [ -n "$COOKIES_B64" ]; then
  echo "[ENTRYPOINT] COOKIES_B64 detected, restoring cookies.txt..."
  echo "$COOKIES_B64" | base64 -d > /app/secrets/cookies.txt
  echo "[ENTRYPOINT] cookies.txt restored from base64."
fi

# If no cookies file present after decode, create empty one
if [ ! -f /app/secrets/cookies.txt ]; then
  echo "[ENTRYPOINT] No cookies.txt found, creating empty file..."
  touch /app/secrets/cookies.txt
else
  echo "[ENTRYPOINT] cookies.txt found."
fi

# Debug file info
ls -l /app/secrets/cookies.txt || true

echo "[ENTRYPOINT] Initialization complete. Launching app..."
exec "$@"
