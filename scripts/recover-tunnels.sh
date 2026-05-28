#!/usr/bin/env bash
# ----------------------------------------------------------------------
# recover-tunnels.sh — one-command Cloudflare quick-tunnel recovery.
#
# WHY this exists:
#   trycloudflare.com quick tunnels are deauthorized by Cloudflare every
#   few hours with no warning ("Unauthorized: Tunnel not found" in the
#   cloudflared log). Each recovery has the same 6 steps:
#     1. Kill stale cloudflared processes
#     2. Start fresh cloudflared tunnels for ports 5000 + 5001
#     3. Wait for the new URLs + grep them out of the logs
#     4. Update PUBLIC_BASE_URL in api/.env
#     5. Restart app.py so the WhatsApp provider + webhook log pick up
#     6. Swap VITE_API_BASE / VITE_AUTH_API on Vercel + redeploy
#
# This script does all six in order. After it returns, the live
# frontend at automation-frontend-flax.vercel.app talks to the new
# tunnel URLs and login works.
#
# Usage:
#     ./scripts/recover-tunnels.sh
#
# Requires:
#     - cloudflared.exe at .tools/cloudflared.exe
#     - python on PATH
#     - npx vercel logged into the right account
#     - Flask app.py + auth_server.py already running locally
# ----------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLOUDFLARED="$ROOT/.tools/cloudflared.exe"
LOG_DIR="$ROOT/.logs"
ENV_FILE="$ROOT/api/.env"
NPM_CACHE="$ROOT/.npm-cache"  # bypass C: drive when low

mkdir -p "$LOG_DIR" "$NPM_CACHE"

echo "[recover] step 1/6 — killing stale cloudflared processes"
powershell -NoProfile -Command "Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force" || true
sleep 1

echo "[recover] step 2/6 — starting fresh tunnels (http2)"
: > "$LOG_DIR/tunnel-api.log"
: > "$LOG_DIR/tunnel-auth.log"
"$CLOUDFLARED" tunnel --no-autoupdate --protocol http2 --url http://localhost:5000 > "$LOG_DIR/tunnel-api.log"  2>&1 &
"$CLOUDFLARED" tunnel --no-autoupdate --protocol http2 --url http://localhost:5001 > "$LOG_DIR/tunnel-auth.log" 2>&1 &
disown -a 2>/dev/null || true

echo "[recover] step 3/6 — waiting for URLs (up to 30s)"
for i in $(seq 1 15); do
  sleep 2
  API_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/tunnel-api.log"  | head -1 || true)
  AUTH_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/tunnel-auth.log" | head -1 || true)
  if [ -n "$API_URL" ] && [ -n "$AUTH_URL" ]; then break; fi
done
if [ -z "${API_URL:-}" ] || [ -z "${AUTH_URL:-}" ]; then
  echo "[recover] ERROR — tunnels failed to register. Tail logs:"
  tail -5 "$LOG_DIR/tunnel-api.log"  || true
  tail -5 "$LOG_DIR/tunnel-auth.log" || true
  exit 1
fi
echo "[recover]   API:  $API_URL"
echo "[recover]   AUTH: $AUTH_URL"

echo "[recover] step 4/6 — updating PUBLIC_BASE_URL in api/.env"
python -c "
import re
p='$ENV_FILE'
txt = open(p, encoding='utf-8').read()
txt, n = re.subn(r'^PUBLIC_BASE_URL=.*\$', f'PUBLIC_BASE_URL=$API_URL', txt, count=1, flags=re.MULTILINE)
assert n == 1, 'PUBLIC_BASE_URL line not found in api/.env'
open(p, 'w', encoding='utf-8', newline='').write(txt)
print('[recover]   api/.env updated')
"

echo "[recover] step 5/6 — restarting Flask app.py"
APP_PID=$(netstat -ano 2>/dev/null | grep ':5000' | grep LISTENING | awk '{print $5}' | head -1 || true)
if [ -n "$APP_PID" ]; then
  powershell -NoProfile -Command "Stop-Process -Id $APP_PID -Force -ErrorAction SilentlyContinue" || true
  sleep 1
fi
( cd "$ROOT" && nohup python api/app.py > "$LOG_DIR/app.log" 2>&1 & disown 2>/dev/null )
sleep 3
if ! curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5000/health | grep -q '^200$'; then
  echo "[recover] ERROR — app.py did not return 200 from /health after restart"
  tail -10 "$LOG_DIR/app.log"
  exit 1
fi

echo "[recover] step 6/6 — swapping Vercel env vars + redeploying"
cd "$ROOT/frontend"
NPM_CONFIG_CACHE="$NPM_CACHE" npx vercel env rm VITE_API_BASE production -y >/dev/null 2>&1 || true
NPM_CONFIG_CACHE="$NPM_CACHE" npx vercel env rm VITE_AUTH_API production -y >/dev/null 2>&1 || true
printf "%s" "$API_URL"  | NPM_CONFIG_CACHE="$NPM_CACHE" npx vercel env add VITE_API_BASE production  >/dev/null 2>&1
printf "%s" "$AUTH_URL" | NPM_CONFIG_CACHE="$NPM_CACHE" npx vercel env add VITE_AUTH_API production >/dev/null 2>&1
NPM_CONFIG_CACHE="$NPM_CACHE" npx vercel deploy --prod --yes --force 2>&1 | grep -E "Production|Aliased" || true

echo
echo "[recover] DONE."
echo "[recover]   Frontend: https://automation-frontend-flax.vercel.app"
echo "[recover]   API:      $API_URL"
echo "[recover]   AUTH:     $AUTH_URL"
echo "[recover]   Meta webhook (paste in dashboard): $API_URL/deliveries/whatsapp-webhook"
