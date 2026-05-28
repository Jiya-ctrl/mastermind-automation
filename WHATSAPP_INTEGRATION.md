# WhatsApp Business Cloud API — Integration Guide

This is the deploy + verify playbook for plugging the production WhatsApp
Cloud API into the Mastermind Abacus delivery pipeline.

For the broader deployment setup (TLS, nginx, systemd), see
[DEPLOYMENT.md](DEPLOYMENT.md). This document only covers the WhatsApp
provider switch + webhook wiring.

---

## Architecture at a glance

```
┌─────────────────────────────────┐
│   Operator clicks "Send All"     │
│   on the Delivery page           │
└──────────────┬──────────────────┘
               │ POST /deliveries/enqueue-all
               ▼
┌─────────────────────────────────┐         queue
│   _enqueue_recipients            │ ─────► data/deliveries.json
└─────────────────────────────────┘            │
                                               ▼
┌─────────────────────────────────┐
│   delivery-worker (thread)       │
│   _worker_loop pulls Queued      │
│   rows, calls _PROVIDER.send(d)  │
└──────────────┬──────────────────┘
               │ POST graph.facebook.com/<v>/<PNID>/messages
               ▼                              { "messaging_product":"whatsapp",
┌─────────────────────────────────┐             "to":"<digits>",
│   Meta WhatsApp Cloud API        │             "type":"video",
│   accepts + replies              │             "video":{"link":"<signed-url>"} }
│   { messages:[{ id:"wamid…" }] } │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│   _record_send_result           │
│   status="Sending", wamid stored │
└─────────────────────────────────┘
               .
               .  (asynchronously, later)
               .
┌─────────────────────────────────┐
│   Meta CDN sends webhook         │  POST /api/deliveries/whatsapp-webhook
│   { entry: [{ changes: [{ value: │  X-Hub-Signature-256: sha256=<hmac>
│     statuses: [{ id, status,    │
│       timestamp, errors? }] }]}]}│
└──────────────┬──────────────────┘
               │ HMAC-SHA256 verified
               ▼
┌─────────────────────────────────┐
│   _apply_webhook_status         │
│   Sending → Delivered / Failed   │
│   (state machine respects        │
│    Meta's out-of-order events)   │
└─────────────────────────────────┘
```

Critical invariants:
- **`/files/videos/*` and `/files/images/*` URLs are HMAC-signed** with `?exp&sig` query params (TTL = `MEDIA_URL_TTL_HOURS`, default 7 days). Meta's CDN fetches them within that window.
- **The webhook is unauthenticated by Bearer token** (Meta can't send one) but cryptographically verified via `X-Hub-Signature-256` (HMAC over the raw body, key = `WHATSAPP_APP_SECRET`). Missing or wrong signature → `403`. **Fail-closed**: if `WHATSAPP_APP_SECRET` isn't configured at all, every webhook request is rejected.
- **Tokens are stateless** — auth carries no operator state to corrupt; the WhatsApp integration is independent of session/login.

---

## Meta dashboard configuration

### 1. Create a Meta Business app

1. Go to <https://developers.facebook.com/apps>
2. Click **Create app** → **Business** → name it (e.g. "Mastermind Abacus Delivery")
3. After creation, click **WhatsApp** → **Set up** in the left sidebar.

### 2. Get credentials

In **WhatsApp → API Setup**:

| Env var | Where to find it |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | "Phone number ID" — directly visible on the API Setup page |
| `WHATSAPP_ACCESS_TOKEN` | "Temporary access token" for dev; for prod create a **System User Access Token** under **Business Settings → Users → System Users → Generate New Token**. Grant `whatsapp_business_messaging` + `whatsapp_business_management` permissions. |
| `WHATSAPP_APP_SECRET` | **App Settings → Basic → App Secret** (click "Show") |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | **You** pick this. Any strong random string. You'll paste the SAME value into Meta in the next step. |

Generate the verify token with:
```bash
python -c "import secrets; print(secrets.token_urlsafe(24))"
```

### 3. Configure the webhook

In **WhatsApp → Configuration → Webhook → Edit**:

| Field | Value |
|---|---|
| Callback URL | `https://<your-host>/api/deliveries/whatsapp-webhook` |
| Verify token | The same string you used for `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |

Click **Verify and save**. Meta sends a one-time `GET` with `hub.challenge` — our handler echoes it back when the verify token matches. If you see "Failed to verify", check the Flask log: `[webhook] verify challenge REJECTED (mode=..., token match=...)`.

Then under **Webhook fields** click **Manage** → subscribe to:
- `messages` — incoming reply messages (we don't process these yet but you may want them later)
- `message_template_status_update` (optional)
- And critically the **statuses** field on the `messages` object → **subscribe**.

Without subscribing to `statuses` no delivery webhooks will fire.

### 4. Set production env vars

Add to `api/.env`:

```bash
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_ACCESS_TOKEN=EAA...your-system-user-token
WHATSAPP_APP_SECRET=hex-string-from-app-settings
WHATSAPP_WEBHOOK_VERIFY_TOKEN=same-string-you-pasted-into-meta
WHATSAPP_MEDIA_KIND=video      # or "image"
PUBLIC_BASE_URL=https://<your-host>/api
```

Restart `api/app.py`. You should see in the log:
```
[startup] delivery provider: whatsapp
```

If it falls back to `mock` with a `WhatsApp provider bootstrap FAILED` line, one of the four required vars is missing or malformed.

---

## Required callback URL

Single endpoint, both `GET` (Meta verify) and `POST` (status events):

```
https://<your-host>/api/deliveries/whatsapp-webhook
```

If you proxy the Flask backend under a different path (not `/api`), adjust accordingly — the route inside Flask is `/deliveries/whatsapp-webhook`.

---

## Status mapping

| Meta `statuses[].status` | Our `delivery.status` | Notes |
|---|---|---|
| `sent` | `Sending` | Meta's edge node accepted, in transit |
| `delivered` | `Delivered` | Reached the recipient's WhatsApp client |
| `read` | `Delivered` | Recipient opened. We don't track Read separately (yet). |
| `failed` | `Failed` | Permanent failure. Operator can hit Retry. |

The state machine refuses to downgrade `Delivered → Sending` even if Meta sends an out-of-order `sent` event (sometimes happens during their edge replay).

---

## Verifying the integration

### Quick local smoke test (no real WhatsApp account needed)

This proves the webhook signature path + status update plumbing — no Meta connection required.

```bash
# 1. Configure a fake but consistent WHATSAPP_APP_SECRET in api/.env:
#    WHATSAPP_APP_SECRET=test-secret-for-local-qa

# 2. Compute the expected signature for a sample payload:
PAYLOAD='{"entry":[{"changes":[{"value":{"statuses":[{"id":"wamid.FAKE","status":"delivered","timestamp":"1779360000"}]}}]}]}'
SIG=$(python -c "import hmac,hashlib,sys; print(hmac.new(b'test-secret-for-local-qa', sys.argv[1].encode(), hashlib.sha256).hexdigest())" "$PAYLOAD")

# 3. POST to the webhook with the signature:
curl -X POST http://localhost:5000/deliveries/whatsapp-webhook \
     -H "Content-Type: application/json" \
     -H "X-Hub-Signature-256: sha256=$SIG" \
     -d "$PAYLOAD"
# → {"status":"success","updated":0}   (0 because no row has wamid.FAKE — but signature accepted)

# 4. POST without signature → 403:
curl -X POST http://localhost:5000/deliveries/whatsapp-webhook \
     -H "Content-Type: application/json" -d "$PAYLOAD"
# → {"error":"invalid signature","status":"error"}
```

### Real end-to-end test

After Meta config + env setup:

1. Open the operator UI, log in.
2. Sheets → Generate Images for one recipient with a known phone number.
3. Delivery → click **Send Media ▾ → First 1** (or Send All).
4. Flask log should show:
   - `_worker_loop` pulls the queued row
   - WhatsApp provider sends, returns `wamid.xxxxx`
   - Row flips to `Sending`
5. Within ~2 seconds the operator's phone receives the WhatsApp message.
6. Flask log should show:
   - `[webhook] processed 1 status update(s)` (the `sent` callback)
   - Possibly another `delivered` callback right after.
7. Delivery page row pill flips to `Delivered`.

If steps 6-7 don't happen, the webhook isn't reaching you. Common causes:
- `PUBLIC_BASE_URL` doesn't actually resolve from the public internet
- Reverse proxy strips the request body before Flask sees it (signature fails)
- Meta's "Webhook fields" don't have `statuses` subscribed
- App is in dev mode and recipient phone isn't in the allowed test recipients list

---

## Deployment checklist (WhatsApp-specific)

Pre-flight:

- [ ] `PUBLIC_BASE_URL` resolves to your `/api` mount from the public internet (curl it from outside)
- [ ] Webhook callback URL set in Meta with matching `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- [ ] Subscribed to `messages.statuses` field in Meta
- [ ] `WHATSAPP_APP_SECRET` set in `api/.env` (signature verify will fail closed otherwise)
- [ ] System User Access Token used (not the 24h temporary token)
- [ ] First test recipient added in Meta's API Setup → Phone numbers → Add recipient (required while the app is in dev mode)
- [ ] App reviewed/approved by Meta if you want to send to non-test numbers
- [ ] `MEDIA_URL_TTL_HOURS` set ≥ 24 so Meta's CDN has time to fetch (default 168h = 7 days is fine)
- [ ] `_PROVIDER` resolves to `whatsapp` at boot (check `[startup] delivery provider: whatsapp` log)

After first real send:

- [ ] Status webhook arrives within 5s and updates the row
- [ ] `data/delivery-logs.jsonl` shows `webhook delivered` entries
- [ ] Failed deliveries park as `Failed`, not silently lost
- [ ] Retry All Failed re-queues without dupes

---

## Remaining production considerations

1. **Template messages for first contact** — Meta requires that the first
   message to a new number be a pre-approved template, NOT a free-form
   media message. Today's `WhatsAppCloudProvider.send()` only sends raw
   media. For first-contact flows, add a second method `send_template(...)`
   and decide which to call based on whether the recipient is in an
   active 24h conversation window.

2. **Rate limits** — Meta's Cloud API allows ~80 messages/second per
   phone-number ID for standard tier, much less while in dev mode. The
   worker is single-threaded so this is effectively rate-limited
   naturally; for scale add an explicit `time.sleep` between sends or
   use Meta's bulk-send endpoint.

3. **Media re-fetching** — Meta caches media URLs aggressively. If you
   re-render a recipient's video AFTER it's been sent, Meta will keep
   serving the cached version. Use `make_signed_url` with a shorter
   `ttl_seconds` for one-off re-sends, OR include a cache-busting
   timestamp in the filename.

4. **Webhook idempotency** — Meta retries failed webhooks with the same
   payload. `_apply_webhook_status` is idempotent (it writes the same
   target state every time), so retries are safe.

5. **Read receipts** — currently mapped to `Delivered`. If you want to
   surface "Read" separately, add a `Read` status to `_WHATSAPP_STATUS_MAP`
   and to the frontend filter chips.

6. **Conversation pricing** — Meta charges per 24h conversation window.
   Track `recipient_phone` against your billing dashboard; the delivery
   log already has the data needed for cost attribution.

---

## Final staging readiness status

**✅ READY for staging deployment**, provided:

1. `PUBLIC_BASE_URL` is reachable from Meta's network (a tunnel like
   `cloudflared tunnel` or `ngrok` works for first-stage testing without
   a full VPS setup).
2. All four `WHATSAPP_*` env vars set in `api/.env`.
3. Webhook callback URL configured in Meta and subscribed to `statuses`.
4. The four other deployment blockers from `DEPLOYMENT.md` are also met
   (TLS, real `SESSION_SECRET`, locked `CORS_ORIGINS`, non-default
   `AUTH_*`).

The integration adds **0 new dependencies** (uses the already-installed
`requests`), **0 frontend changes**, and **0 changes to the auth or media
generation systems**. The existing Delivery page UI, queue logic,
retry-failed flow, pause/resume worker, status pills, and per-asset
delete all work unchanged with the new provider.
