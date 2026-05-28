# Production deployment — Hostinger VPS

End-to-end runbook. Reads top-to-bottom, no skipping. Steps that touch the
internet (DNS, GitHub, Meta) are noted so you can do them in parallel
while the VPS work happens.

---

## 0. Before you start

You need:

- Hostinger Ubuntu 24 VPS with Docker installed and the existing **Traefik** stack running on a Docker network called `traefik`. (You said you have this. If the network name is different, edit `docker-compose.yml` accordingly — search for `traefik:` and `external: true`.)
- DNS access for the apex domain you want to host this under.
- A GitHub account.
- Your Meta WhatsApp Business app credentials (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`).
- An **approved** prompt template in WhatsApp Manager with body text like:
  > Hi {{1}}, Thanks for your interest 😊 Reply YES to receive your personalised media.
- An **approved** media template (e.g. `promo_media_update`) with IMAGE/VIDEO header — kept as a safety fallback only; the two-step flow ships the media as freeform.

---

## 1. Push the local project to GitHub

Run from `d:/automation-project` on your dev machine.

```bash
# Sanity: confirm no secrets are about to be committed.
# This should list api/.env, data/, output/, .tools/, .logs/ as IGNORED.
git status --ignored | head -40

# Initialise the repo if you haven't already.
git init
git branch -M main

# Stage everything that's not gitignored.
git add .
git commit -m "Initial commit: Mastermind Automation Studio (production-ready)"

# Create the GitHub repo (do this in the browser at https://github.com/new
# — PRIVATE recommended). Then add it as the remote and push.
git remote add origin git@github.com:<your-user>/mastermind-automation.git
# OR over HTTPS if you don't have an SSH key set up:
# git remote add origin https://github.com/<your-user>/mastermind-automation.git

git push -u origin main
```

If `git push` is rejected for being too large: `data/`, `output/`, `.tools/`, `frontend/node_modules/` and similar should all be in `.gitignore`. Run `git ls-files | xargs du -k | sort -nr | head -20` to see what's actually staged.

---

## 2. DNS — point three subdomains at the VPS

In your DNS provider (Hostinger, Cloudflare, wherever your zone lives), add three records pointing at the VPS public IP:

| Type | Name | Value |
|---|---|---|
| A | `app` | `<VPS public IP>` |
| A | `api` | `<VPS public IP>` |
| A | `auth` | `<VPS public IP>` |

Result: `app.yourdomain.com`, `api.yourdomain.com`, `auth.yourdomain.com` all resolve to the VPS.

Traefik issues Let's Encrypt certs automatically on the first request to each host (assuming your Traefik already has a working `letsencrypt` cert resolver — most starter Traefik configs name it that). If your resolver has a different name, search `letsencrypt` in `docker-compose.yml` and replace.

DNS propagation: usually 5–30 minutes. You can move on to step 3 while it spreads.

---

## 3. Clone + configure on the VPS

SSH to the VPS, then:

```bash
# Pick a parent directory. /opt is conventional.
cd /opt
sudo git clone git@github.com:<your-user>/mastermind-automation.git
sudo chown -R $USER:$USER mastermind-automation
cd mastermind-automation

# Create the production env file from the template.
cp .env.example .env.production
nano .env.production   # or vim / your editor of choice
```

Fill in every value in `.env.production`. The minimum non-placeholder set:

- `APP_DOMAIN`, `API_DOMAIN`, `AUTH_DOMAIN` — the subdomains you just configured
- `AUTH_USER_ID`, `AUTH_DEFAULT_PASSWORD`, `AUTH_RECOVERY_KEY` — operator credentials
- `SESSION_SECRET` — `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- `CORS_ORIGINS` — set to `https://app.yourdomain.com` exactly (no trailing slash)
- `WHATSAPP_*` — paste from your Meta dashboard
- `PUBLIC_BASE_URL` — `https://api.yourdomain.com` (the API subdomain)
- `WHATSAPP_PROMPT_TEMPLATE` — the approved name of your stage-1 text template

The default `WHATSAPP_FLOW=two-step` matches the engagement architecture you built. Don't change it unless you specifically want direct media sends (which Meta will mostly throttle for cold recipients).

---

## 4. Build images + bring the stack up

Still on the VPS, in `/opt/mastermind-automation`:

```bash
# Make sure the existing Traefik network exists. Should print a network ID.
docker network ls | grep traefik

# Build both images. ~3 min for the backend (ffmpeg pull), ~1 min for the
# frontend (Vite build).
docker compose --env-file .env.production build

# Start everything detached. Traefik picks up the new container labels
# within a couple of seconds.
docker compose --env-file .env.production up -d

# Tail the logs to confirm no boot errors.
docker compose logs -f --tail=80
```

Successful boot pattern in the api log:

```
[cors] origins = ['https://app.yourdomain.com']
[startup] WhatsApp templates: image=... video=... lang=en body_params=['{name}']
[startup] delivery provider: whatsapp
[startup] WhatsApp flow: two-step  prompt_template=...  prompt_lang=en
[startup] webhook_url           = https://api.yourdomain.com/deliveries/whatsapp-webhook
[startup] verify_token_present  = True
[startup] app_secret_present    = True
[api-ready] flask app.py listening on http://127.0.0.1:5000
```

Quick smoke test from anywhere:

```bash
curl -s https://api.yourdomain.com/health    # → {"status":"ok",...}
curl -s https://auth.yourdomain.com/health   # → {"service":"auth","status":"ok",...}
curl -sI https://app.yourdomain.com/ | head -1   # → HTTP/2 200
```

---

## 5. Configure the permanent WhatsApp webhook

In **Meta for Developers → your app → WhatsApp → Configuration → Webhook**:

| Field | Value |
|---|---|
| **Callback URL** | `https://api.yourdomain.com/deliveries/whatsapp-webhook` |
| **Verify token** | exact value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `.env.production` |

Click **Verify and Save**. Meta sends a GET with `hub.challenge=…`; the backend echoes it back. The webhook should immediately flip to "verified".

**Subscribe to webhook fields** (separate panel, easy to miss):

- ✅ `messages` — inbound user replies (this is what drives the stage-2 trigger)
- ✅ `message_status_updates` — sent / delivered / read / failed

Without `messages` subscribed, your stage-1 prompts will go out fine but the worker never receives the reply event, so rows stay stuck at `Awaiting Reply` forever.

Test it: after subscribing, message your WhatsApp Business number from a phone. Watch the api container log:

```bash
docker compose logs -f api | grep -E '\[(inbound|media-stage)\]'
```

You should see `[inbound] from=… digits=… type=text id=wamid… preview='hi'`. If you also have an `Awaiting Reply` row for that phone, you'll see `[media-stage] transition=awaiting_reply->queued_media` immediately after.

---

## 6. First operator login + log-in flow

1. Open `https://app.yourdomain.com/login` in a browser.
2. Sign in with the `AUTH_USER_ID` / `AUTH_DEFAULT_PASSWORD` you set in `.env.production`.
3. Open **Settings → Change Password** and rotate the password to something only you know. The `.env.production` `AUTH_DEFAULT_PASSWORD` is now irrelevant (it was only used to seed `data/auth.json` on first boot).
4. Save the **recovery key** somewhere offline.

---

## 7. Persistence after VPS reboot

Two things make the stack survive reboots:

1. `restart: unless-stopped` on every service in `docker-compose.yml` — already set. Docker will restart each container automatically if it dies or after a reboot, but only if Docker itself comes up.
2. Make sure the Docker daemon starts on boot:
   ```bash
   sudo systemctl enable docker
   sudo systemctl status docker   # should be "enabled" + "active"
   ```

Test it once:

```bash
sudo reboot
# Wait ~30s, SSH back in, then:
docker compose ps
# Should show all three containers as Up.
```

If a container is failing to start after reboot, `docker compose logs --tail=80 <service>` shows what blew up — almost always a typo in `.env.production` or a stale `data/` from a prior dev run.

---

## 8. Updating the deployment

When you push new code to `main`:

```bash
# On the VPS:
cd /opt/mastermind-automation
git pull
docker compose --env-file .env.production up -d --build

# Optional cleanup of dangling images from previous builds.
docker image prune -f
```

Both services get rebuilt and replaced with the new version. The bind-mounted `data/`, `output/`, and `templates/` survive — operator state, deliveries, and uploaded templates persist untouched.

---

## 9. Production folder layout (for reference)

```
/opt/mastermind-automation/
├── api/                       # backend source
│   ├── Dockerfile             # Python 3.11 + ffmpeg + libass + gunicorn
│   ├── app.py                 # main API (port 5000)
│   ├── auth_server.py         # auth microservice (port 5001)
│   ├── providers.py           # WhatsApp Cloud API + Mock providers
│   ├── session.py             # shared HMAC session tokens
│   ├── requirements.txt
│   └── .env.example           # reference for the older single-process layout
├── scripts/
│   ├── video_generator.py
│   └── image_generator.py
├── frontend/
│   ├── Dockerfile             # multi-stage: vite build → nginx
│   ├── nginx.conf             # SPA fallback + asset caching
│   ├── src/                   # React 18 + Vite 5
│   └── package.json
├── config/
│   └── settings.json
├── data/                      # bind-mounted; operator state (auth.json,
│   │                          # deliveries.json, devices.json, ...)
│   └── …
├── output/                    # bind-mounted; generated renders
│   ├── images/
│   └── videos/
├── templates/                 # bind-mounted; baseline + uploaded_*
├── docker-compose.yml         # production stack (3 services + Traefik labels)
├── .env.example               # checked in
├── .env.production            # NOT checked in — operator-filled
├── .dockerignore
├── .gitignore
├── CLAUDE.md
├── DEPLOYMENT.md              # legacy nginx/Caddy/systemd notes
└── DEPLOY.md                  # this file
```

---

## 10. Troubleshooting

| Symptom | First check |
|---|---|
| `app.yourdomain.com` shows Traefik 404 | Container is healthy but Traefik can't reach it. `docker network inspect traefik` should list `mastermind-frontend` as a member. |
| Login: "Network error. Could not reach the server." | Hard-refresh the page first. Then `curl -sI https://auth.yourdomain.com/health` from your laptop. If that's 200, your browser has a stale bundle. |
| Webhook never fires | In Meta dashboard, confirm the `messages` field is subscribed AND verify-token matches your env. `docker compose logs api \| grep webhook` shows every incoming hit. |
| Stage-2 media never sends | Check `docker compose logs api \| grep -E '\[(prompt-stage\|awaiting-reply\|inbound\|media-stage\|media-send)\]'`. If `[inbound]` never appears, Meta isn't subscribed to `messages`. If `[inbound]` appears but `[media-stage]` doesn't, the phone normalisation isn't matching — compare `data/deliveries.json` recipient_phone digits against the inbound's `from` digits. |
| `[startup] [WARN] PUBLIC_BASE_URL CHANGED` | Expected after every config bump; benign. Means the marker file's stored URL didn't match env. Cleared on next webhook hit. |
| ffmpeg errors in video generation | `docker compose exec api ffmpeg -version` to confirm the binary's in PATH. The Dockerfile installs the Debian ffmpeg package; if you need a newer build, swap to a `jrottenberg/ffmpeg` base. |
| Operator forgot password | Use the recovery key on the login page → "Forgot password?" → enter recovery key → set new password. The recovery key gets rotated; save the new one. |

For everything else: `docker compose logs --tail=200 <service>` is the first stop.

---

## 11. WhatsApp delivery pipeline — recap of what's deployed

This matches the architecture we built and validated end-to-end:

1. **Operator uploads a template** (image or video) via the Templates page.
2. **Operator connects a Google Sheet** (or pastes the public CSV URL). The Sheets page populates `data/recipients.json`.
3. **Operator clicks Generate Media** → `scripts/image_generator.py` or `scripts/video_generator.py` runs per row, producing one render per recipient in `output/`.
4. **Operator clicks Send Media on the Delivery page.** For each recipient with a render, a delivery row is created with `flow="two-step", stage="prompt", status="Queued"`.
5. **The worker picks up the row** → sends the approved text-only prompt template (`WHATSAPP_PROMPT_TEMPLATE`) with `{{1}}` bound to the recipient name → row → `Awaiting Reply`. Log: `[prompt-stage]` + `[awaiting-reply]`.
6. **Recipient replies anything on WhatsApp.** Meta posts to `/deliveries/whatsapp-webhook` with `value.messages[]`. The handler matches the phone to the awaiting row, sets `replied_at` + `inbound_message_id`, transitions to `stage="media", status="Queued"`. Log: `[inbound]` + `[media-stage]`.
7. **Worker picks up the row again** → calls `provider.send(force_freeform=True)` → ships the personalised image/video as a freeform media message inside Meta's 24-hour customer-service window. Row → `Media Sent`. Log: `[media-send]`.
8. **Meta posts status callbacks** (sent → delivered → read) — same webhook handler updates the row through `Delivered` → `Read`. Log: `[media-delivered]`.

Visible on the Delivery page: KPI cards for each state, filter chips for `Awaiting Reply` and `Media Sent`, the **WhatsApp Template & Flow** panel for switching between two-step and direct, the **Two-step Diagnostics** panel polled every 8s, and the **🧪 Simulate YES Reply** debug button on every `Awaiting Reply` row.

---

## 12. Decommissioning the Vercel + cloudflared stack

Once the VPS deploy is verified, the cloudflared quick-tunnel pipeline is dead weight:

```bash
# On your laptop:
# 1. Stop cloudflared.
powershell -NoProfile -Command "Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force"

# 2. (Optional) Delete the Vercel project — but only after the VPS is fully live.
#    Either via the dashboard or:
cd frontend && npx vercel remove automation-frontend --yes

# 3. Reset PUBLIC_BASE_URL in api/.env locally to your prod URL so any dev
#    run uses the same webhook URL as production (avoids stale tunnel URLs
#    in the marker file).
```

The trycloudflare rotation drill that's been the bulk of the recent friction is now retired.
