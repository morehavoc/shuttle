#!/bin/sh
# Local preview on jaws-mini: wrangler dev over HTTPS (Tailscale cert), tailnet only.
# Data lives in .wrangler/preview-state. Password comes from .dev.vars.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
npx wrangler d1 migrations apply shuttle --local --persist-to .wrangler/preview-state >/dev/null 2>&1
exec npx wrangler dev --port 18896 --ip 100.102.103.67 --local-protocol https \
  --https-key-path ../.certs/jaws-mini.key --https-cert-path ../.certs/jaws-mini.crt \
  --persist-to .wrangler/preview-state --show-interactive-dev-session=false
