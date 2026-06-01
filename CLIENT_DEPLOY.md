# Client deployment playbook

End-to-end runbook for deploying Mastermind Automation Studio onto a **client's** Hostinger VPS. Reads top to bottom — copy/paste the commands as-is, just fill in the placeholders marked `<LIKE_THIS>`.

Tested deploy that takes ~45 min wall-clock (most of it waiting on DNS + Meta template approval). Reproduces the friend's VPS deploy we ran on 2026-05-29.

---

## Phase 0 — Pre-deploy checklist (gather BEFORE you SSH)

You cannot deploy until you have all of these. Collect them first.

### From the client
| Item | What it is | Where to get it |
|---|---|---|
| **VPS root SSH access** | Browser terminal or SSH key/password | Hostinger hpanel → VPS → Manage → Browser terminal |
| **Domain name** | e.g. `clientdomain.com` (or Hostinger free `*.hstgr.cloud` subdomain) | Hostinger → Domains, or client's existing DNS provider |
| **DNS access** | Ability to add A records | Same as above |

### From the client's WhatsApp Business setup
| Item | What it is | Where to get it |
|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Meta-issued ID for the WABA phone number | https://developers.facebook.com → App → WhatsApp → API Setup |
| `WHATSAPP_ACCESS_TOKEN` | Permanent System User token (NOT temporary) | Business Settings → System Users → Generate token with `whatsapp_business_messaging` + `whatsapp_business_management` scopes |
| `WHATSAPP_APP_SECRET` | App secret for webhook signature verification | App → Settings → Basic → App Secret → Show |
| `WHATSAPP_BUSINESS_ID` | Meta business account ID | URL of WhatsApp Manager: `?business_id=<THIS>` |
| **Two approved templates** | At minimum: 1 MARKETING template with VIDEO or IMAGE header + 1 UTILITY text-only prompt template | WhatsApp Manager → Message templates → Create + submit for approval |

### Already done by us (no action)
- ✅ GitHub repo: `https://github.com/Jiya-ctrl/mastermind-automation`
- ✅ Docker stack: `docker-compose.yml` + `api/Dockerfile` + `frontend/Dockerfile`
- ✅ Recovery + diagnostic scripts in `scripts/`

---

## Phase 1 — VPS prep (5 min)

The client's Hostinger VPS needs Docker + a Traefik network. Hostinger's "Docker Manager" VPS template ships with both pre-installed; if not, install manually first.

```bash
# Verify Docker is running + traefik network exists
docker --version
docker network ls | grep traefik
```

If `docker network ls | grep traefik` returns nothing:

```bash
# Bring up Traefik with a basic HTTPS config. Skip if client already has
# their own Traefik / nginx reverse proxy — just point it at our 3 services.
mkdir -p /opt/traefik && cd /opt/traefik
cat > docker-compose.yml <<'EOF'
services:
  traefik:
    image: traefik:v3.0
    restart: unless-stopped
    command:
      - --api.dashboard=false
      - --providers.docker=true
      - --providers.docker.exposedByDefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.tlschallenge=true
      - --certificatesresolvers.letsencrypt.acme.email=ops@<CLIENTDOMAIN>
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - traefik

networks:
  traefik:
    name: traefik
EOF
docker compose up -d
```

---

## Phase 2 — DNS (5 min to set, up to 30 min to propagate)

In the client's DNS provider, add three A records pointing at the VPS public IP:

| Type | Name | Value |
|---|---|---|
| A | `app` | `<VPS_PUBLIC_IP>` |
| A | `api` | `<VPS_PUBLIC_IP>` |
| A | `auth` | `<VPS_PUBLIC_IP>` |

Result:
- `app.<CLIENTDOMAIN>` — frontend
- `api.<CLIENTDOMAIN>` — backend
- `auth.<CLIENTDOMAIN>` — auth service

Verify propagation (from your laptop, not the VPS):
```bash
dig +short app.<CLIENTDOMAIN>
dig +short api.<CLIENTDOMAIN>
dig +short auth.<CLIENTDOMAIN>
```
All three should print `<VPS_PUBLIC_IP>`. If not, wait + retry; Traefik can't issue Let's Encrypt certs until DNS resolves.

---

## Phase 3 — Clone + env config (5 min)

SSH into the VPS, then:

```bash
cd /opt
git clone https://github.com/Jiya-ctrl/mastermind-automation.git
cd mastermind-automation

# Generate strong secrets the client doesn't have to invent
SESS=$(openssl rand -hex 32)
WVT=$(openssl rand -hex 8)

# Pick non-placeholder operator credentials. CHANGE THESE for each client.
OP_USER="<CLIENT_OPERATOR_LOGIN>"        # e.g. "abacus_admin", NOT "mastermind_abc"
OP_PASS="<CLIENT_INITIAL_PASSWORD>"      # e.g. "TempPass#2026", NOT "master@123#"
OP_RK="MA-$(openssl rand -hex 2 | tr a-f A-F)-$(openssl rand -hex 2 | tr a-f A-F)-$(openssl rand -hex 2 | tr a-f A-F)"

# Write the production env file
cat > .env.production <<EOF
# --- Domains ---
APP_DOMAIN=app.<CLIENTDOMAIN>
API_DOMAIN=api.<CLIENTDOMAIN>
AUTH_DOMAIN=auth.<CLIENTDOMAIN>

# --- Auth (the client logs in with these — save somewhere safe) ---
AUTH_USER_ID=${OP_USER}
AUTH_DEFAULT_PASSWORD=${OP_PASS}
AUTH_RECOVERY_KEY=${OP_RK}
SESSION_SECRET=${SESS}
SESSION_TTL_HOURS=24
MEDIA_URL_TTL_HOURS=168
AUTH_LOGIN_MAX_PER_HOUR=12
AUTH_LOGIN_MAX_PER_USER_PER_HOUR=8
AUTH_RECOVERY_MAX_PER_HOUR=5

# --- CORS / proxy ---
CORS_ORIGINS=https://app.<CLIENTDOMAIN>
TRUSTED_PROXIES=1
FLASK_ENV=production

# --- WhatsApp (from client's Meta dashboard) ---
WHATSAPP_PHONE_NUMBER_ID=<PASTE_FROM_META>
WHATSAPP_ACCESS_TOKEN=<PASTE_FROM_META>
WHATSAPP_APP_SECRET=<PASTE_FROM_META>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=${WVT}
PUBLIC_BASE_URL=https://api.<CLIENTDOMAIN>
WHATSAPP_MEDIA_KIND=video

# Two-step flow — bypasses Meta's ecosystem engagement filter
# Replace these template names with the client's APPROVED template names
WHATSAPP_FLOW=two-step
WHATSAPP_PROMPT_TEMPLATE=<CLIENT_UTILITY_PROMPT_TEMPLATE_NAME>
WHATSAPP_PROMPT_LANG=en
WHATSAPP_PROMPT_BODY_PARAMS={name}

WHATSAPP_TEMPLATE_IMAGE=<CLIENT_IMAGE_TEMPLATE_NAME>
WHATSAPP_TEMPLATE_VIDEO=<CLIENT_VIDEO_TEMPLATE_NAME>
WHATSAPP_TEMPLATE_LANG=en
WHATSAPP_TEMPLATE_BODY_PARAMS={name}
EOF

# IMPORTANT: print the auth values ONCE — paste them somewhere safe
# (password manager, etc.) before you close this terminal session.
echo "=== CLIENT CREDENTIALS — save these now ==="
echo "User ID:       ${OP_USER}"
echo "Password:      ${OP_PASS}"
echo "Recovery key:  ${OP_RK}"
echo "Verify token:  ${WVT}  (for Meta webhook config)"
echo "==========================================="

# Open the file and fill in the <PLACEHOLDER> values that we couldn't generate
nano .env.production
# Replace every <PASTE_FROM_META>, <CLIENT_*>, <CLIENTDOMAIN>, etc.
```

After editing, sanity-check:
```bash
grep -E '<[A-Z_]+>' .env.production && echo "STILL HAS PLACEHOLDERS — keep editing" || echo "OK"
```
That should print `OK`. If it prints "STILL HAS PLACEHOLDERS", fix those before continuing.

---

## Phase 4 — Build + start (5 min build + 30s up)

```bash
cd /opt/mastermind-automation

# Auto-detect the Traefik cert resolver name from existing services (if any)
RESOLVER=$(docker inspect $(docker ps --filter "label=traefik.enable=true" -q) 2>/dev/null \
  | grep -oP 'traefik\.http\.routers\.[^"]+\.tls\.certresolver"\s*:\s*"\K[^"]+' \
  | sort -u | head -1)
if [ -n "$RESOLVER" ] && [ "$RESOLVER" != "letsencrypt" ]; then
  sed -i "s/certresolver=letsencrypt/certresolver=$RESOLVER/g" docker-compose.yml
  echo "Patched compose to use existing resolver: $RESOLVER"
fi

# Build images (ffmpeg pull + vite build — ~3-5 min the first time)
docker compose --env-file .env.production build

# Start everything
docker compose --env-file .env.production up -d
sleep 10
docker compose ps
docker compose logs --tail=30 api | grep -E '\[startup\]|\[cors\]|\[api-ready\]'
```

Expected log lines:
```
[cors] origins = ['https://app.<CLIENTDOMAIN>']
[startup] delivery provider: whatsapp
[startup] WhatsApp flow: two-step  prompt_template=<utility-template-name>
[startup] webhook_url           = https://api.<CLIENTDOMAIN>/deliveries/whatsapp-webhook
[startup] verify_token_present  = True
[startup] app_secret_present    = True
[startup] provider              = whatsapp
[api-ready] flask app.py listening on http://127.0.0.1:5000
```

If `provider = mock` (not `whatsapp`) — one of the WhatsApp env vars is empty. Re-check `.env.production`.

---

## Phase 5 — Smoke test from anywhere (1 min)

```bash
curl -s -o /dev/null -w "frontend → %{http_code}\n" https://app.<CLIENTDOMAIN>
curl -s -o /dev/null -w "api      → %{http_code}\n" https://api.<CLIENTDOMAIN>/health
curl -s -o /dev/null -w "auth     → %{http_code}\n" https://auth.<CLIENTDOMAIN>/health
```

All three should print `200`. If any prints `000` (cert not issued yet), wait 30 seconds and retry — Traefik fetches Let's Encrypt certs in the background on first hit.

---

## Phase 6 — Meta webhook (1 min, but the change is permanent)

In Meta dashboard for the client's app → **WhatsApp → Configuration → Webhook → Edit**:

| Field | Value |
|---|---|
| **Callback URL** | `https://api.<CLIENTDOMAIN>/deliveries/whatsapp-webhook` |
| **Verify token** | The `WHATSAPP_WEBHOOK_VERIFY_TOKEN` value from `.env.production` |

Click **Verify and Save**. Should turn green / "Verified".

Below the webhook box, in **Webhook fields**:
- ✅ Subscribe to `messages` (REQUIRED for two-step flow inbound replies)
- ✅ Subscribe to `message_status_updates` (or whatever Meta calls the status field in your API version)

---

## Phase 7 — First operator login + hand-off (5 min)

1. Open `https://app.<CLIENTDOMAIN>/login` in a browser
2. Sign in with `${OP_USER}` / `${OP_PASS}` (the values you saved during Phase 3)
3. **Immediately** open Settings → Change Password → set a password the client will remember (the temporary one becomes irrelevant)
4. Save the recovery key offline (write it on paper / password manager) — this is the only way to reset password if lost
5. Hand the dashboard URL + new credentials to the client

---

## Phase 8 — Persistence after reboot (one-time)

```bash
# Make sure Docker auto-starts on boot
sudo systemctl enable docker
sudo systemctl status docker      # should show "enabled" + "active"

# Test it
sudo reboot
# Wait ~30s, SSH back in:
docker compose ps                  # all 3 services should be Up
```

`restart: unless-stopped` is already set on every service in `docker-compose.yml` — combined with `systemctl enable docker`, the stack survives all reboots.

---

## Phase 9 — Updating the deployment (future)

Whenever new code lands on `main`:

```bash
cd /opt/mastermind-automation
git pull
docker compose --env-file .env.production up -d --build
docker image prune -f          # clean up dangling images
```

Bind-mounted `data/`, `output/`, `templates/` survive rebuilds untouched.

---

## Backup + restore (operator state)

The only stateful directory is `data/`. It contains:
- `auth.json` — operator credentials (hashed) + recovery key
- `deliveries.json` — every delivery row + history
- `recipients.json` — connected sheet snapshot
- `delivery-logs.jsonl` — append-only audit log
- `sheet-source.json` — sheet connection metadata
- `whatsapp-template.json` — operator's template/flow override (if set via UI)

### Daily backup

Add this as a cron job on the VPS:

```bash
crontab -e
# Add this line:
0 3 * * * tar czf /root/backups/mm-data-$(date +\%F).tar.gz -C /opt/mastermind-automation data/ && find /root/backups -mtime +30 -delete
```

Backs up `data/` to `/root/backups/mm-data-YYYY-MM-DD.tar.gz` every night at 3 AM, keeps 30 days.

For off-site backup, scp/rsync the backup folder to another machine:

```bash
# On the backup machine:
rsync -avz root@<CLIENT_VPS_IP>:/root/backups/ /local/backups/mm-client/
```

### Restore

```bash
cd /opt/mastermind-automation
docker compose --env-file .env.production down
tar xzf /root/backups/mm-data-YYYY-MM-DD.tar.gz -C ./
docker compose --env-file .env.production up -d
```

---

## Operator runbook (for the client's team)

Hand this section to the client's operator.

### Daily workflow

1. **Log in:** `https://app.<CLIENTDOMAIN>/login`
2. **Upload template** (Upload Template page) — pick the base video/image you want personalised
3. **Connect Google Sheet** (Google Sheets page) — paste a public Google Sheets CSV URL with columns: `name`, `phone`, `address`. Click Refresh to re-sync after editing the sheet.
4. **Generate media** (Generated Media page) — click Generate Images or Generate Videos. One render per recipient. Takes ~5 sec/image, ~1 min/video.
5. **Send media** (WhatsApp Send page) — click Send Media → pick Image or Video. The two-step flow ships a text prompt first; recipient replies "YES" (or anything); media auto-delivered inside Meta's 24h window.
6. **Track delivery** — KPI cards at the top of WhatsApp Send page show Queued / Sending / Awaiting Reply / Media Sent / Delivered / Read / Failed counts.

### Common operator tasks

| Task | How |
|---|---|
| Add new recipients | Edit the connected Google Sheet → Refresh on Google Sheets page |
| Resend to a failed recipient | Click Retry on that row in WhatsApp Send |
| Delete one generated render | Generated Media → click the X on the card |
| Wipe all renders | Generated Media → 🧹 Wipe button |
| Change password | Top-right profile dropdown → Settings → Change Password |
| Switch flow (direct vs two-step) | WhatsApp Send page → scroll to "WhatsApp Template & Flow" panel → pick + Save |

### When things go wrong

| Symptom | First thing to try |
|---|---|
| Login: "Network error" | Hard-refresh (Ctrl+Shift+R). If still fails, check VPS is up. |
| Sends staying in "Sending" forever | Meta webhook subscription not configured — go to Meta dashboard → WhatsApp → Configuration → verify `messages` is subscribed. |
| Sends staying in "Awaiting Reply" | Two-step prompt sent but recipient hasn't replied yet, OR webhook isn't receiving inbound `messages`. |
| "Media upload error" in logs | The generated file is missing/corrupted. Regenerate that row. |
| "Healthy ecosystem engagement" error | Recipient never messaged the business AND you're using direct flow. Switch to two-step, OR have recipient send a "Hi" first. |

---

## Troubleshooting (every issue we hit during the friend's VPS deploy)

| Issue | Symptom | Fix |
|---|---|---|
| **CRLF in env file** | `docker compose config` shows the var, container doesn't see it | `sed -i 's/\r$//' .env.production` |
| **BOM in env file** | First var in env_file silently dropped | `sed -i '1s/^\xef\xbb\xbf//' .env.production` |
| **`docker compose restart` doesn't pick up env changes** | Container shows old env vars | Use `up -d --force-recreate api` instead of `restart api` |
| **Dashboard override file beats env** | Env says `direct` but container logs `two-step` | `rm -f data/whatsapp-template.json` + force-recreate api |
| **AUTH refuses to seed** | `auth_server.py` crashes with "refusing to seed with placeholder values" | Change `AUTH_USER_ID`, `AUTH_DEFAULT_PASSWORD`, `AUTH_RECOVERY_KEY` to NON-placeholder values (placeholders blocklist is in `auth_server.py`) |
| **Stuck "Restarting" containers** | `docker compose ps` shows `Restarting (N) Xs ago` | `docker compose logs <service>` — usually env var error in the startup banner |
| **Template not found `#132001`** | Send fails immediately | Template name in env doesn't match what's actually APPROVED in WhatsApp Manager. Check spelling + language. |
| **Parameter format mismatch `#132012`** | Send fails | Template header type (IMAGE vs VIDEO) doesn't match the file kind being sent. Use `WHATSAPP_TEMPLATE_IMAGE` for image templates and `WHATSAPP_TEMPLATE_VIDEO` for video templates. |
| **Parameter count mismatch `#132000`** | Send fails | Body has `{{1}}` but env sends 0 params (or has 0 placeholders but env sends 1). Match `WHATSAPP_TEMPLATE_BODY_PARAMS` to template's actual placeholders. |
| **"Media upload error" from Meta webhook** | Send succeeds but final status = failed | Generated media file missing/corrupted, OR file URL not reachable from Meta. Regenerate. |
| **"Healthy ecosystem engagement"** | New recipients get this when first marketing send goes out | Use two-step flow with UTILITY-category prompt template (bypasses the filter). |

---

## Hardening checklist (before charging client real money)

- [ ] Operator changed default password (Phase 7 step 3)
- [ ] Recovery key stored offline
- [ ] Daily `data/` backup cron is running (`crontab -l` shows it)
- [ ] Off-site backup destination is set up (rsync from another machine works)
- [ ] `sudo systemctl enable docker` confirmed
- [ ] Webhook URL set in Meta dashboard + Verified
- [ ] `messages` field subscribed in Meta webhook fields panel
- [ ] At least one approved Marketing template (image OR video header)
- [ ] At least one approved Utility text-prompt template (for two-step flow)
- [ ] Tested full flow with operator's own real phone number end-to-end
- [ ] HTTPS cert successfully issued (no "not secure" warning in browser)
- [ ] Operator has dashboard URL + login credentials documented somewhere they control

When every box is checked, you can hand over to the client.

---

## Decommissioning the friend's VPS (later)

When the client's deploy is fully live:

```bash
# On friend's VPS:
cd /opt/mastermind-automation
docker compose --env-file .env.production down
# Optional: keep the data/ for archival; or remove if no longer needed
# DO NOT remove until you've confirmed client's data/ is fully populated
```

Don't rush this. Keep the friend's deployment running for at least a week after the client goes live, as a hot standby in case the client's VPS has issues.

---

## Quick reference — full deploy in 10 commands

For an experienced operator who's done this before:

```bash
# 1. SSH to client's VPS, then:
cd /opt && git clone https://github.com/Jiya-ctrl/mastermind-automation && cd mastermind-automation

# 2. Generate secrets
SESS=$(openssl rand -hex 32); WVT=$(openssl rand -hex 8)
echo "Save: SESS=$SESS  WVT=$WVT"

# 3. Copy template + edit
cp .env.example .env.production && nano .env.production

# 4. Auto-detect cert resolver
RESOLVER=$(docker inspect $(docker ps --filter "label=traefik.enable=true" -q) 2>/dev/null | grep -oP 'tls\.certresolver"\s*:\s*"\K[^"]+' | sort -u | head -1)
[ -n "$RESOLVER" ] && [ "$RESOLVER" != "letsencrypt" ] && sed -i "s/certresolver=letsencrypt/certresolver=$RESOLVER/g" docker-compose.yml

# 5. Build + start
docker compose --env-file .env.production up -d --build

# 6. Verify
sleep 10 && docker compose ps && docker compose logs --tail=30 api | grep '\[startup\]'

# 7. Smoke test
for sub in app api auth; do curl -s -o /dev/null -w "$sub %{http_code}\n" https://$sub.<CLIENTDOMAIN>; done

# 8. Set Meta webhook (in browser) → https://api.<CLIENTDOMAIN>/deliveries/whatsapp-webhook + $WVT

# 9. Persistence
sudo systemctl enable docker

# 10. Backup cron
( crontab -l 2>/dev/null; echo "0 3 * * * tar czf /root/backups/mm-data-\$(date +\\%F).tar.gz -C /opt/mastermind-automation data/ && find /root/backups -mtime +30 -delete" ) | crontab -
```

Done.
