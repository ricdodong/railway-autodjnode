#!/bin/bash
set -e

# Create secrets directory if not exists
mkdir -p /app/secrets

# Write cookies from env to file (only if variable is non-empty)
if [ -n "$COOKIES_FILE" ]; then
  echo "$COOKIES_FILE" > "$COOKIES_PATH"
fi

# Ensure permissions safe
chmod 600 "$COOKIES_PATH" || true

exec "$@"
