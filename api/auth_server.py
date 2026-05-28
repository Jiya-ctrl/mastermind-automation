"""Standalone auth microservice for Mastermind Automation Studio.

Runs on port 5001. Self-contained — no shared state with api/app.py — so
restarting it never disturbs the dashboard backend on port 5000.

Recovery-key based authentication (no email, no SMTP, no OTP).

Routes:
    GET  /health
    POST /auth/login              { user_id, password }
    POST /auth/verify-recovery    { user_id, recovery_key }
    POST /auth/reset-password     { reset_token, new_password }
    POST /auth/change-password    { user_id, current_password, new_password }

Credentials live in data/auth.json (gitignored). Stored as
PBKDF2-HMAC-SHA256 hashes with per-field random salts. Defaults are
seeded from api/.env on first boot; after that the file is the source
of truth.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time

# --------------------------------------------------------------------------
# Early .env load — MUST run before `import session` so SESSION_SECRET from
# api/.env is in os.environ when session.py reads it at module-init time.
# Otherwise this process auto-generates a per-process random secret and
# tokens minted here won't verify in app.py (they share SESSION_SECRET).
#
# In Vercel serverless: skip file loading, environment variables come from
# the Vercel dashboard instead. VERCEL=1 is set by the platform.
# --------------------------------------------------------------------------
def _early_load_env():
    # Skip file loading in Vercel serverless — use dashboard env vars instead
    if os.environ.get("VERCEL") == "1":
        log_msg = "AUTH: Vercel serverless detected, skipping .env file load (using dashboard env vars)"
        try:
            log.info(log_msg)
        except NameError:
            print(f"[auth_server] {log_msg}")
        return
    
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.vercel")
    if not os.path.isfile(env_path):
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k, v = k.strip(), v.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:  # pragma: no cover
        pass

_early_load_env()

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

# Add current directory to path so we can import session.py
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Shared session signing — same module that api/app.py imports so tokens
# minted here verify there. Lives in api/session.py.
import session as _session


# =============================================================================
# Setup
# =============================================================================
app = Flask(__name__)
# Reverse-proxy header support — see app.py for the rationale. Trust one
# proxy hop by default; bump via TRUSTED_PROXIES env. CRITICAL for
# accurate per-IP rate limiting when this process is behind nginx /
# Caddy / Cloudflare: without ProxyFix, every request looks like it
# came from 127.0.0.1 and the rate limit is shared by all real clients.
try:
    _trusted_proxies = int(os.environ.get("TRUSTED_PROXIES", "1"))
except (TypeError, ValueError):
    _trusted_proxies = 1
app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=_trusted_proxies,
    x_proto=_trusted_proxies,
    x_host=_trusted_proxies,
    x_port=_trusted_proxies,
)

# CORS origin whitelist — defaults to the Vite dev server. Production
# deploys MUST set CORS_ORIGINS (comma-separated for multiple hosts).
_cors_origins_env = os.environ.get("CORS_ORIGINS", "http://localhost:5173").strip()
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
CORS(app, resources={r"/*": {"origins": _cors_origins}})

if os.environ.get("VERCEL") == "1":
    class VercelPrefixMiddleware:
        def __init__(self, app, prefix):
            self.app = app
            self.prefix = prefix
        def __call__(self, environ, start_response):
            path = environ.get("PATH_INFO", "")
            if path.startswith(self.prefix):
                environ["PATH_INFO"] = path[len(self.prefix):]
                environ["SCRIPT_NAME"] = self.prefix
            return self.app(environ, start_response)
    app.wsgi_app = VercelPrefixMiddleware(app.wsgi_app, "/auth-api")


# Global error handler for unhandled exceptions
@app.errorhandler(Exception)
def handle_error(e):
    """Catch all unhandled exceptions and return JSON error response."""
    import traceback
    trace = traceback.format_exc()
    log.error("UNHANDLED ERROR: %s\n%s", str(e), trace)
    response = {
        "ok": False,
        "error": "internal_error",
        "details": str(e),
    }
    if (os.environ.get("FLASK_ENV") or "").lower() != "production":
        response["traceback"] = trace
    return jsonify(response), 500


logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)-5s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("auth")

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
if os.environ.get("VERCEL") == "1":
    DATA_DIR = "/tmp"
else:
    DATA_DIR = os.path.join(PROJECT_ROOT, "data")
AUTH_FILE    = os.path.join(DATA_DIR, "auth.json")
DEVICES_FILE = os.path.join(DATA_DIR, "devices.json")
_ENV_PATH    = os.path.join(os.path.dirname(__file__), ".env.vercel")
if not os.path.isfile(_ENV_PATH):
    _ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")

PBKDF2_ITER  = 200_000


def _load_env_file():
    if os.environ.get("VERCEL") == "1":
        log.info("AUTH: Vercel serverless detected, skipping late .env file load")
        return
    if not os.path.isfile(_ENV_PATH):
        return
    try:
        with open(_ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                if k:
                    os.environ[k] = v
    except Exception as e:
        log.warning("env: could not load — %s", e)


_load_env_file()


# =============================================================================
# Credential store
# =============================================================================
_STORE_LOCK   = threading.Lock()
_RESET_TOKENS = {}            # token -> {user_id, expires_at}
_RESET_LOCK   = threading.Lock()
_RATE_LIMITS  = {}            # "action:ip" -> [timestamps]
_RATE_LOCK    = threading.Lock()
_DEVICES_LOCK = threading.Lock()


def _hash_credential(value: str, salt: str) -> str:
    """PBKDF2-HMAC-SHA256, 200k iterations. Stdlib-only — avoids the
    bcrypt/argon2 install dependency while still being slow enough to
    resist offline brute force for low-volume auth like this."""
    return hashlib.pbkdf2_hmac(
        "sha256",
        value.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITER,
    ).hex()


def _normalise_recovery_key(raw: str) -> str:
    """Strip dashes/whitespace, uppercase. So 'MA-9XK2-7PLQ-41ZT' and
    'ma 9xk2 7plq 41zt' and 'MA9XK27PLQ41ZT' all compare equal."""
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())


def _generate_recovery_key():
    """Mint a fresh, human-readable recovery key in `MA-XXXX-XXXX-XXXX`
    format. Uses Crockford-ish base32 alphabet (no I/O/0/1) so it's
    unambiguous when read off a sticky note."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 chars, no I/O/0/1
    body = "".join(secrets.choice(alphabet) for _ in range(12))
    return f"MA-{body[0:4]}-{body[4:8]}-{body[8:12]}"


def _rotate_recovery_key(store):
    """Generate a new recovery key, hash it into the store, return the
    plaintext ONCE so the caller can show it to the operator. Old hash
    is overwritten and the previous key becomes immediately invalid."""
    new_key = _generate_recovery_key()
    rk_salt = secrets.token_hex(16)
    store["recovery_key_hash"] = _hash_credential(_normalise_recovery_key(new_key), rk_salt)
    store["recovery_key_salt"] = rk_salt
    store["recovery_key_rotated_at"] = int(time.time())
    return new_key


def _read_store():
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_store(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = AUTH_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, AUTH_FILE)


# Placeholders shipped in api/.env.example — if any of these survives into
# a live deploy, the operator forgot to set real values. We loudly refuse
# to use them as the seed (or, in dev, warn and proceed).
_DEFAULT_USER_PLACEHOLDERS = {
    "", "mastermind_abc", "replace-with-operator-user-id",
}
_DEFAULT_PW_PLACEHOLDERS = {
    "", "master@123#", "change-me-on-first-boot",
    "replace-with-strong-password",
}
_DEFAULT_RK_PLACEHOLDERS = {
    "", "MA-9XK2-7PLQ-41ZT", "MA-XXXX-XXXX-XXXX",
}


def _seed_store():
    """First-boot seed from api/.env. Refuses placeholder values in
    production; warns and falls back to legacy defaults in dev."""
    user_id_env      = (os.environ.get("AUTH_USER_ID")          or "").strip()
    password_env     =  os.environ.get("AUTH_DEFAULT_PASSWORD") or ""
    recovery_key_env = (os.environ.get("AUTH_RECOVERY_KEY")     or "").strip()

    is_prod = (os.environ.get("FLASK_ENV") or "").lower() == "production"

    using_default_user = user_id_env in _DEFAULT_USER_PLACEHOLDERS
    using_default_pw   = password_env in _DEFAULT_PW_PLACEHOLDERS
    using_default_rk   = recovery_key_env in _DEFAULT_RK_PLACEHOLDERS

    if is_prod and (using_default_user or using_default_pw or using_default_rk):
        raise RuntimeError(
            "AUTH: refusing to seed the credential store with placeholder values "
            "in production. Set AUTH_USER_ID, AUTH_DEFAULT_PASSWORD, and "
            "AUTH_RECOVERY_KEY to real values in api/.env before first boot."
        )

    user_id      = user_id_env      or "mastermind_abc"
    password     = password_env     or "master@123#"
    recovery_key = recovery_key_env or "MA-9XK2-7PLQ-41ZT"

    if using_default_user or using_default_pw or using_default_rk:
        log.warning("=" * 72)
        log.warning("AUTH: ⚠  SEEDING WITH DEFAULT/PLACEHOLDER CREDENTIALS")
        log.warning("AUTH: ⚠  These MUST be changed before any non-localhost deploy.")
        log.warning("AUTH: ⚠  user_id     placeholder? %s", using_default_user)
        log.warning("AUTH: ⚠  password    placeholder? %s", using_default_pw)
        log.warning("AUTH: ⚠  recovery    placeholder? %s", using_default_rk)
        log.warning("AUTH: ⚠  Set AUTH_USER_ID / AUTH_DEFAULT_PASSWORD / "
                    "AUTH_RECOVERY_KEY in api/.env, delete data/auth.json, restart.")
        log.warning("=" * 72)

    pw_salt = secrets.token_hex(16)
    rk_salt = secrets.token_hex(16)
    store = {
        "user_id":           user_id,
        "password_hash":     _hash_credential(password, pw_salt),
        "password_salt":     pw_salt,
        "recovery_key_hash": _hash_credential(_normalise_recovery_key(recovery_key), rk_salt),
        "recovery_key_salt": rk_salt,
        "updated_at":        int(time.time()),
        "version":           1,
    }
    _write_store(store)
    log.info("AUTH: seeded data/auth.json (user_id=%s)", user_id)
    log.info("AUTH: recovery key set from .env (hidden in logs after this point)")
    return store


def _get_store():
    with _STORE_LOCK:
        data = _read_store()
        if data is None:
            data = _seed_store()
        return data


def _save_password(new_password: str):
    """Rotate the password. Generates a fresh salt — old hash is gone."""
    with _STORE_LOCK:
        data = _read_store() or _seed_store()
        salt = secrets.token_hex(16)
        data["password_hash"] = _hash_credential(new_password, salt)
        data["password_salt"] = salt
        data["updated_at"]    = int(time.time())
        _write_store(data)


# =============================================================================
# Helpers
# =============================================================================
def _client_ip():
    raw = request.headers.get("X-Forwarded-For") or request.remote_addr or "unknown"
    return raw.split(",")[0].strip()


# Per-action rate-limit ceilings — env-overridable so deploys can tighten
# without code changes. Defaults preserve the original 12/h login + 5/h
# recovery generous-for-dev posture; production should set both lower.
def _rate_env(name, default):
    try:
        val = int(os.environ.get(name, str(default)))
        return max(1, val)
    except (TypeError, ValueError):
        return default

_RATE_LOGIN_PER_HOUR    = _rate_env("AUTH_LOGIN_MAX_PER_HOUR",    12)
_RATE_RECOVERY_PER_HOUR = _rate_env("AUTH_RECOVERY_MAX_PER_HOUR",  5)
# Optional per-user account-level lockout (separate from per-IP throttle).
# Defaults to 8 failed login attempts per user per hour — survives proxy
# IPs that rotate, since it keys on user_id rather than client_ip.
_RATE_LOGIN_PER_USER_PER_HOUR = _rate_env("AUTH_LOGIN_MAX_PER_USER_PER_HOUR", 8)


def _check_rate(action, max_per_hour=8, window_sec=3600, key_suffix=None):
    """Sliding-window rate check. Keys on `{action}:{key_suffix or client_ip}`
    so callers can rate-limit per-IP OR per-user simply by passing
    `key_suffix=user_id`."""
    key_part = key_suffix if key_suffix is not None else _client_ip()
    key = f"{action}:{key_part}"
    with _RATE_LOCK:
        now    = time.time()
        bucket = [t for t in _RATE_LIMITS.get(key, []) if now - t < window_sec]
        if len(bucket) >= max_per_hour:
            oldest = min(bucket)
            retry_after_min = max(1, int((window_sec - (now - oldest)) / 60) + 1)
            _RATE_LIMITS[key] = bucket
            return False, retry_after_min
        bucket.append(now)
        _RATE_LIMITS[key] = bucket
        return True, None


def _password_meets_rules(pw: str) -> bool:
    if not pw or len(pw) < 8:                 return False
    if not re.search(r"[A-Z]", pw):           return False
    if not re.search(r"[a-z]", pw):           return False
    if not re.search(r"\d",   pw):            return False
    if not re.search(r"[^a-zA-Z0-9]", pw):    return False
    return True


def _verify_password(user_id: str, password: str) -> bool:
    data = _get_store()
    if (user_id or "").strip() != data["user_id"]:
        return False
    return _hash_credential(password, data["password_salt"]) == data["password_hash"]


def _verify_recovery_key(user_id: str, recovery_key: str) -> bool:
    data = _get_store()
    if (user_id or "").strip() != data["user_id"]:
        return False
    normalised = _normalise_recovery_key(recovery_key)
    return _hash_credential(normalised, data["recovery_key_salt"]) == data["recovery_key_hash"]


# =============================================================================
# Device-token store (per-browser quick-unlock keys)
#
# Goal: let the operator log in once manually on a browser, then complete
# the hidden abacus sequence to re-auth on subsequent visits without typing
# the password. Replaces the rejected approach of baking the password into
# the JS bundle.
#
# Threat model:
#   * Tokens are 32 random bytes (256-bit) so guessing is infeasible.
#   * Only hashes are stored server-side — devices.json leaking does NOT
#     leak working tokens.
#   * Plain SHA-256 (no salt) is sufficient because the input is already
#     uniformly random; salts only matter for low-entropy inputs.
#   * Each unlock attempt is rate-limited per-IP (shares the "login"
#     bucket) so brute-force is throttled even if entropy were lower.
#   * Token lookup is constant-time via `hmac.compare_digest` against
#     every stored hash, eliminating timing oracles.
# =============================================================================
def _hash_device_token(raw_token: str) -> str:
    """SHA-256 of a high-entropy token. Returns lowercase hex."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _read_devices():
    """Load devices.json or return a fresh empty record on first run."""
    try:
        with open(DEVICES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("devices"), list):
                return data
    except FileNotFoundError:
        pass
    except Exception as e:  # pragma: no cover
        log.warning("DEVICES: could not read %s — %s; starting fresh", DEVICES_FILE, e)
    return {"devices": []}


def _write_devices(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DEVICES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, DEVICES_FILE)


def _find_device_by_token(raw_token: str):
    """Constant-time lookup. Returns (record, index) on match, (None, -1)
    otherwise. Compares the candidate hash against every stored hash so
    a stopwatch attacker can't learn how many devices exist or how far
    into the list the match was."""
    target = _hash_device_token(raw_token)
    with _DEVICES_LOCK:
        store = _read_devices()
        match_idx  = -1
        match_rec  = None
        for i, rec in enumerate(store.get("devices", [])):
            stored = rec.get("token_hash") or ""
            # hmac.compare_digest needs equal-length inputs; pad/truncate
            # the stored side to the candidate length to keep it safe.
            if len(stored) != len(target):
                # Still spend the comparison time to avoid timing leak.
                hmac.compare_digest(target, target)
                continue
            if hmac.compare_digest(target, stored):
                match_idx = i
                match_rec = rec
                # Don't break — keep scanning for constant time.
        return match_rec, match_idx, store


def _bearer_user_id():
    """Extract + verify the Bearer session token on the current request.
    Returns the bound user_id or None if absent/invalid/expired."""
    token = _session.extract_bearer(request.headers.get("Authorization"))
    if not token:
        return None
    payload = _session.verify_token(token)
    if not payload:
        return None
    return payload["user_id"]


# =============================================================================
# Routes
# =============================================================================
@app.route("/health", methods=["GET"])
def health():
    data = _get_store()
    return jsonify({
        "status":  "ok",
        "service": "auth",
        "user_id": data["user_id"],
    })


@app.route("/auth/login", methods=["POST"])
def auth_login():
    try:
        data     = request.get_json(silent=True) or {}
        user_id  = (data.get("user_id")  or "").strip()
        password =  data.get("password") or ""
        log.info("AUTH: /auth/login from %s (user_id=%s)", _client_ip(), user_id or "<empty>")

        if not user_id or not password:
            return jsonify({"ok": False, "error": "invalid"}), 400

        # Per-IP throttle.
        allowed, retry_after = _check_rate("login", max_per_hour=_RATE_LOGIN_PER_HOUR)
        if not allowed:
            log.info("AUTH: ⚠ login rate-limit hit per-IP (retry in %dmin)", retry_after)
            return jsonify({"ok": False, "error": "rate_limit",
                            "retry_after_min": retry_after}), 429
        # Per-user lockout — survives rotating proxy IPs that might bypass the
        # per-IP limit. Keyed by submitted user_id so attackers can't lock out
        # other accounts by spamming wrong usernames (rate counts only
        # against the real user when keyed by user_id).
        allowed, retry_after = _check_rate(
            "login_user",
            max_per_hour=_RATE_LOGIN_PER_USER_PER_HOUR,
            key_suffix=user_id,
        )
        if not allowed:
            log.info("AUTH: ⚠ login rate-limit hit per-USER %s (retry in %dmin)", user_id, retry_after)
            return jsonify({"ok": False, "error": "rate_limit",
                            "retry_after_min": retry_after}), 429

        if not _verify_password(user_id, password):
            # Single combined error so we don't leak which half was wrong.
            return jsonify({"ok": False, "error": "invalid"}), 401

        # Stateless session token — same HMAC secret as api/app.py so the main
        # backend can verify without a shared database. Sent in the JSON body
        # (the frontend stores it and attaches it to every API call).
        token, expires_at = _session.mint_token(user_id)
        log.info("AUTH: ✅ login successful for %s (session expires at %d)", user_id, expires_at)
        return jsonify({
            "ok":                 True,
            "session_token":      token,
            "session_expires_at": expires_at * 1000,  # ms for JS
            "user_id":            user_id,
        })
    except Exception as e:
        import traceback
        trace = traceback.format_exc()
        log.error("AUTH: ❌ /auth/login crashed: %s\n%s", str(e), trace)
        response = {
            "ok": False,
            "error": "internal_error",
            "details": str(e),
        }
        if (os.environ.get("FLASK_ENV") or "").lower() != "production":
            response["traceback"] = trace
        return jsonify(response), 500


@app.route("/auth/verify-recovery", methods=["POST"])
def auth_verify_recovery():
    data         = request.get_json(silent=True) or {}
    user_id      = (data.get("user_id")      or "").strip()
    recovery_key =  data.get("recovery_key") or ""
    log.info("AUTH: /auth/verify-recovery from %s (user_id=%s)", _client_ip(), user_id or "<empty>")

    if not user_id or not recovery_key:
        return jsonify({"ok": False, "error": "invalid"}), 400

    allowed, retry_after = _check_rate("recovery", max_per_hour=_RATE_RECOVERY_PER_HOUR)
    if not allowed:
        log.info("AUTH: ⚠ recovery rate-limit hit (retry in %dmin)", retry_after)
        return jsonify({"ok": False, "error": "rate_limit",
                        "retry_after_min": retry_after}), 429

    if not _verify_recovery_key(user_id, recovery_key):
        log.info("AUTH: ❌ invalid recovery key for %s", user_id)
        return jsonify({"ok": False, "error": "invalid"}), 401

    token = secrets.token_urlsafe(32)
    with _RESET_LOCK:
        _RESET_TOKENS[token] = {
            "user_id":    user_id,
            "expires_at": time.time() + 5 * 60,
        }
    log.info("AUTH: ✅ recovery key verified for %s; reset token issued", user_id)
    return jsonify({"ok": True, "reset_token": token})


@app.route("/auth/reset-password", methods=["POST"])
def auth_reset_password():
    data         = request.get_json(silent=True) or {}
    token        = (data.get("reset_token")  or "").strip()
    new_password =  data.get("new_password") or ""
    log.info("AUTH: /auth/reset-password from %s", _client_ip())

    if not _password_meets_rules(new_password):
        return jsonify({"ok": False, "error": "weak"}), 400

    with _RESET_LOCK:
        entry = _RESET_TOKENS.pop(token, None)
    if not entry:
        return jsonify({"ok": False, "error": "invalid_token"}), 400
    if time.time() > entry["expires_at"]:
        return jsonify({"ok": False, "error": "invalid_token"}), 400

    # Rotate BOTH password and recovery key — the recovery key just got
    # used, so it's burned (no permanent backdoor). We hand the new key
    # back in the response ONCE; the operator must write it down before
    # closing the success screen. There is no way to retrieve it later
    # without using the still-active session to roll it again.
    with _STORE_LOCK:
        data = _read_store() or _seed_store()
        new_recovery_key = _rotate_recovery_key(data)
        # Save password change in the same write to keep the store atomic.
        pw_salt = secrets.token_hex(16)
        data["password_hash"] = _hash_credential(new_password, pw_salt)
        data["password_salt"] = pw_salt
        data["updated_at"]    = int(time.time())
        _write_store(data)
    log.info("AUTH: ✅ password reset for %s (old hash discarded, recovery key rotated)", entry["user_id"])
    # Issue a fresh session token so the user can land straight on the
    # dashboard after a recovery reset without re-typing the new password.
    token, expires_at = _session.mint_token(entry["user_id"])
    return jsonify({
        "ok":                 True,
        "session_token":      token,
        "session_expires_at": expires_at * 1000,
        "user_id":            entry["user_id"],
        # Operator MUST save this — the old key is now invalid and this is
        # the only time the plaintext leaves the server.
        "new_recovery_key":   new_recovery_key,
    })


@app.route("/auth/me", methods=["GET"])
def auth_me():
    """Validate a Bearer session token and return the bound user id.

    Used by the frontend at boot to confirm a stored token is still
    fresh before showing the dashboard. Returns 401 on any failure
    (missing header, malformed, bad signature, expired)."""
    token = _session.extract_bearer(request.headers.get("Authorization"))
    payload = _session.verify_token(token) if token else None
    if not payload:
        return jsonify({"ok": False, "error": "invalid_token"}), 401
    return jsonify({
        "ok":                 True,
        "user_id":            payload["user_id"],
        "session_expires_at": payload["expires_at"] * 1000,
    })


@app.route("/auth/logout", methods=["POST"])
def auth_logout():
    """Logout is a client-side concern since tokens are stateless — the
    server has no session to invalidate. We accept the call and return
    OK so the frontend's logout flow has a real endpoint to await.
    For server-side invalidation (e.g. on password change), the token's
    24h expiry plus a forced re-login after sensitive ops is the model."""
    return jsonify({"ok": True})


@app.route("/auth/device-register", methods=["POST"])
def auth_device_register():
    """Bind a fresh device-unlock token to the current logged-in session.

    Requires a valid Bearer session token (i.e. the operator has just
    completed a manual login). Returns the raw token ONCE in the response
    body; only the SHA-256 hash is persisted in data/devices.json.

    The frontend stores the raw token in localStorage and later sends it
    to /auth/device-unlock to skip the password prompt. localStorage is
    origin-scoped so the token can only be replayed from the same browser
    on the same Vercel domain.
    """
    user_id = _bearer_user_id()
    if not user_id:
        return jsonify({"ok": False, "error": "auth_required"}), 401

    # Mint 32 random bytes → base64url. ~43 chars of printable text.
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_device_token(raw_token)
    device_id  = f"dev_{secrets.token_hex(6)}"
    now        = int(time.time())

    record = {
        "id":           device_id,
        "user_id":      user_id,
        "token_hash":   token_hash,
        "created_at":   now,
        "last_used_at": now,
        # Optional client-supplied label (e.g. "Chrome on Windows"). Helps
        # the operator audit which browsers are enrolled. Never required.
        "label":        (request.get_json(silent=True) or {}).get("label") or "",
    }
    with _DEVICES_LOCK:
        store = _read_devices()
        store.setdefault("devices", []).append(record)
        _write_devices(store)

    log.info("AUTH: device-register %s for %s (label=%r)", device_id, user_id, record["label"])
    return jsonify({
        "ok":           True,
        "device_id":    device_id,
        # ↓ Only returned at registration time. Subsequent calls would not
        # be able to read this — only the hash lives on disk.
        "device_token": raw_token,
    })


@app.route("/auth/device-unlock", methods=["POST"])
def auth_device_unlock():
    """Validate a stored device-unlock token → mint a fresh session.

    Public endpoint (no Bearer required — this IS the auth path). Rate-
    limited on the same per-IP "login" bucket so brute-force attempts
    against device tokens share quota with password attempts.
    """
    data = request.get_json(silent=True) or {}
    raw_token = (data.get("device_token") or "").strip()
    log.info("AUTH: /auth/device-unlock from %s", _client_ip())

    if not raw_token or len(raw_token) < 16:
        return jsonify({"ok": False, "error": "invalid"}), 400

    # Shared per-IP rate-limit bucket with /auth/login so the abacus
    # path can't be used to bypass the throttle.
    allowed, retry_after = _check_rate("login", max_per_hour=_RATE_LOGIN_PER_HOUR)
    if not allowed:
        log.info("AUTH: ⚠ device-unlock rate-limit hit (retry in %dmin)", retry_after)
        return jsonify({"ok": False, "error": "rate_limit",
                        "retry_after_min": retry_after}), 429

    record, idx, store = _find_device_by_token(raw_token)
    if not record:
        log.info("AUTH: ❌ device-unlock: no matching token")
        return jsonify({"ok": False, "error": "invalid"}), 401

    # Stamp last_used_at so the operator can later audit which tokens
    # are stale and prune them. Write outside the lookup lock window.
    with _DEVICES_LOCK:
        # Re-read because find_device_by_token released the lock; another
        # writer might have rotated the list. Find our record by id this
        # time (cheap, no constant-time needed since we already validated).
        store = _read_devices()
        for r in store.get("devices", []):
            if r.get("id") == record["id"]:
                r["last_used_at"] = int(time.time())
                break
        _write_devices(store)

    user_id = record["user_id"]
    token, expires_at = _session.mint_token(user_id)
    log.info("AUTH: ✅ device-unlock for %s via %s", user_id, record["id"])
    return jsonify({
        "ok":                 True,
        "session_token":      token,
        "session_expires_at": expires_at * 1000,
        "user_id":            user_id,
    })


@app.route("/auth/change-password", methods=["POST"])
def auth_change_password():
    """Knows-current-password path used by Settings → Change password."""
    data         = request.get_json(silent=True) or {}
    user_id      = (data.get("user_id")          or "").strip()
    current      =  data.get("current_password") or ""
    new_password =  data.get("new_password")     or ""
    log.info("AUTH: /auth/change-password from %s (user_id=%s)", _client_ip(), user_id)

    if not _verify_password(user_id, current):
        return jsonify({"ok": False, "error": "wrong_current"}), 401
    if not _password_meets_rules(new_password):
        return jsonify({"ok": False, "error": "weak"}), 400
    _save_password(new_password)
    log.info("AUTH: ✅ password changed for %s", user_id)
    return jsonify({"ok": True})


# =============================================================================
# Boot
# =============================================================================
if __name__ == "__main__":
    log.info("=" * 60)
    log.info("Mastermind Auth Service — starting (recovery-key flow)")
    store = _get_store()
    log.info("AUTH: user_id=%s  store=%s", store["user_id"], AUTH_FILE)
    log.info("✅ listening on http://127.0.0.1:5001")
    log.info("=" * 60)
    app.run(host="127.0.0.1", port=5001, debug=False, use_reloader=False)
