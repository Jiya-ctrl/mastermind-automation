import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import { useTheme } from '../ThemeContext'
import {
  getFixedUserId,
  getSessionToken,
  verifyCurrentPassword,
  changePassword,
} from '../auth'

import { API_BASE, AUTH_API_BASE } from '../config'

// Small inline eye icon used on password fields. `open` = eye open
// (password currently visible), `open=false` = eye closed (masked).
function IconEye({ open }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      {open ? (
        <path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5C21.3 7.6 17 4.5 12 4.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
      ) : (
        <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27z" />
      )}
    </svg>
  )
}

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
  // Two-step flow:
  //   1. Operator types current password + clicks Verify → backend
  //      confirms it matches. On success `currentVerified` flips true
  //      and the New-password field unlocks.
  //   2. Operator types new password + clicks Update → backend rotates
  //      the stored hash. Form resets.
  // Editing the current-password field after a verify resets the gate,
  // so a wrong-then-right re-type still gets re-checked.
  const [currentPassword,  setCurrentPassword]  = useState('')
  const [currentVerified,  setCurrentVerified]  = useState(false)
  const [verifying,        setVerifying]        = useState(false)
  const [showCurrent,      setShowCurrent]      = useState(false)
  const [newPassword,      setNewPassword]      = useState('')
  const [updating,         setUpdating]         = useState(false)
  const [showNew,          setShowNew]          = useState(false)

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

  async function handleVerifyCurrent(e) {
    e.preventDefault()
    if (!currentPassword || verifying || currentVerified) return
    setVerifying(true)
    const res = await verifyCurrentPassword(resolvedUserId, currentPassword)
    setVerifying(false)
    if (res.ok) {
      setCurrentVerified(true)
      showToast('Current password verified', 'success')
      return
    }
    let msg = 'Could not verify current password'
    if (res.reason === 'wrong-current')        msg = 'Current password is incorrect'
    else if (res.reason === 'rate_limit')      msg = `Too many attempts — try again in ~${res.retryAfterMin || 5} min`
    else if (res.reason === 'backend_offline') msg = 'Authentication service offline'
    else if (res.reason === 'network')         msg = 'Network error'
    showToast(msg, 'info')
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    if (updating || !currentVerified || !newPassword) return
    setUpdating(true)
    const res = await changePassword(resolvedUserId, currentPassword, newPassword)
    setUpdating(false)
    if (res.ok) {
      setCurrentPassword('')
      setCurrentVerified(false)
      setNewPassword('')
      showToast('Password updated', 'success')
      return
    }
    let msg = 'Could not update password'
    if (res.reason === 'wrong-current') {
      // Current password changed under us (someone else?) — re-gate.
      setCurrentVerified(false)
      msg = 'Current password is no longer correct — please re-verify'
    } else if (res.reason === 'weak')            msg = 'Password must be 8+ chars with upper, lower, digit, symbol'
    else if (res.reason === 'backend_offline')   msg = 'Authentication service offline'
    else if (res.reason === 'network')           msg = 'Network error'
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

      {/* 2. Account — two-step gate: verify current, then set new ------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Account</div>

        <form className="settings-row settings-row-stack" onSubmit={handleVerifyCurrent}>
          <div className="settings-row-text">
            <div className="settings-row-label">Change password</div>
            <div className="settings-row-help">
              Step 1: confirm your current password. The new-password
              field unlocks only after the current one is verified.
              Forgot it? Sign out and use “Forgot password?” on the
              login page.
            </div>
          </div>
          <div className="settings-input-group">
            <div className="settings-pwd-wrap">
              <input
                type={showCurrent ? 'text' : 'password'}
                className="settings-input settings-input-pwd"
                placeholder="Current password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value)
                  if (currentVerified) setCurrentVerified(false)
                }}
                autoComplete="current-password"
                disabled={currentVerified}
              />
              <button
                type="button"
                className="settings-pwd-eye"
                onClick={() => setShowCurrent((v) => !v)}
                tabIndex={-1}
                aria-label={showCurrent ? 'Hide password' : 'Show password'}
              >
                <IconEye open={showCurrent} />
              </button>
            </div>
            <button
              type="submit"
              className="btn btn-secondary settings-action-btn"
              disabled={verifying || currentVerified || !currentPassword}
            >
              {currentVerified ? '✓ Verified' : verifying ? 'Verifying…' : 'Verify'}
            </button>
          </div>
        </form>

        <form className="settings-row settings-row-stack" onSubmit={handleChangePassword}>
          <div className="settings-row-text">
            <div className="settings-row-label">New password</div>
            <div className="settings-row-help">
              {currentVerified
                ? 'Step 2: pick a new password (8+ chars with upper, lower, digit, and symbol).'
                : 'Verify your current password above to unlock this field.'}
            </div>
          </div>
          <div className="settings-input-group">
            <div className="settings-pwd-wrap">
              <input
                type={showNew ? 'text' : 'password'}
                className="settings-input settings-input-pwd"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                disabled={!currentVerified}
              />
              <button
                type="button"
                className="settings-pwd-eye"
                onClick={() => setShowNew((v) => !v)}
                tabIndex={-1}
                aria-label={showNew ? 'Hide password' : 'Show password'}
                disabled={!currentVerified}
              >
                <IconEye open={showNew} />
              </button>
            </div>
            <button
              type="submit"
              className="btn btn-secondary settings-action-btn"
              disabled={!currentVerified || updating || !newPassword}
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
