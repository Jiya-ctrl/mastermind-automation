"""Stateless session tokens shared by app.py and auth_server.py.

Design:
    HMAC-SHA256 over `f"{user_id}.{issued_at}.{expires_at}"`, base64url
    encoded. Format on the wire is:

        <user_id>.<issued_at>.<expires_at>.<sig>

    where all four parts are base64url-safe.

Why HMAC, not JWT:
    JWT brings claims, algorithms, parsing — none of which we need. A
    single-purpose HMAC token is smaller, faster to validate, and has
    zero algorithm-confusion attack surface.

Why stateless:
    auth_server.py (port 5001) issues tokens; app.py (port 5000) only
    verifies them. No shared database, no shared cache. Both processes
    just need to read the same `SESSION_SECRET` env var.

Secret:
    Read from SESSION_SECRET env var. If unset:
      - In dev (FLASK_ENV != 'production'): auto-generate a random
        32-byte secret per-process and warn. Tokens minted by one
        process won't verify in the other until a real secret is set,
        which is fine for a quick local run.
      - In production: refuse to start. Both processes must agree.
"""
import base64
import hmac
import hashlib
import os
import secrets
import time

_SECRET_BYTES_MIN  = 32             # 256-bit secret minimum

# Session TTL — operator-tunable. Default 24h; production deploys can
# shorten via SESSION_TTL_HOURS to e.g. 8 for a stricter posture.
try:
    _TOKEN_TTL_SECONDS = int(float(os.environ.get("SESSION_TTL_HOURS", "24")) * 3600)
except (TypeError, ValueError):
    _TOKEN_TTL_SECONDS = 24 * 60 * 60
if _TOKEN_TTL_SECONDS < 300:  # sanity floor — sub-5-min sessions break UX
    _TOKEN_TTL_SECONDS = 24 * 60 * 60

# Media URL TTL — separate knob because signed media links go to the
# WhatsApp CDN and may be fetched hours later from operator-owned
# infrastructure. Defaults to 7 days; tighten via MEDIA_URL_TTL_HOURS.
try:
    _MEDIA_TTL_SECONDS = int(float(os.environ.get("MEDIA_URL_TTL_HOURS", "168")) * 3600)
except (TypeError, ValueError):
    _MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60


def _load_secret():
    """Return the signing secret as raw bytes.

    Production: must be set via SESSION_SECRET (32+ bytes after decoding).
    Dev fallback: random per-process secret with a loud warning.
    """
    raw = (os.environ.get("SESSION_SECRET") or "").strip()
    if raw:
        # Accept either base64url-encoded or plain UTF-8. We just need
        # >=32 bytes of entropy after decoding.
        try:
            decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            if len(decoded) >= _SECRET_BYTES_MIN:
                return decoded
        except Exception:  # noqa: BLE001
            pass
        encoded = raw.encode("utf-8")
        if len(encoded) >= _SECRET_BYTES_MIN:
            return encoded
        # Too short — fall through to the dev fallback with a warning.
        print(
            f"[session] WARNING: SESSION_SECRET is too short ({len(encoded)} bytes) — "
            f"need at least {_SECRET_BYTES_MIN}. Falling back to a random per-process "
            "secret. Tokens will NOT cross between auth_server.py and app.py.",
            flush=True,
        )

    is_prod = (
        (os.environ.get("FLASK_ENV") or "").lower() == "production"
        or os.environ.get("VERCEL") == "1"
    )
    if is_prod:
        raise RuntimeError(
            "SESSION_SECRET env var is required in production or Vercel. Generate one with "
            "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"` and "
            "set the SAME value in both auth_server.py's environment AND app.py's "
            "environment. Without this, login tokens minted by one process cannot "
            "be verified by the other."
        )
    print(
        "[session] WARNING: SESSION_SECRET not set. Using a random per-process "
        "secret (dev fallback). Tokens minted by auth_server.py will NOT verify "
        "in app.py unless both processes share the same env. Set SESSION_SECRET "
        "in api/.env to fix.",
        flush=True,
    )
    return secrets.token_bytes(_SECRET_BYTES_MIN)


_SECRET = _load_secret()


def _b64url(b):
    """URL-safe base64 with stripped padding (RFC 4648 §5)."""
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64url_decode(s):
    """Inverse of `_b64url` — restores padding before decoding."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload):
    """HMAC-SHA256(secret, payload) → URL-safe base64 string."""
    sig = hmac.new(_SECRET, payload.encode("utf-8"), hashlib.sha256).digest()
    return _b64url(sig)


def mint_token(user_id, ttl_seconds=_TOKEN_TTL_SECONDS):
    """Mint a new session token for `user_id`.

    Returns: (token_str, expires_at_epoch_seconds).
    """
    if not user_id:
        raise ValueError("user_id is required")
    issued_at  = int(time.time())
    expires_at = issued_at + int(ttl_seconds)
    user_b64   = _b64url(str(user_id).encode("utf-8"))
    payload    = f"{user_b64}.{issued_at}.{expires_at}"
    token      = f"{payload}.{_sign(payload)}"
    return token, expires_at


def verify_token(token):
    """Verify a session token. Returns the decoded payload dict on success,
    or None on any failure (malformed, bad signature, expired).

    Constant-time signature comparison (hmac.compare_digest).
    """
    if not token or not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) != 4:
        return None
    user_b64, issued_str, expires_str, sig = parts
    payload = f"{user_b64}.{issued_str}.{expires_str}"

    # Constant-time check.
    expected_sig = _sign(payload)
    if not hmac.compare_digest(expected_sig, sig):
        return None

    try:
        issued_at  = int(issued_str)
        expires_at = int(expires_str)
        user_id    = _b64url_decode(user_b64).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None

    now = int(time.time())
    if now >= expires_at:
        return None

    return {
        "user_id":    user_id,
        "issued_at":  issued_at,
        "expires_at": expires_at,
    }


def extract_bearer(authorization_header):
    """Pull the token from an `Authorization: Bearer <token>` header.
    Returns the token string or None if the header is missing/malformed."""
    if not authorization_header:
        return None
    parts = authorization_header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


# =============================================================================
# Signed media URLs
#
# `/files/*` is public from the auth middleware's perspective — WhatsApp's
# CDN fetches those URLs from outside our network and cannot send a Bearer
# token. To prevent leaked URLs from being permanently usable, every URL
# is signed with HMAC + expiry. The file-serving handler in app.py rejects
# any request whose `?exp` is in the past or whose `?sig` doesn't match.
#
# Frontend code is untouched — it just receives `url` strings from
# /list-generated and /delivery-status that already include the query
# params. Browsers and CDNs honour them transparently.
# =============================================================================
def _sign_path(path, exp):
    """HMAC-SHA256(secret, f"{path}.{exp}") → base64url string."""
    payload = f"{path}.{exp}".encode("utf-8")
    sig = hmac.new(_SECRET, payload, hashlib.sha256).digest()
    return _b64url(sig)


def make_signed_url(rel_path, ttl_seconds=None):
    """Mint a signed URL for a `/files/...` path.

    Args:
      rel_path: URL path beginning with `/files/` (no scheme/host).
      ttl_seconds: override the default media TTL. None = use the
        MEDIA_URL_TTL_HOURS env default (7 days).

    Returns the path with `?exp=<unix>&sig=<base64url>` appended.
    """
    if not rel_path or not isinstance(rel_path, str):
        raise ValueError("rel_path is required")
    ttl = int(ttl_seconds) if ttl_seconds else _MEDIA_TTL_SECONDS
    exp = int(time.time()) + ttl
    sig = _sign_path(rel_path, exp)
    sep = "&" if "?" in rel_path else "?"
    return f"{rel_path}{sep}exp={exp}&sig={sig}"


def verify_signed_path(path, exp_str, sig):
    """Verify a signed URL. Returns True iff signature matches and not
    yet expired. Constant-time signature comparison."""
    if not path or not exp_str or not sig:
        return False
    try:
        exp = int(exp_str)
    except (TypeError, ValueError):
        return False
    if int(time.time()) >= exp:
        return False
    expected = _sign_path(path, exp)
    return hmac.compare_digest(expected, sig)
