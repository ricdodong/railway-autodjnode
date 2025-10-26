#!/usr/bin/env sh
set -e

# Path where decoded cookies will be written
COOKIES_PATH=${COOKIES_PATH:-/app/secrets/cookies.txt}

# Ensure secrets dir exists
mkdir -p "$(dirname "$COOKIES_PATH")"

# If COOKIES_B64 is provided (base64 of a netscape cookies.txt), decode it here.
# This avoids multiline-env corruption in Railway.
if [ -n "$COOKIES_B64" ]; then
  echo "$COOKIES_B64" | base64 -d > "$COOKIES_PATH" || {
    echo "Failed to decode COOKIES_B64 to $COOKIES_PATH" >&2
  }
fi

# Backwards-compat attempt: if COOKIES_FILE exists as plain (not recommended), write it.
# (You selected using only COOKIES_B64; this is left as a no-op unless you set COOKIES_FILE.)
if [ -n "$COOKIES_FILE" ] && [ ! -s "$COOKIES_PATH" ]; then
  # If COOKIES_PATH is empty and user still used COOKIES_FILE, write it (best-effort).
  echo "$COOKIES_FILE" > "$COOKIES_PATH" || true
fi

# Tight permissions
chmod 600 "$COOKIES_PATH" || true

# Execute the main process (node index.js or entrypoint command)
exec "$@"
