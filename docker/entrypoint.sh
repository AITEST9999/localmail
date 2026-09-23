#!/bin/sh
# Railway injects PORT for HTTP (and TCP proxy) listeners.
# LocalMail config schema uses API_PORT / SMTP_INBOUND_PORT instead of PORT.
set -eu

SERVICE="${SERVICE:-}"

if [ -n "${PORT:-}" ]; then
  case "$SERVICE" in
    api|"")
      # Prefer Railway PORT for the API HTTP listener when present.
      export API_PORT="$PORT"
      ;;
    smtp)
      # TCP proxy: map Railway PORT onto the inbound SMTP listen port unless
      # the operator already set SMTP_INBOUND_PORT explicitly for a private network.
      if [ -z "${SMTP_INBOUND_PORT:-}" ]; then
        export SMTP_INBOUND_PORT="$PORT"
      fi
      ;;
    dashboard)
      # Next.js standalone / next start already honor PORT; leave as-is.
      :
      ;;
    workers)
      # Workers are queue consumers; no HTTP bind required.
      :
      ;;
  esac
fi

exec "$@"
