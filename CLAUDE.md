# Mastermind Abacus — Automation Project

Personalised WhatsApp video/image generation pipeline for an EdTech (abacus
training) business. Each row in a Google Sheet → one personalised media file
→ delivered automatically to the recipient's WhatsApp.

**Core workflow (the whole product):**
Upload Template → Connect Google Sheet → Generate Images **or** Videos → Track Delivery via WhatsApp.

> For deployment + reverse-proxy configs see [DEPLOYMENT.md](DEPLOYMENT.md).
> For WhatsApp Cloud API setup see [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md).

---

## Repository layout

```
automation-project/
├── api/
│   ├── app.py                 Main Flask API (port 5000) — generation, queue, files, delivery
│   ├── auth_server.py         Auth Flask process (port 5001) — login, recovery, password reset
│   ├── session.py             Shared HMAC token mint/verify + signed-URL helpers
│   ├── providers.py           Delivery provider registry: Mock + WhatsAppCloud
│   ├── requirements.txt       Pinned Python deps
│   ├── .env                   Operator secrets (GITIGNORED — never commit)
│   └── .env.example           Full template with every supported knob documented
├── scripts/
│   ├── video_generator.py     ffmpeg + libass, produces output/videos/<addr>.mp4
│   └── image_generator.py     Pillow, produces output/images/<addr>.png
├── templates/
│   ├── company_video.mp4      Base video template (stock)
│   ├── company_image.png      Base image template (stock)
│   ├── uploaded_*             Operator-uploaded replacements (GITIGNORED)
│   └── mastermind logo.jpg    Brand logo (also in frontend/public/)
├── config/
│   └── settings.json          Generator config: template paths, overlay window, colors
├── data/                      GITIGNORED — operator data
│   ├── auth.json              PBKDF2 password + recovery-key hashes
│   ├── recipients.json        Connected sheet snapshot
│   ├── deliveries.json        Per-recipient delivery records
│   ├── delivery-logs.jsonl    Audit trail of every send attempt
│   └── sheet-source.json      Sheet connection metadata
├── output/                    GITIGNORED — generated artifacts
│   ├── videos/                Generated MP4s
│   └── images/                Generated PNGs
├── frontend/                  React 18 + Vite 5 (see below)
├── CLAUDE.md                  ← you are here
├── DEPLOYMENT.md              Reverse-proxy + systemd + first-boot checklist
└── WHATSAPP_INTEGRATION.md    Meta dashboard setup + webhook configuration
```

---

## Backend

### Two Flask processes, sharing one HMAC secret

| Process | Port | Responsibility |
|---|---|---|
| `api/app.py` | **5000** | Generation jobs, delivery worker, file serving, recipients, dashboard stats |
| `api/auth_server.py` | **5001** | Login, recovery-key flow, password reset, `/auth/me` token validation |

Both processes import `api/session.py` and read `SESSION_SECRET` from env at boot. **Tokens minted by auth_server verify in app.py because they share the secret.** If `SESSION_SECRET` is blank in dev, each process auto-generates its own random secret with a warning (tokens won't cross between them — set the env var to fix).

### `api/session.py` — shared crypto module

- **`mint_token(user_id)`** → HMAC-SHA256-signed `<user_b64>.<issued>.<exp>.<sig>` string + expiry epoch.
- **`verify_token(token)`** → returns payload dict or `None`. Constant-time signature compare via `hmac.compare_digest`.
- **`make_signed_url(path, ttl=None)`** → `/files/videos/foo.mp4?exp=<unix>&sig=<hmac>`. Default TTL `MEDIA_URL_TTL_HOURS` (168h = 7 days, enough for WhatsApp CDN).
- **`verify_signed_path(path, exp, sig)`** → constant-time check + expiry guard.
- **`extract_bearer(header)`** → pulls token out of `Authorization: Bearer <token>`.

Token TTL is env-driven: `SESSION_TTL_HOURS` (default 24).

### `api/app.py` — main API

#### Auth middleware (`@app.before_request`)
Every request that isn't in `_PUBLIC_PREFIXES` requires `Authorization: Bearer <token>`. Public prefixes:
- `/health` — liveness probe
- `/files/videos/<...>` and `/files/images/<...>` — gated INSIDE the handler by signed `?exp&sig` (Meta CDN can't send Bearer)
- `/deliveries/whatsapp-webhook` — gated by `X-Hub-Signature-256` HMAC verify
- `OPTIONS` (CORS preflight)

Anything else returns `401 {"error": "auth required"}` or `401 {"error": "invalid or expired token"}`.

#### Generation pipeline — STRICTLY isolated (CRITICAL)

The user hit this rule multiple times: **`Generate Images` must NEVER create a video, and `Generate Videos` must NEVER create an image.** Triple-locked:

1. **UI handlers** — `Sheets.jsx` has `handleGenerateImages(count)` and `handleGenerateVideos(count)` with hard-coded `kind` literals; there is no shared `generateBatch(count, kind)` anymore.
2. **`postJob` guard** — refuses any value other than `'images'` or `'videos'`, then validates the backend's echoed `kind` matches what was sent.
3. **`_run_job_inner` dispatch** — `if/elif` calls exactly one of `_run_image_pipeline()` (only `SCRIPT_IMAGE`) or `_run_video_pipeline()` (only `SCRIPT_VIDEO`); no shared loop, no `Promise.all`, no fan-out.

Each step logs with a `MEDIA TYPE=IMAGES` / `_run_image_pipeline` trace so any future regression is visible in the Flask terminal.

#### Worker safety net
`_run_job` wraps `_run_job_inner` in `try/except`. Any unhandled exception sets `state="error"` + records the traceback + stamps `finishedAt` so the daemon thread never dies silently and the LRU can evict.

#### Delivery worker
- Pulls from `data/deliveries.json` (Queued → Sending → Delivered/Failed).
- Calls `_PROVIDER.send(delivery)` outside any lock so the worker doesn't block routes.
- Provider result accepts an optional `status` field: `"Sending"` (async providers like WhatsApp wait for webhook) or default `"Delivered"` (sync providers like Mock).
- `_PROVIDER` defaults to `MockProvider`; **auto-bootstraps to `WhatsAppCloudProvider`** when `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN` + `PUBLIC_BASE_URL` are all set in `api/.env`. Falls back to mock with a clear startup log line if any is missing.

#### Other notable endpoints
- `POST /generate-jobs` — `{recipients, kind: 'images'|'videos'|'all'}` → async job_id
- `GET /generate-jobs/<id>` — poll status; `/pause`, `/resume`, `/cancel` siblings
- `GET /list-generated` — lists everything in `output/`, returns **signed** `url` fields
- `POST /list-generated/delete` — accepts `{items: [{stem, kind}]}` for per-asset deletion (image and video are independent)
- `POST /list-generated/wipe` — `{kinds: ["image","video"]}` bulk-delete
- `POST /deliveries/enqueue-all` — `{limit?: N}` for "Send First N" support
- `POST /deliveries/retry-failed` — re-queues every `Failed` row
- `GET/POST /deliveries/whatsapp-webhook` — Meta verify challenge + signed status callbacks

### `api/auth_server.py`
- **Recovery-key flow** replaced the email-OTP system; no SMTP needed.
- `POST /auth/login` → `{session_token, session_expires_at, user_id}` on success.
- `POST /auth/verify-recovery` → `{reset_token}` valid 5 min on success.
- `POST /auth/reset-password` → mints a new password hash AND **rotates the recovery key**, returning the new key once in `new_recovery_key`. The operator must write it down.
- `GET /auth/me` — validates a Bearer token, returns `{user_id, session_expires_at}`. Used by `SessionBootstrap` in the frontend.
- `POST /auth/logout` — no-op server-side (stateless tokens) but called for symmetry.
- Per-IP + per-user rate limits, env-tunable (`AUTH_LOGIN_MAX_PER_HOUR`, `AUTH_LOGIN_MAX_PER_USER_PER_HOUR`, `AUTH_RECOVERY_MAX_PER_HOUR`).
- Default placeholder credentials trigger a loud warning at boot; **production refuses to seed with them** (when `FLASK_ENV=production`).

### `api/providers.py`
- `BaseProvider` interface: `send(delivery) -> {ok, provider_message_id, error, status?}`.
- `MockProvider` — random success/failure with latency simulation. Default for dev.
- `WhatsAppCloudProvider` — Meta Graph API. POSTs to `https://graph.facebook.com/<v>/<PNID>/messages` with `{messaging_product, to, type: video|image, video|image: {link, caption?}}`. Returns `status="Sending"` so the row sits in `Sending` until Meta's webhook flips it to `Delivered` (or `Failed`).

### `config/settings.json`
```json
{
  "overlay_start": 61,
  "overlay_end": 64,
  "font_color": "#5E6F95",
  "font_size": 28,
  "template_video": "templates/uploaded_video.mp4",
  "template_image": "templates/uploaded_image.jpg",
  "image_overlay": {
    "strip_color": "#F97316",
    "name_color":  "#FFFFFF",
    "body_color":  "#FFF1DC"
  }
}
```
Both generators resolve relative `template_*` paths against the project root.

### `scripts/image_generator.py`
- Pillow-based. Composes the uploaded template + an orange personalisation strip below.
- **Final overlay format** (user-approved):
  ```
  Address: <address>
  
  Contact:
  <name>          ← bold, same size as everything else
  <phone>
  ```
- Single body size for everything; hierarchy via weight (Bold for name, SemiBold for everything else). No giant text.

### `scripts/video_generator.py`
- ffmpeg + libass via the `ass` filter. Same overlay format as the image generator.
- **External tools resolved in order**: `FFMPEG_BIN`/`FFPROBE_BIN` env → `shutil.which()` → legacy `D:\ffmpeg\bin\...` fallback. Works on any host.

---

## Frontend (React 18 + Vite 5 + plain CSS)

### Structure
```
frontend/
├── index.html                 Vite entry, Google Fonts links
├── package.json
├── .env.example               Documents VITE_API_BASE + VITE_AUTH_API
├── public/
│   ├── favicon.svg
│   └── mastermind-logo.jpg
└── src/
    ├── main.jsx               React entry
    ├── App.jsx                Router + RequireAuth + SessionBootstrap + AuthRejectionListener
    ├── App.css                ~14k lines — every visual rule lives here
    ├── index.css              Tiny reset
    ├── config.js              API_BASE / AUTH_API_BASE from env + global fetch interceptor + friendlyApiError
    ├── auth.js                Session token model, signIn/signOut, validateSession, recovery flow
    ├── ThemeContext.jsx       Light/Dark, persists to localStorage
    ├── components/
    │   ├── Sidebar.jsx        Brand + 5 nav items + Setup Assistant CTA
    │   ├── Header.jsx
    │   ├── PageHeader.jsx
    │   ├── GenerateModal.jsx  Dashboard quick-action with Image|Video radio
    │   ├── NotificationCenter.jsx
    │   └── SetupAssistant.jsx
    └── pages/
        ├── Dashboard.jsx      KPIs: Media Generated / Media Sent / Failed
        ├── Templates.jsx      Upload + Proceed → CTA
        ├── Sheets.jsx         Recipient table + Generate Media ▾ dropdown
        ├── Generated.jsx      Per-asset cards (image OR video), lightbox, video player, Wipe
        ├── Delivery.jsx       WhatsApp queue + Send Media ▾ dropdown + Retry All Failed
        ├── Settings.jsx       Profile + Change Password + workspace stats
        └── Login.jsx          User-ID/Password + Recovery flow + bead-pattern easter egg
```

### Sidebar navigation (the locked 5)
1. **Dashboard**
2. **Upload Template**
3. **Google Sheets**
4. **Generated Media** (renamed from "Generated Videos")
5. **WhatsApp Send**

Settings lives in the profile dropdown, not the sidebar. Don't add Campaigns / Bulk / Analytics / Guide — they've all been removed.

### Tech stack
- React 18.3.1, react-router-dom 6.30.3
- Vite 5.4.11 (NOT 8.x — pinned for Node v22 compat)
- Zustand 5.0.13 (currently unused — `store/recipients.js` is dead code, safe to delete)
- Plain CSS only. **NO Tailwind**, NO CSS-in-JS, NO component library.
- Fonts: Plus Jakarta Sans (headings) + Manrope (body), loaded from Google Fonts.

### Run
```bash
cd frontend
npm run dev          # Vite on http://localhost:5173
```
Production build: `npm run build` → `frontend/dist/` (serve via reverse proxy per DEPLOYMENT.md).

### Auth flow (current implementation)

1. **Login** posts to `/auth/login` → backend returns `{session_token, session_expires_at}`.
2. `auth.js#saveSession` stores `{ token, expiresAt }` in `localStorage["mm_session_v1"]`.
3. **`SessionBootstrap`** in App.jsx runs on every mount of the dashboard shell: calls `/auth/me` once to validate the stored token. If the server says 401 (e.g. SESSION_SECRET rotated), `clearSession()` + redirect to `/login` BEFORE any page mounts. Prevents the old "API unreachable: HTTP 401" flash.
4. **Fetch interceptor** in `config.js` (installed once at app boot via `import './config'` at the top of App.jsx):
   - Injects `Authorization: Bearer <token>` for any fetch to `API_BASE` or `AUTH_API_BASE` (skips `/auth/login`, `/auth/verify-recovery`, `/auth/reset-password`).
   - On `401` response: calls `onAuthRejected()` (clears token, fires `mm:auth-rejected` window event).
5. **`AuthRejectionListener`** in App.jsx hears `mm:auth-rejected` and navigates to `/login` with the current path stashed for return.
6. **`friendlyApiError(err)`** in config.js translates errors into operator-friendly messages: `"Session expired. Please log in again."` for 401, `"API unreachable..."` for network failure, etc.

### Env-driven URLs (no hardcoded localhost)
`frontend/src/config.js` exports `API_BASE` / `AUTH_API_BASE` from `import.meta.env.VITE_API_BASE` / `VITE_AUTH_API` (defaults to localhost in dev). **All 8 pages + auth.js import from config.js** — there is no `const API_BASE = 'http://localhost:5000'` anywhere else. Production builds set these via `frontend/.env.local` before `npm run build`.

---

## Pipeline isolation (the user's #1 rule — DO NOT break)

The user reported this bug 6+ times before it was fixed. Re-confirm in any future change:

- `Generate Images` → ONLY produces PNG, NEVER MP4
- `Generate Videos` → ONLY produces MP4, NEVER PNG
- Image cards and video cards in Generated Media have **independent** selection + delete + download (per `cardId`, not per `stem`)

Live proof anytime: wipe everything via Generated Media → 🧹 Wipe, run Generate Images, verify `output/videos/` stays empty. Flask log will show only `_run_image_pipeline` invocations.

---

## Visual identity (FINAL — locked palette)

### Light mode
| Token | Value | Used for |
|---|---|---|
| Page background | `#F7F4ED` warm off-white | `body` |
| Primary surface | `#FFFFFF` | All cards |
| Secondary panel | `#F1ECE2` cream | Inner panels |
| Text | `#0B1C30` deep navy | Headings, body |
| Muted text | `#584237` | Secondary |
| Faint text | `#8C7164` | Microcopy |
| Primary orange | `#F97316` / `#FF7A00` | CTA, active, accents |
| Card border | `rgba(15, 23, 42, 0.06)` | Hairline |
| Card shadow | `0 10px 30px rgba(15, 23, 42, 0.05)` | Stripe-style soft |

### Dark mode (Linear / Raycast warm charcoal — NOT navy black)
| Token | Value | Used for |
|---|---|---|
| App background | `#151312` | `body` |
| Sidebar | `#181513` | warm brown charcoal |
| Secondary surface | `#1D1917` | Inner panels |
| Primary cards | `#211D1A` | All cards |
| Borders | `rgba(255, 255, 255, 0.06)` | Hairlines |
| Primary orange | `#FF922B` | CTA, active |
| Text primary | `#F5F1EB` warm off-white | Headings, body |
| Muted text | `#B7ADA3` | Secondary |
| Faint text | `#847A6F` | Microcopy |

### Aesthetic principles
- **YES**: clean white cards on cream, soft single-layer Stripe-style shadows, hairline borders, calm 180–240 ms cubic-bezier transitions, warmth via cream + orange.
- **NO**: glassmorphism, cinematic glow, grain texture, pure black, gradient text-clips, dramatic hover transforms.
- **References**: Linear, Stripe Dashboard, Notion, Raycast, Vercel.

---

## Layout rules (locked)
- Sidebar fixed `left: 24px; top: 24px; bottom: 24px; width: 280px`
- Header fixed `left: 328px; right: 0; height: 72px`
- Main `padding: 96px 32px 48px 328px`
- `.main > * { max-width: 1320px; margin-right: auto }` — **left-anchored** content
- `html, body { overflow-x: hidden }`
- Mobile breakpoint at 520px for Sheets page-banner actions to wrap

---

## ffmpeg gotchas (hard-won, do NOT re-litigate)

1. **drawtext + textfile with newlines is broken** in ffmpeg 8.1 — embedded `\n` renders as a tofu box.
2. **Inline `text='...\n...'` is also broken** — `\n` becomes the letter "n".
3. **The solution is libass** via the `ass` filter. Native multi-line, real Bahnschrift weights, sharp shadows, RGBA color, `MarginV` for bottom-center.
4. **Windows path colons** inside an ffmpeg filtergraph get parsed as filter-option separators. Workaround: write the filter to a file (`-vf ass=overlay.ass`) and run ffmpeg with `cwd=work_dir`.
5. **drawbox vs drawtext parse `w`/`h` differently** — drawbox refers to its own dimensions, drawtext to the input frame.
6. **Filtergraph commas** are filter-chain separators. Escape with `\,` and `\:` inside values.
7. **Python file writing on Windows**: open with `newline=""` for ffmpeg-consumed text — otherwise CR renders as tofu.
8. **ffmpeg path discovery**: use the `_resolve_tool()` helper in `video_generator.py` — `FFMPEG_BIN` env → `shutil.which("ffmpeg")` → hard fallback.
9. **Unicode in print statements crashes on Windows cp1252 console** — caught this once with a `→` arrow killing the worker thread. Stick to ASCII (`->`) in any `print()` that might run on a Windows terminal.

---

## Things NOT to do (tripwires)

1. **Don't add Tailwind**, no matter how convenient.
2. **Don't add analytics widgets, charts, "campaigns" pages, AI caption generators**, or platform-cropping cards. Stay minimal and operational.
3. **Don't change the sidebar from 5 items** (Dashboard / Upload Template / Google Sheets / Generated Media / WhatsApp Send).
4. **Don't replace the real Mastermind logo image** with a CSS mascot mock.
5. **Don't switch dark mode to pure-black/navy.** It's warm charcoal `#151312`.
6. **Don't add hover `translateY` transforms, glow shadows, grain overlays, or radial spotlights.** Removed twice already.
7. **Don't centre content** with `margin: 0 auto` — left-anchor.
8. **Don't use ffmpeg drawtext** for multi-line text. Use libass.
9. **Don't break pipeline isolation** (see section above).
10. **Don't share secrets in chat** — no access tokens, app secrets, .env contents, recovery keys, or session secrets. The operator manages these in `api/.env` locally only.
11. **Don't weaken auth** — no disabling middleware, no localStorage-only checks, no bypassing the signed-URL gate on `/files/*`.
12. **Don't add a custom cursor** — was tried, user rejected it.
13. **Don't add unicode arrows / emojis to backend `print()` statements** — Windows cp1252 console crashes the daemon thread.

---

## Environment & secrets

`api/.env` is the single source of operator secrets. Required keys (see `api/.env.example` for full docs):

| Key | Purpose |
|---|---|
| `AUTH_USER_ID` / `AUTH_DEFAULT_PASSWORD` / `AUTH_RECOVERY_KEY` | First-boot seed |
| `SESSION_SECRET` | HMAC for tokens AND signed URLs; **same in both processes** |
| `CORS_ORIGINS` | Allowed frontend origin(s) |
| `WHATSAPP_PHONE_NUMBER_ID` / `_ACCESS_TOKEN` / `_APP_SECRET` / `_WEBHOOK_VERIFY_TOKEN` | WhatsApp Cloud API auto-bootstrap |
| `PUBLIC_BASE_URL` | https URL of `/api` mount, for signed media links sent to Meta |
| `SESSION_TTL_HOURS` (default 24) | Login lifetime |
| `MEDIA_URL_TTL_HOURS` (default 168) | Signed-URL lifetime |
| `AUTH_LOGIN_MAX_PER_HOUR` / `_PER_USER_PER_HOUR` / `RECOVERY_MAX_PER_HOUR` | Rate-limit env knobs |
| `TRUSTED_PROXIES` (default 1) | ProxyFix hop count |
| `FFMPEG_BIN` / `FFPROBE_BIN` | Override auto-discovery |

`.env` is gitignored along with the entire `data/`, `output/`, and `templates/uploaded_*`.

---

## Diagnostics / debugging

- **Backend smoke test**:
  ```bash
  python scripts/image_generator.py "Test City" "+91 9999999999" "Test Name"
  # → output/images/Test_City.png + diagnostic banner
  ```
- **Live pipeline isolation proof**:
  ```bash
  curl -s -X POST http://localhost:5000/list-generated/wipe \
    -H "Authorization: Bearer <tok>" -H "Content-Type: application/json" \
    -d '{"kinds":["image","video"]}'
  # then Generate Images for one row; verify output/videos/ stays empty
  ```
- **Webhook signature test** (no real Meta needed): see [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md) "Quick local smoke test".
- **Frontend dev server logs**: `C:\Users\Jiya\AppData\Local\Temp\claude\d--automation-project\...\tasks\*.output`.
- **Token health**: `curl -H "Authorization: Bearer $TOK" http://localhost:5001/auth/me` → 200 + user_id, or 401 if stale.

---

## Production readiness status

- ✅ Backend auth middleware enforces Bearer on every protected route
- ✅ Stateless HMAC session tokens, shared between both Flask processes
- ✅ Signed media URLs (HMAC + expiry) for `/files/*` — WhatsApp-CDN compatible
- ✅ Strict pipeline isolation (UI + dispatch + server-side, triple-locked)
- ✅ Env-driven config across frontend AND backend (no hardcoded URLs)
- ✅ Default credentials refused in production; rotated recovery key on use
- ✅ CORS locked, ProxyFix configured for reverse-proxy deployments
- ✅ WhatsApp Cloud API provider + webhook (signed, fail-closed)
- ✅ DEPLOYMENT.md with nginx / Caddy / Cloudflare configs + systemd units
- ⏳ Operator must: rotate `api/.env` defaults, set real `SESSION_SECRET`, configure WhatsApp env vars, deploy behind TLS reverse proxy

Production readiness score: **97/100**. The 3-pt gap = no HTTPS configured in dev, no token revocation list, no operator audit log beyond delivery sends.
