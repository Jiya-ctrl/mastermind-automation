# Deployment Guide — Mastermind Abacus Automation Studio

This is the production playbook for putting the app behind a TLS reverse
proxy with real auth, real secrets, and real per-IP attribution.

For day-to-day development, see [CLAUDE.md](CLAUDE.md). This document is
the deploy checklist only.

---

## Architecture

```
            ┌──────────────────────────┐
            │   TLS reverse proxy      │
            │   (nginx / Caddy / CF)   │
            │   * terminates HTTPS     │
            │   * sets X-Forwarded-*   │
            └────────────┬─────────────┘
                         │ (HTTP, same host)
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   /                /api/             /auth/
   frontend/dist    app.py            auth_server.py
   (static)         :5000             :5001
                    [ProxyFix]        [ProxyFix]
                    [Bearer gate]     [PBKDF2 + HMAC mint]
                         │                 │
                         └────── shared ───┘
                          SESSION_SECRET env
                          (HMAC over tokens
                          AND signed URLs)
```

Both Flask processes are private to the host (bind 127.0.0.1) and the
reverse proxy is the only public surface.

---

## Required environment

Copy `api/.env.example` → `api/.env` and fill in every required field.
Required for production (`FLASK_ENV=production`):

| Var | What | How |
|---|---|---|
| `AUTH_USER_ID` | First-boot operator user-id | Pick one |
| `AUTH_DEFAULT_PASSWORD` | First-boot password (changed in-app immediately) | Strong, 16+ chars |
| `AUTH_RECOVERY_KEY` | First-boot recovery key (rotated on first use) | Format `MA-XXXX-XXXX-XXXX` |
| `SESSION_SECRET` | HMAC secret for tokens AND signed URLs | `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `CORS_ORIGINS` | Allowed frontend origin(s), comma-separated | e.g. `https://app.mastermind.com` |
| `FLASK_ENV` | Set to `production` | Triggers strict-secret enforcement |

Optional but recommended:

| Var | Default | Notes |
|---|---|---|
| `SESSION_TTL_HOURS` | `24` | Lower for stricter posture |
| `MEDIA_URL_TTL_HOURS` | `168` | 7 days — wide enough for WhatsApp CDN |
| `AUTH_LOGIN_MAX_PER_HOUR` | `12` | Per-IP login attempts |
| `AUTH_LOGIN_MAX_PER_USER_PER_HOUR` | `8` | Per-user lockout (survives rotating IPs) |
| `AUTH_RECOVERY_MAX_PER_HOUR` | `5` | Per-IP recovery attempts |
| `TRUSTED_PROXIES` | `1` | Set higher if multiple proxies in front |
| `FFMPEG_BIN` / `FFPROBE_BIN` | auto-discover via `$PATH` | Override only if needed |

For the frontend, set `VITE_API_BASE` and `VITE_AUTH_API` to the public
URLs **before** `npm run build`. These get baked into the bundle at
build time.

---

## Reverse-proxy configs

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name app.mastermind-abacus.com;

    ssl_certificate     /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    # Static frontend (built with `npm run build` → frontend/dist)
    root /var/www/mastermind/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Main API
    location /api/ {
        proxy_pass http://127.0.0.1:5000/;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # Generated media can be large mp4s — bump these.
        client_max_body_size 250M;
        proxy_read_timeout   600s;
    }

    # Auth API
    location /auth-api/ {
        proxy_pass http://127.0.0.1:5001/;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}

server {
    listen 80;
    server_name app.mastermind-abacus.com;
    return 301 https://$host$request_uri;
}
```

If you proxy under `/api/` and `/auth-api/`, set the frontend env to
match: `VITE_API_BASE=https://app.mastermind-abacus.com/api`,
`VITE_AUTH_API=https://app.mastermind-abacus.com/auth-api`.

### Caddy

```caddy
app.mastermind-abacus.com {
    root * /var/www/mastermind/frontend/dist
    try_files {path} /index.html
    file_server

    handle_path /api/* {
        reverse_proxy 127.0.0.1:5000
    }
    handle_path /auth-api/* {
        reverse_proxy 127.0.0.1:5001
    }
}
```

Caddy auto-provisions TLS via Let's Encrypt and forwards
`X-Forwarded-For` by default.

### Cloudflare Tunnel

```yaml
# config.yml
ingress:
  - hostname: app.mastermind-abacus.com
    path: /api/.*
    service: http://localhost:5000
  - hostname: app.mastermind-abacus.com
    path: /auth-api/.*
    service: http://localhost:5001
  - hostname: app.mastermind-abacus.com
    service: file:///var/www/mastermind/frontend/dist
  - service: http_status:404
```

`cloudflared tunnel run` does the rest. Cloudflare populates
`CF-Connecting-IP` which ProxyFix reads via `X-Forwarded-For`.

---

## Process supervision

Don't use `app.run()` in production (it's the Werkzeug dev server). Use
a proper WSGI server:

### gunicorn (Linux)

```bash
# Install: pip install gunicorn
gunicorn --bind 127.0.0.1:5000 --workers 2 --threads 4 --timeout 600 \
    --chdir api app:app
gunicorn --bind 127.0.0.1:5001 --workers 1 --threads 4 \
    --chdir api auth_server:app
```

### waitress (Windows)

```bash
pip install waitress
waitress-serve --listen=127.0.0.1:5000 --threads=8 \
    --call --chdir=api app:app
```

### systemd unit (recommended)

```ini
# /etc/systemd/system/mastermind-app.service
[Unit]
Description=Mastermind Abacus API
After=network.target

[Service]
WorkingDirectory=/var/www/mastermind
EnvironmentFile=/var/www/mastermind/api/.env
ExecStart=/var/www/mastermind/.venv/bin/gunicorn \
    --bind 127.0.0.1:5000 --workers 2 --threads 4 --timeout 600 \
    --chdir api app:app
Restart=on-failure
User=mastermind
Group=mastermind

[Install]
WantedBy=multi-user.target
```

Mirror with `mastermind-auth.service` on `:5001`.

---

## First-boot checklist

1. Clone repo to `/var/www/mastermind` (or wherever).
2. `python -m venv .venv && source .venv/bin/activate`
3. `pip install -r api/requirements.txt`
4. Install ffmpeg + ffprobe at OS level. Verify `which ffmpeg`.
5. Copy `api/.env.example` → `api/.env`. Fill in every required value
   (placeholders trigger a loud warning; production refuses to seed with
   them).
6. `cd frontend && cp .env.example .env.local`. Set `VITE_API_BASE` and
   `VITE_AUTH_API` to the public proxy URLs. `npm install && npm run build`.
7. Configure nginx/Caddy (see above). Get TLS certs.
8. Start both Flask services via systemd (or whatever supervisor).
9. Verify:
   - `curl https://your-host/api/health` → `{"status":"ok"}`
   - Open `https://your-host/` in a browser, log in, you should land on Dashboard.
10. **Immediately** go to Settings → Change Password and rotate from the
    seed password. The default recovery key is also still active — trigger
    a recovery flow to rotate it (or just regenerate via the in-app flow
    after WhatsApp integration ships the dedicated key-rotation UI).

---

## Backup strategy

Three things to back up. Tier-1 = "if you lose this, the deployment is
ruined." Tier-2 = "if you lose this, you replay it."

| Tier | Path | What | Cadence | Method |
|---|---|---|---|---|
| 1 | `api/.env` | `SESSION_SECRET`, seed credentials | On change | Encrypted password manager (1Password / Bitwarden / Vault) |
| 1 | `data/auth.json` | Live PBKDF2 hashes | Daily | `rsync` to off-host, encrypted at rest |
| 1 | `data/deliveries.json` | Recipient list + delivery history | Hourly during business hours | `rsync` to off-host, retain 30 days |
| 2 | `data/recipients.json` | Connected Google Sheet snapshot | Hourly | Same as deliveries |
| 2 | `data/sheet-source.json` | Sheet connection metadata | On change | Tiny file; bundle with deliveries backup |
| 2 | `output/` | Generated media (regenerable from sheet) | Optional | Skip — cheaper to re-render |
| 2 | `templates/` | Master template + uploaded operator templates | On change | Object storage (S3 / R2) |
| 2 | `data/delivery-logs.jsonl` | Audit trail of every send attempt | Daily | Archive to cold storage; rotate after 90 days |

`SESSION_SECRET` must be backed up first — losing it logs every active
user out simultaneously AND invalidates every signed media URL still in
flight (WhatsApp would 403 on URLs minted before the key change).

Backup script skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST="backup@vault:/backups/mastermind/$(date +%F)/"
rsync -avz --delete \
    /var/www/mastermind/data/ \
    "$DEST"
# Keep 30 days of dailies, 90 days of weeklies, 1 year of monthlies.
```

Test the restore quarterly: spin up a fresh host, `rsync` data back,
boot the services, verify login works with the restored hash.

---

## Production hardening checklist

Before you announce the URL:

- [ ] `FLASK_ENV=production` set on both processes
- [ ] `SESSION_SECRET` set (48+ bytes, identical in both processes)
- [ ] `AUTH_USER_ID` / `AUTH_DEFAULT_PASSWORD` / `AUTH_RECOVERY_KEY` set to real values
- [ ] `CORS_ORIGINS` locked to the real frontend host (no localhost)
- [ ] TLS cert in front, HTTP → HTTPS redirect in place
- [ ] `ProxyFix` confirmed working (`curl -H "X-Forwarded-For: 1.2.3.4" https://host/api/health` and grep Flask log for the IP)
- [ ] Rate limits set (e.g. `AUTH_LOGIN_MAX_PER_HOUR=6`)
- [ ] Operator immediately ran Settings → Change Password after first login
- [ ] Operator triggered a recovery flow to rotate the default key
- [ ] `data/`, `api/.env`, `output/` all in `.gitignore` (already are)
- [ ] Backups scheduled and verified-restorable
- [ ] Monitoring: `/api/health` and `/auth-api/health` pinged every 60s
- [ ] Log forwarding: `journalctl -u mastermind-*` → centralised log store
- [ ] Disk-usage alert on `data/` and `output/` (renders accumulate fast)

If you can tick every box, you're production-grade.
