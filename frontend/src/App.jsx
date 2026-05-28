import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import './config' // installs the global fetch interceptor at app boot
import { BACKEND_CONFIGURED } from './config'

import { ThemeProvider } from './ThemeContext'
import { TemplateProvider } from './TemplateContext'
import Sidebar from './components/Sidebar'
import Header from './components/Header'

import Dashboard from './pages/Dashboard'
import Templates from './pages/Templates'
import Sheets from './pages/Sheets'
import Generated from './pages/Generated'
import Delivery from './pages/Delivery'
import Settings from './pages/Settings'
import Login from './pages/Login'

import { isAuthenticated, validateSession } from './auth'

// Gate every dashboard route — redirects to /login if the session is missing.
// Auth state lives in localStorage so it persists across reloads but gets
// cleared on signOut. The check runs on every render, so any tab that loses
// auth state (e.g. via Settings → Logout everywhere) sees the redirect on
// the next route transition.
function RequireAuth({ children }) {
  const location = useLocation()
  // Frontend-only Vercel preview: when no backend URL is wired, skip
  // the auth gate so the operator can still QA the UI. The visible
  // banner makes it clear nothing on these pages will hit a server.
  if (!BACKEND_CONFIGURED) return children
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

/**
 * Boot-time session check.
 *
 * `RequireAuth` only does a local-clock check on the stored token. That's
 * cheap but doesn't catch the "stale token from a previous SESSION_SECRET"
 * case — the clock says the token is still valid, but the server's HMAC
 * doesn't match, so every page mounts, every page polls, every page shows
 * "API unreachable: HTTP 401" until the interceptor's redirect kicks in.
 *
 * This wrapper sits AFTER RequireAuth (so it only runs once we have a
 * locally-valid token) and BEFORE Shell mounts. It calls /auth/me once.
 * If the server says the token is dead, we clear it and bounce to /login.
 * Otherwise we render the dashboard normally.
 *
 * A network error / 5xx is treated as transient — keep the token, render
 * the app, let individual pages retry. Auth-server outages shouldn't lock
 * the operator out of their already-authenticated session.
 */
function SessionBootstrap({ children }) {
  const [status, setStatus] = useState('checking') // checking | ok | invalid
  const location = useLocation()

  useEffect(() => {
    // No backend wired → nothing to validate against. Skip the round-trip
    // so the dashboard mounts straight away in frontend-preview mode.
    if (!BACKEND_CONFIGURED) {
      setStatus('ok')
      return
    }
    let cancelled = false
    validateSession().then((r) => {
      if (cancelled) return
      setStatus(r.valid ? 'ok' : 'invalid')
    })
    return () => { cancelled = true }
  }, [])

  if (status === 'checking') {
    // Tiny splash — almost always invisible (1 round-trip on localhost).
    // Plain centred dot so we don't trip the dashboard's polling chrome.
    return (
      <div className="session-bootstrap-splash" aria-live="polite">
        <div className="session-bootstrap-dot" />
      </div>
    )
  }
  if (status === 'invalid') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [pathname])
  return null
}

/** Listens for the `mm:auth-rejected` window event fired by the global
 *  fetch interceptor in config.js when any protected API call comes back
 *  401. Boots the user to /login with the current path stashed so they
 *  can be returned there after re-login. */
function AuthRejectionListener() {
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    function onRejected() {
      // Don't bounce off /login itself — would cause a redirect loop if
      // the auth server itself somehow returned a stray 401.
      if (location.pathname === '/login') return
      navigate('/login', { replace: true, state: { from: location.pathname } })
    }
    window.addEventListener('mm:auth-rejected', onRejected)
    return () => window.removeEventListener('mm:auth-rejected', onRejected)
  }, [navigate, location.pathname])
  return null
}

/** Persistent banner shown when the frontend has no backend URL wired
 *  (Vercel-only deploy, before Cloudflare tunnel / VPS is configured).
 *  Reminds the operator that this is a preview build — anything that
 *  would normally hit Flask is short-circuited. */
function BackendNotice() {
  if (BACKEND_CONFIGURED) return null
  return (
    <div className="backend-notice" role="status">
      <strong>Frontend preview mode.</strong>{' '}
      Backend is not connected — set <code>VITE_API_BASE</code> and{' '}
      <code>VITE_AUTH_API</code> in Vercel and redeploy to enable
      authentication, uploads, and delivery.
    </div>
  )
}

function Shell() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Header />
        <BackendNotice />
        <ScrollToTop />
        <Routes>
          <Route path="/"          element={<Dashboard />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/sheets"    element={<Sheets />} />
          <Route path="/generated" element={<Generated />} />
          <Route path="/delivery"  element={<Delivery />} />
          <Route path="/settings"  element={<Settings />} />
          <Route path="*"          element={<Dashboard />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <TemplateProvider>
          <AuthRejectionListener />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/*"     element={<RequireAuth><SessionBootstrap><Shell /></SessionBootstrap></RequireAuth>} />
          </Routes>
        </TemplateProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
