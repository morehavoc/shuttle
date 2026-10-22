#!/bin/sh
# Starts a throwaway HTTPS test server for test/e2e.mjs on the tailnet IP (Safari/WebKit keeps
# Secure cookies only over HTTPS). Usage: sh test/serve.sh [port]  → prints its PID.
# TRANSCRIBE=real uses the OpenAI key in .dev.vars instead of the fake transcriber.
cd "$(dirname "$0")/.." || exit 1
PORT=${1:-18897}
unset CF_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
rm -rf .wrangler/e2e-state
FAKE_VAR="--var TRANSCRIBE_FAKE:1"
[ "$TRANSCRIBE" = real ] && FAKE_VAR=""
# INDEX_DELAY_MS=8000: the fast-start index lands that long after it was built (tests only).
[ -n "$INDEX_DELAY_MS" ] && FAKE_VAR="$FAKE_VAR --var INDEX_DELAY_MS:$INDEX_DELAY_MS"
# INDEX_WAIT_MS=2000: "complete" stops waiting for the index sooner than its 15 s.
[ -n "$INDEX_WAIT_MS" ] && FAKE_VAR="$FAKE_VAR --var INDEX_WAIT_MS:$INDEX_WAIT_MS"
# REDACT_STEP_MS=500: an edited video's copy is built in steps this short (many of them).
[ -n "$REDACT_STEP_MS" ] && FAKE_VAR="$FAKE_VAR --var REDACT_STEP_MS:$REDACT_STEP_MS"
mkdir -p test/out
npx wrangler d1 migrations apply shuttle --local --env local --persist-to .wrangler/e2e-state >/dev/null 2>&1
npx wrangler dev --env local --port "$PORT" --ip 100.102.103.67 --local-protocol https \
  --https-key-path ../.certs/jaws-mini.key --https-cert-path ../.certs/jaws-mini.crt \
  --persist-to .wrangler/e2e-state --var OWNER_PASSWORD:test-password-123 $FAKE_VAR \
  --show-interactive-dev-session=false > test/out/e2e-server.log 2>&1 &
echo $!
