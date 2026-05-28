// Frontend auth client for Mastermind Abacus Automation Studio.
//
// User-ID + password login. Backend (api/auth_server.py on :5001) holds
// the only source of truth: PBKDF2-SHA256 hashed credentials in
// data/auth.json. The frontend never stores the plaintext password and
// never sees the recovery key beyond the moment of submission.
//
// Defaults (seeded on first boot from api/.env):
//   User ID      : mastermind_abc
//   Password     : master@123#
//   Recovery Key : MA-9XK2-7PLQ-41ZT

import { AUTH_API_BASE as AUTH_API } from './config'

const FIXED_USER_ID   = 'mastermind_abc'
// Real auth state — HMAC-signed token + expiry minted by api/auth_server.py.
// The presence of a non-expired token is the ONLY thing that grants access
// (the old `mm_auth_v3 === '1'` boolean flag, which could be set in
// DevTools to bypass login, is gone).
const SESSION_KEY      = 'mm_session_v1'      // { token, expiresAt }
const RESET_TOKEN_KEY  = 'mm_reset_token_v2'
const DEVICE_TOKEN_KEY = 'mm_device_token_v1' // per-browser quick-unlock key
// Clear every legacy key on first load — old SMTP-era + boolean-flag state
// must die so nobody is silently grandfathered in via stale localStorage.
const LEGACY_KEYS = [
  'mm_auth_v1', 'mm_auth_v2', 'mm_auth_v3',
  'mm_pw_v1',   'mm_creds_v2',
  'mm_otp_v1',  'mm_reset_token_v1',
  'mm_rate_v1',
]

function bootstrap() {
  if (typeof localStorage === 'undefined') return
  LEGACY_KEYS.forEach((k) => { try { localStorage.removeItem(k) } catch (_) {} })
}
bootstrap()

// ---------- session API ---------------------------------------------------
export function getFixedUserId() { return FIXED_USER_ID }

/** Read the stored session record, or null if absent / malformed. */
export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!s || typeof s.token !== 'string' || typeof s.expiresAt !== 'number') {
      return null
    }
    return s
  } catch (_) {
    return null
  }
}

/** True iff there is a stored token and it hasn't expired. */
export function isAuthenticated() {
  const s = getSession()
  if (!s) return false
  return Date.now() < s.expiresAt
}

/** Token string for the Authorization header. Null if not signed in. */
export function getSessionToken() {
  const s = getSession()
  if (!s) return null
  if (Date.now() >= s.expiresAt) return null
  return s.token
}

function saveSession(token, expiresAt) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, expiresAt }))
  } catch (_) {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch (_) {}
}

/** Hook for the fetch interceptor — called on any 401 response so the UI
 *  can drop the stored token and force a re-login. */
export function onAuthRejected() {
  clearSession()
  // Notify the React tree so any open page can react (e.g. send the user
  // to /login). App.jsx will pick this up via window event listener.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mm:auth-rejected'))
  }
}

/** Boot-time session validation — checks the stored token against the
 *  auth server's `/auth/me`. Returns { valid: bool, reason? }.
 *
 *  Used by `<SessionBootstrap>` in App.jsx to handle the "stale token
 *  from a previous SESSION_SECRET" scenario gracefully: the local
 *  `isAuthenticated()` check passes (token isn't expired by clock), but
 *  the server rejects the signature, so we proactively clear it and
 *  redirect to /login BEFORE any page mounts and starts polling — which
 *  was producing the "API unreachable: HTTP 401" flash.
 *
 *  Network blips DO NOT clear the token (returns `valid: true`) so a
 *  transient outage doesn't log the operator out.
 */
export async function validateSession() {
  const token = getSessionToken()
  if (!token) return { valid: false, reason: 'no_token' }
  try {
    const res = await fetch(`${AUTH_API}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (res.ok) return { valid: true }
    if (res.status === 401) {
      clearSession()
      return { valid: false, reason: 'invalid_token' }
    }
    // 5xx / 404 — auth server is reachable but unhappy. Keep the token
    // so we don't kick the user out on a server hiccup.
    return { valid: true, reason: 'server_error' }
  } catch (_) {
    // Network failure — keep the token; the user can retry.
    return { valid: true, reason: 'network' }
  }
}

/** Sign-out — server has nothing to invalidate (stateless tokens) but
 *  we call /auth/logout for symmetry + audit-log breadcrumb. */
export async function signOut() {
  const token = getSessionToken()
  clearSession()
  if (!token) return
  try {
    await fetch(`${AUTH_API}/auth/logout`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    })
  } catch (_) { /* best-effort */ }
}

// Backend-validated login. Returns { ok, reason? }.
//   reason: 'invalid' | 'rate_limit' | 'backend_offline' | 'network'
export async function signIn(userId, password) {
  if (typeof userId !== 'string' || typeof password !== 'string') {
    return { ok: false, reason: 'invalid' }
  }
  try {
    const res = await fetch(`${AUTH_API}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ user_id: userId.trim(), password }),
    })
    let data = {}
    try { data = await res.json() } catch (_) {}
    if (res.ok && data.ok && data.session_token && data.session_expires_at) {
      saveSession(data.session_token, data.session_expires_at)
      return { ok: true }
    }
    if (data.error === 'rate_limit') {
      return { ok: false, reason: 'rate_limit', retryAfterMin: data.retry_after_min }
    }
    if (res.status === 404) return { ok: false, reason: 'backend_offline' }
    return { ok: false, reason: 'invalid' }
  } catch (_) {
    return { ok: false, reason: 'network' }
  }
}

// Knows-current-password change. Used by Settings → Change Password.
//   reason: 'wrong-current' | 'weak' | 'backend_offline' | 'network'
export async function changePassword(currentPassword, newPassword) {
  try {
    const res = await fetch(`${AUTH_API}/auth/change-password`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        user_id:          FIXED_USER_ID,
        current_password: currentPassword,
        new_password:     newPassword,
      }),
    })
    let data = {}
    try { data = await res.json() } catch (_) {}
    if (res.ok && data.ok) return { ok: true }
    if (data.error === 'wrong_current') return { ok: false, reason: 'wrong-current' }
    if (data.error === 'weak')          return { ok: false, reason: 'weak' }
    if (res.status === 404)             return { ok: false, reason: 'backend_offline' }
    return { ok: false, reason: 'invalid' }
  } catch (_) {
    return { ok: false, reason: 'network' }
  }
}

// ---------- Recovery key flow --------------------------------------------
// Step 1 — verify the recovery key. On success backend issues a one-use
// reset token, stored in sessionStorage for the next step.
//   reason: 'invalid' | 'rate_limit' | 'backend_offline' | 'network'
export async function verifyRecoveryKey(userId, recoveryKey) {
  try {
    const res = await fetch(`${AUTH_API}/auth/verify-recovery`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        user_id:      (userId || '').trim(),
        recovery_key: recoveryKey,
      }),
    })
    let data = {}
    try { data = await res.json() } catch (_) {}
    if (res.ok && data.reset_token) {
      try { sessionStorage.setItem(RESET_TOKEN_KEY, data.reset_token) } catch (_) {}
      return { ok: true }
    }
    if (data.error === 'rate_limit') {
      return { ok: false, reason: 'rate_limit', retryAfterMin: data.retry_after_min }
    }
    if (res.status === 404) return { ok: false, reason: 'backend_offline' }
    return { ok: false, reason: 'invalid' }
  } catch (_) {
    return { ok: false, reason: 'network' }
  }
}

// Step 2 — set new password using the reset token from step 1. On
// success the local session flag is cleared so the user must sign in
// with the new password.
//   reason: 'invalid_token' | 'weak' | 'backend_offline' | 'network'
export async function completePasswordReset(newPassword) {
  let token = ''
  try { token = sessionStorage.getItem(RESET_TOKEN_KEY) || '' } catch (_) {}
  if (!token) return { ok: false, reason: 'invalid_token' }

  if (!passwordMeetsRules(newPassword)) {
    return { ok: false, reason: 'weak' }
  }
  try {
    const res = await fetch(`${AUTH_API}/auth/reset-password`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ reset_token: token, new_password: newPassword }),
    })
    let data = {}
    try { data = await res.json() } catch (_) {}
    if (!res.ok || !data.ok) {
      try { sessionStorage.removeItem(RESET_TOKEN_KEY) } catch (_) {}
      if (data.error === 'weak')           return { ok: false, reason: 'weak' }
      if (data.error === 'invalid_token')  return { ok: false, reason: 'invalid_token' }
      if (res.status === 404)              return { ok: false, reason: 'backend_offline' }
      return { ok: false, reason: 'invalid_token' }
    }
    try { sessionStorage.removeItem(RESET_TOKEN_KEY) } catch (_) {}
    // Backend issues a fresh session token after a successful recovery
    // reset so the user lands straight on the dashboard with the new
    // password active. Old session state is naturally invalidated when
    // we overwrite SESSION_KEY.
    if (data.session_token && data.session_expires_at) {
      saveSession(data.session_token, data.session_expires_at)
    } else {
      clearSession()
    }
    return { ok: true }
  } catch (_) {
    return { ok: false, reason: 'network' }
  }
}

// ---------- Easter-egg abacus unlock -------------------------------------
// Hidden UX path. The original SECRET-unlock backdoor was replaced with a
// device-token model: after the operator logs in once manually, the
// browser enrols a per-device token (random 256-bit string) with the
// backend. Subsequent abacus completions exchange that token for a fresh
// session — no password ever ships in the JS bundle.
export async function secretUnlock() {
  return { ok: false, reason: 'login_required' }
}

// ---------- Per-device quick-unlock token --------------------------------
// Flow:
//   1. After a successful manual login, the frontend calls
//      registerDevice() which hits POST /auth/device-register with the
//      live session token. The backend returns a fresh random token
//      ONCE (only its hash is stored server-side) and we cache it in
//      localStorage under DEVICE_TOKEN_KEY.
//   2. On any later visit, completing the hidden abacus sequence runs
//      unlockWithDevice() which POSTs that cached token to
//      /auth/device-unlock. The backend mints a fresh session token if
//      the hash matches and we save it via saveSession().
//   3. hasDeviceToken() lets the Login page show a "Complete one
//      manual login to enable quick unlock." hint when the localStorage
//      slot is empty.
//
// localStorage is origin-scoped — the token can only be replayed from
// the same browser on the same Vercel domain, so it's no more
// exfiltratable than the session token itself.

export function hasDeviceToken() {
  try { return Boolean(localStorage.getItem(DEVICE_TOKEN_KEY)) }
  catch (_) { return false }
}

export function getDeviceToken() {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY) || null }
  catch (_) { return null }
}

export function clearDeviceToken() {
  try { localStorage.removeItem(DEVICE_TOKEN_KEY) } catch (_) {}
}

/** Register this browser as a quick-unlock device. Best-effort — called
 *  in the background after manual login. Fails silently (e.g. backend
 *  hiccup) so the manual login itself never blocks on this call. */
export async function registerDevice(label = '') {
  const token = getSessionToken()
  if (!token) return { ok: false, reason: 'no_session' }
  try {
    const res = await fetch(`${AUTH_API}/auth/device-register`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ label: label || _autoLabel() }),
    })
    let data = {}
    try { data = await res.json() } catch (_) {}
    if (res.ok && data.ok && data.device_token) {
      try { localStorage.setItem(DEVICE_TOKEN_KEY, data.device_token) } catch (_) {}
      return { ok: true, device_id: data.device_id }
    }
    return { ok: false, reason: data.error || 'invalid' }
  } catch (_) {
    return { ok: false, reason: 'network' }
  }
}

/** Exchange the stored device token for a fresh session. Used by the
 *  hidden abacus sequence on completion. Returns the same shape as
 *  signIn(): { ok, reason? }. */
export async function unlockWithDevice() {
  const deviceToken = getDeviceToken()
  if (!deviceToken) return { ok: false, reason: 'no_device_token' }
  try {
    const res = await fetch(`${AUTH_API}/auth/device-unlock`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device_token: deviceToken }),
    })
    let data = {}
    try { data = await res.json() } catch (_) {}
    if (res.ok && data.ok && data.session_token && data.session_expires_at) {
      saveSession(data.session_token, data.session_expires_at)
      return { ok: true }
    }
    if (data.error === 'rate_limit') {
      return { ok: false, reason: 'rate_limit', retryAfterMin: data.retry_after_min }
    }
    if (data.error === 'invalid') {
      // Server rejected the stored token — wipe it so the hint comes
      // back and the operator knows to re-enrol via manual login.
      clearDeviceToken()
      return { ok: false, reason: 'invalid_device_token' }
    }
    if (res.status === 404) return { ok: false, reason: 'backend_offline' }
    return { ok: false, reason: 'invalid_device_token' }
  } catch (_) {
    return { ok: false, reason: 'network' }
  }
}

function _autoLabel() {
  // Friendly default label so devices.json is readable when auditing.
  try {
    const ua = (navigator.userAgent || '').toLowerCase()
    const browser =
      ua.includes('edg/')     ? 'Edge'    :
      ua.includes('firefox/') ? 'Firefox' :
      ua.includes('chrome/')  ? 'Chrome'  :
      ua.includes('safari/')  ? 'Safari'  : 'Browser'
    const os =
      ua.includes('windows')  ? 'Windows' :
      ua.includes('mac')      ? 'macOS'   :
      ua.includes('linux')    ? 'Linux'   :
      ua.includes('android')  ? 'Android' :
      ua.includes('iphone') || ua.includes('ipad') ? 'iOS' : ''
    return os ? `${browser} on ${os}` : browser
  } catch (_) {
    return ''
  }
}

// ---------- password validation ------------------------------------------
export function passwordStrength(pw) {
  if (!pw) return 0
  let score = 0
  if (pw.length >= 8)                       score++
  if (pw.length >= 12)                      score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw))                     score++
  if (/[^a-zA-Z0-9]/.test(pw))              score++
  return Math.min(4, score)
}

export function passwordMeetsRules(pw) {
  return Boolean(
    pw && pw.length >= 8 &&
    /[a-z]/.test(pw) &&
    /[A-Z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[^a-zA-Z0-9]/.test(pw)
  )
}

export function passwordRuleChecks(pw) {
  pw = pw || ''
  return {
    length:  pw.length >= 8,
    upper:   /[A-Z]/.test(pw),
    lower:   /[a-z]/.test(pw),
    digit:   /[0-9]/.test(pw),
    special: /[^a-zA-Z0-9]/.test(pw),
  }
}

// Auto-format helper for the Recovery Key input. Strips non-alphanumeric,
// uppercases, inserts dashes after positions 2/6/10 → MA-XXXX-XXXX-XXXX.
export function formatRecoveryKey(input) {
  const clean = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14)
  let out = ''
  for (let i = 0; i < clean.length; i++) {
    if (i === 2 || i === 6 || i === 10) out += '-'
    out += clean[i]
  }
  return out
}
