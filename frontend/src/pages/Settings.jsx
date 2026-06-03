import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import { useTheme } from '../ThemeContext'
import {
  getFixedUserId,
  verifyRecoveryKey,
  completePasswordReset,
} from '../auth'

import { API_BASE } from '../config'

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
  const userIdDisplay = getFixedUserId()

  // Toast for inline feedback (verify success, save errors, etc.).
  const [toast, setToast] = useState(null)

  // ---- Password change (gated by recovery key) -------------------------
  // The operator first proves identity with the recovery key. On
  // success the backend hands back a one-time reset token (stored in
  // sessionStorage by verifyRecoveryKey) which completePasswordReset
  // then consumes to set the new password.
  const [recoveryKey,       setRecoveryKey]       = useState('')
  const [verifying,         setVerifying]         = useState(false)
  const [recoveryVerified,  setRecoveryVerified]  = useState(false)
  const [newPassword,       setNewPassword]       = useState('')
  const [newPasswordConfirm,setNewPasswordConfirm]= useState('')
  const [updating,          setUpdating]          = useState(false)

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

  async function handleVerifyRecovery(e) {
    e.preventDefault()
    if (!recoveryKey.trim() || verifying) return
    setVerifying(true)
    const res = await verifyRecoveryKey(userIdDisplay, recoveryKey.trim())
    setVerifying(false)
    if (res.ok) {
      setRecoveryVerified(true)
      showToast('Recovery key verified', 'success')
      return
    }
    let msg = 'Could not verify recovery key'
    if (res.reason === 'invalid')          msg = 'Recovery key is invalid'
    else if (res.reason === 'rate_limit')  msg = `Too many attempts — try again in ~${res.retryAfterMin || 5} min`
    else if (res.reason === 'backend_offline') msg = 'Authentication service offline'
    else if (res.reason === 'network')     msg = 'Network error'
    showToast(msg, 'info')
  }

  async function handleSetNewPassword(e) {
    e.preventDefault()
    if (!recoveryVerified || updating) return
    if (newPassword !== newPasswordConfirm) {
      showToast('Passwords do not match', 'info')
      return
    }
    setUpdating(true)
    const res = await completePasswordReset(newPassword)
    setUpdating(false)
    if (res.ok) {
      setRecoveryKey('')
      setRecoveryVerified(false)
      setNewPassword('')
      setNewPasswordConfirm('')
      showToast('Password updated', 'success')
      return
    }
    let msg = 'Could not update password'
    if (res.reason === 'weak')              msg = 'Password must be 8+ chars with upper, lower, digit, symbol'
    else if (res.reason === 'invalid_token') msg = 'Recovery verification expired — please verify again'
    else if (res.reason === 'backend_offline') msg = 'Authentication service offline'
    else if (res.reason === 'network')      msg = 'Network error'
    showToast(msg, 'info')
    if (res.reason === 'invalid_token') {
      setRecoveryVerified(false)
    }
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

      {/* 2. Account — recovery-key-gated password change ---------------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Account</div>

        <form className="settings-row settings-row-stack" onSubmit={handleVerifyRecovery}>
          <div className="settings-row-text">
            <div className="settings-row-label">Recovery key</div>
            <div className="settings-row-help">
              Paste the recovery key you wrote down at setup. Verifying it
              unlocks the password change below.
            </div>
          </div>
          <div className="settings-input-group">
            <input
              type="text"
              className="settings-input"
              value={recoveryKey}
              onChange={(e) => {
                setRecoveryKey(e.target.value)
                if (recoveryVerified) setRecoveryVerified(false)
              }}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              autoComplete="off"
              spellCheck="false"
              disabled={recoveryVerified}
            />
            <button
              type="submit"
              className="btn btn-secondary settings-action-btn"
              disabled={verifying || recoveryVerified || !recoveryKey.trim()}
            >
              {recoveryVerified ? '✓ Verified' : verifying ? 'Verifying…' : 'Verify'}
            </button>
          </div>
        </form>

        <form className="settings-row settings-row-stack" onSubmit={handleSetNewPassword}>
          <div className="settings-row-text">
            <div className="settings-row-label">Change password</div>
            <div className="settings-row-help">
              {recoveryVerified
                ? 'Enter the new password (8+ chars with upper, lower, digit, and symbol).'
                : 'Verify your recovery key above to unlock this form.'}
            </div>
          </div>
          <div className="settings-input-grid">
            <input
              type="password"
              className="settings-input"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              disabled={!recoveryVerified}
            />
            <input
              type="password"
              className="settings-input"
              placeholder="Confirm new password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={!recoveryVerified}
            />
            <button
              type="submit"
              className="btn btn-secondary settings-action-btn"
              disabled={!recoveryVerified || updating || !newPassword || !newPasswordConfirm}
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
