// Centralised runtime config.
//
// Reads from Vite's `import.meta.env` so deployments can override via
// `frontend/.env.local` (dev) or platform env vars (prod). In dev the
// defaults match the localhost Flask setup so `npm run dev` works with
// no env file present. In production builds the defaults are EMPTY —
// the Vercel-hosted frontend is decoupled from the Flask backend, and
// pages render a "backend not connected" notice until VITE_API_BASE
// and VITE_AUTH_API are wired (Cloudflare tunnel during testing,
// Hostinger VPS in production).
//
// IMPORTANT: do NOT inline `http://localhost:5000` anywhere else in
// the frontend — import API_BASE / AUTH_API_BASE from this file.

const _devApiDefault  = import.meta.env.DEV ? 'http://localhost:5000' : ''
const _devAuthDefault = import.meta.env.DEV ? 'http://localhost:5001' : ''

export const API_BASE      = import.meta.env.VITE_API_BASE || _devApiDefault
export const AUTH_API_BASE = import.meta.env.VITE_AUTH_API || _devAuthDefault

// True when both API endpoints are configured. False on a Vercel build
// where the operator hasn't yet pointed VITE_API_BASE / VITE_AUTH_API
// at a running backend (e.g. Cloudflare tunnel or VPS). Pages can
// short-circuit fetches and show a friendly notice when this is false.
export const BACKEND_CONFIGURED = Boolean(API_BASE && AUTH_API_BASE)


/**
 * Convert an exception thrown by a `fetch(...)` flow into the right
 * user-facing message. Distinguishes the three cases pages care about:
 *
 *   1. HTTP 401  → "Session expired. Please log in again."
 *      The user's token is gone or invalid — they're about to be
 *      bounced to /login by the auth-rejected event listener; the
 *      message is what shows during the ~1 frame of transition.
 *
 *   2. network   → "API unreachable: <details>. Is the Flask API
 *      running on <base>?"  The original "Flask is down" message.
 *
 *   3. anything else → "<details>"  e.g. 500 / 400 / unexpected shape
 *      from the API; show the raw message.
 *
 * Pages call this in their fetch catch blocks so every page reports the
 * same wording for the same condition.
 */
export function friendlyApiError(err, apiBase = API_BASE) {
  const msg = (err && err.message) ? err.message : String(err)
  if (msg === 'HTTP 401' || msg.includes('401')) {
    return 'Session expired. Please log in again.'
  }
  // "Failed to fetch" / "NetworkError" / "Load failed" — all mean the
  // server didn't answer at all.
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
    return `API unreachable. Is the Flask API running on ${apiBase}?`
  }
  if (msg.startsWith('HTTP ')) {
    return `Server returned ${msg}. Try refreshing in a moment.`
  }
  return msg
}


// =========================================================================
// Fetch interceptor
//
// Installed ONCE at module load. Every `fetch()` call (anywhere in the
// app) is wrapped so that:
//
//   1. Requests to API_BASE / AUTH_API_BASE get the Authorization
//      header injected from the stored session token.
//   2. 401 responses from those origins fire an `mm:auth-rejected`
//      window event so the React tree can drop state and redirect to
//      /login. The stored token is cleared so future requests don't
//      re-authenticate as the dead session.
//
// Designed to be invisible to caller code — existing fetch sites need
// no edits. Doesn't touch fetches to other origins (Google fonts,
// third-party SDKs, etc.).
//
// The cycle:
//      auth.js → import config.js (gets API_BASE, no auth functions)
//      config.js → optionally read getSessionToken from auth.js
// To break the cycle we late-import auth.js the first time the
// interceptor runs, not at module load.
// =========================================================================
if (typeof window !== 'undefined' && !window.__mm_fetch_patched) {
  window.__mm_fetch_patched = true
  const _origFetch = window.fetch.bind(window)

  // Cached lazy import — avoid the circular import at module init.
  let _authMod = null
  async function _getAuth() {
    if (!_authMod) _authMod = await import('./auth.js')
    return _authMod
  }

  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string'
      ? input
      : (input && input.url) || ''

    function _matchesBase(candidate, base) {
      if (!base) return false
      if (candidate.startsWith(base)) return true
      if (base.startsWith('/')) {
        try {
          const absBase = new URL(base, window.location.origin).href
          return candidate.startsWith(absBase)
        } catch (_) {
          return false
        }
      }
      return false
    }

    const isOurs = _matchesBase(url, API_BASE) || _matchesBase(url, AUTH_API_BASE)
    if (!isOurs) return _origFetch(input, init)

    const authEndpointBase = AUTH_API_BASE.endsWith('/') ? AUTH_API_BASE.slice(0, -1) : AUTH_API_BASE
    // Endpoints that legitimately return 401 on bad user input (wrong
    // password / wrong key) rather than because the session is dead.
    // Excluding them keeps a single bad attempt from bouncing the
    // operator to /login — they get a toast and stay on the page.
    const isAuthEndpoint =
      _matchesBase(url, `${authEndpointBase}/auth/login`) ||
      _matchesBase(url, `${authEndpointBase}/auth/verify-recovery`) ||
      _matchesBase(url, `${authEndpointBase}/auth/reset-password`) ||
      _matchesBase(url, `${authEndpointBase}/auth/verify-current-password`) ||
      _matchesBase(url, `${authEndpointBase}/auth/change-password`)

    const opts = { ...(init || {}) }
    if (!isAuthEndpoint) {
      try {
        const auth = await _getAuth()
        const token = auth.getSessionToken && auth.getSessionToken()
        if (token) {
          const h = new Headers(opts.headers || {})
          if (!h.has('Authorization')) {
            h.set('Authorization', `Bearer ${token}`)
          }
          opts.headers = h
        }
      } catch (_) {
        // Swallow — request continues without the header; backend will 401
        // if the route is protected, the 401 handler below cleans up.
      }
    }

    const res = await _origFetch(input, opts)
    if (res.status === 401 && !isAuthEndpoint) {
      // Token missing / expired / forged. Drop state + signal the React
      // tree. We do NOT navigate from here (interceptor doesn't own the
      // router) — App.jsx's `mm:auth-rejected` listener handles the redirect.
      try {
        const auth = await _getAuth()
        if (auth.onAuthRejected) auth.onAuthRejected()
      } catch (_) {}
    }
    return res
  }
}
