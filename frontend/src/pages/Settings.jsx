import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import { useTheme } from '../ThemeContext'
import {
  getFixedUserId,
  getSessionToken,
  changePassword,
} from '../auth'

import { API_BASE, AUTH_API_BASE } from '../config'

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export default function Settings() {
  const { theme, toggleTheme } = useTheme()
  // Resolve the canonical user_id from the live session token so the
  // backend's exact-match check against data/auth.json doesn't fail when
  // the stored id isn't the legacy default.
  const [resolvedUserId, setResolvedUserId] = useState(getFixedUserId())

  useEffect(() => {
    const token = getSessionToken()
    if (!token) return
    let cancelled = false
    fetch(`${AUTH_API_BASE}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        if (d && d.ok && typeof d.user_id === 'string' && d.user_id) {
          setResolvedUserId(d.user_id)
        }
      })
      .catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [])

  // Toast for inline feedback (save success, errors, etc.).
  const [toast, setToast] = useState(null)

  // ---- Password change (gated by current password) ---------------------
  // The operator proves identity by typing the current password — the
  // natural gate for an already-logged-in user. The recovery key is
  // reserved for the locked-out flow on the Login page.
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword,     setNewPassword]     = useState('')
  const [updating,        setUpdating]        = useState(false)

  // ---- Storage usage ---------------------------------------------------
  const [stats, setStats] = useState(null)
  const [items, setItems] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`${API_BASE}/dashboard-stats`).then((r) => r.json()).catch(() => null),
          fetch(`${API_BASE}/list-generated`).then((r) => r.json()).catch(() => null),
        ])
        if (cancelled) return
        if (r1?.status === 'success') setStats(r1.stats)
        if (r2?.status === 'success') setItems(r2.items || [])
      } catch (_) { /* usage cards just show — on error */ }
    }
    load()
    const t = setInterval(load, 20000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const usage = useMemo(() => {
    const totalBytes = items.reduce(
      (acc, m) => acc + (m.video?.size || 0) + (m.image?.size || 0),
      0,
    )
    return {
      videos:  stats?.totalVideos ?? items.filter((m) => m.video).length,
      storage: totalBytes,
    }
  }, [items, stats])

  function showToast(msg, kind = 'info') {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 2400)
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    if (updating) return
    if (!currentPassword || !newPassword) return
    setUpdating(true)
    const res = await changePassword(resolvedUserId, currentPassword, newPassword)
    setUpdating(false)
    if (res.ok) {
      setCurrentPassword('')
      setNewPassword('')
      showToast('Password updated', 'success')
      return
    }
    let msg = 'Could not update password'
    if (res.reason === 'wrong-current')        msg = 'Current password is incorrect'
    else if (res.reason === 'weak')            msg = 'Password must be 8+ chars with upper, lower, digit, symbol'
    else if (res.reason === 'backend_offline') msg = 'Authentication service offline'
    else if (res.reason === 'network')         msg = 'Network error'
    showToast(msg, 'info')
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Appearance, account, and workspace preferences."
      />

      {/* 1. Appearance -------------------------------------------------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Appearance</div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Theme</div>
            <div className="settings-row-help">Switch between the warm cream Light theme and a soft Dark theme.</div>
          </div>
          <div className="theme-segment" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={theme === 'light'}
              className={`theme-seg${theme === 'light' ? ' theme-seg-active' : ''}`}
              onClick={() => { if (theme !== 'light') toggleTheme() }}
            >☀️ Light</button>
            <button
              type="button"
              role="tab"
              aria-selected={theme === 'dark'}
              className={`theme-seg${theme === 'dark' ? ' theme-seg-active' : ''}`}
              onClick={() => { if (theme !== 'dark') toggleTheme() }}
            >🌙 Dark</button>
          </div>
        </div>
      </section>

      {/* 2. Account — current-password-gated change --------------------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Account</div>

        <form className="settings-row settings-row-stack" onSubmit={handleChangePassword}>
          <div className="settings-row-text">
            <div className="settings-row-label">Change password</div>
            <div className="settings-row-help">
              Type your current password and the new one (8+ chars, mix
              of upper, lower, digit, and symbol). Forgot it? Sign out
              and use “Forgot password?” on the login page.
            </div>
          </div>
          <div className="settings-input-grid">
            <input
              type="password"
              className="settings-input"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <input
              type="password"
              className="settings-input"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button
              type="submit"
              className="btn btn-secondary settings-action-btn"
              disabled={updating || !currentPassword || !newPassword}
            >
              {updating ? 'Updating…' : 'Update password'}
            </button>
          </div>
        </form>
      </section>

      {/* 3. Storage & usage -------------------------------------------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Storage & usage</div>
        <div className="settings-usage-grid settings-usage-grid-2up">
          <div className="settings-usage-card">
            <div className="settings-usage-icon settings-usage-icon-orange">🎬</div>
            <div className="settings-usage-value">{usage.videos}</div>
            <div className="settings-usage-label">Videos generated</div>
          </div>
          <div className="settings-usage-card">
            <div className="settings-usage-icon settings-usage-icon-blue">💾</div>
            <div className="settings-usage-value">{formatBytes(usage.storage)}</div>
            <div className="settings-usage-label">Storage used</div>
          </div>
        </div>
      </section>

      {toast && (
        <div className={`gen-toast gen-toast-${toast.kind}`} role="status">
          <span className="gen-toast-dot" aria-hidden="true" />
          {toast.msg}
        </div>
      )}
    </>
  )
}
