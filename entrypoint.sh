#!/bin/sh
echo "[ENTRYPOINT] Initializing..."

# ensure dir exists
mkdir -p /app/secrets

# If cookies.txt does not exist, create it
if [ ! -f /app/secrets/cookies.txt ]; then
  echo "[ENTRYPOINT] No cookies.txt found. Creating empty file..."
  touch /app/secrets/cookies.txt
fi

echo "[ENTRYPOINT] Cookies file status:"
ls -l /app/secrets/cookies.txt

echo "[ENTRYPOINT] Starting app..."
exec "$@"
