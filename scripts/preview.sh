#!/bin/sh
# Local preview on jaws-mini: wrangler dev over HTTPS (Tailscale cert), tailnet only.
# `--env local` has no Workers AI binding, so nothing here touches a Cloudflare account.
# Data lives in .wrangler/preview-state. Password (and OPENAI_API_KEY for transcripts) come from .dev.vars.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
unset CF_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 migrations apply shuttle --local --env local --persist-to .wrangler/preview-state >/dev/null 2>&1
exec npx wrangler dev --env local --port 18896 --ip 100.102.103.67 --local-protocol https \
  --https-key-path ../.certs/jaws-mini.key --https-cert-path ../.certs/jaws-mini.crt \
  --persist-to .wrangler/preview-state --show-interactive-dev-session=false
