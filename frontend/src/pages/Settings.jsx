import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import { useTheme } from '../ThemeContext'
import { changePassword, getFixedUserId, signOut as authSignOut } from '../auth'

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
  const navigate = useNavigate()

  // ---- Account ---------------------------------------------------------
  // Email shown as informational only — workspace identity is User ID now.
  const [emailDraft, setEmailDraft] = useState('admin@mastermindabacus.com')
  const userIdDisplay = getFixedUserId()
  const [pwCurrent, setPwCurrent]   = useState('')
  const [pwNew, setPwNew]           = useState('')
  const [toast, setToast]           = useState(null)

  // ---- Video preferences ----------------------------------------------
  const [quality,   setQuality]   = useState('1080p')
  const [watermark, setWatermark] = useState(true)

  // ---- WhatsApp preferences --------------------------------------------
  const [sendDelay, setSendDelay] = useState(15)

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
      (s, m) => s + (m.video?.size || 0) + (m.image?.size || 0),
      0
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
    if (!pwCurrent || !pwNew) return
    const res = await changePassword(pwCurrent, pwNew)
    if (!res.ok) {
      let msg = 'Could not update password'
      if (res.reason === 'wrong-current')    msg = 'Current password is incorrect'
      else if (res.reason === 'weak')         msg = 'Password must meet all rules (8+ chars, upper, lower, digit, symbol)'
      else if (res.reason === 'backend_offline') msg = 'Authentication service offline'
      else if (res.reason === 'network')      msg = 'Network error'
      showToast(msg, 'info')
      return
    }
    setPwCurrent('')
    setPwNew('')
    showToast('Password updated', 'success')
  }

  function handleChangeEmail(e) {
    e.preventDefault()
    showToast('Verification email sent', 'success')
  }

  function logoutEverywhere() {
    authSignOut()
    navigate('/login', { replace: true })
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

      {/* 2. Account ----------------------------------------------------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Account</div>

        <form className="settings-row settings-row-stack" onSubmit={handleChangeEmail}>
          <div className="settings-row-text">
            <div className="settings-row-label">Email address</div>
            <div className="settings-row-help">Used for login and account-level notifications.</div>
          </div>
          <div className="settings-input-group">
            <input
              type="email"
              className="settings-input"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="you@company.com"
            />
            <button type="submit" className="btn btn-secondary settings-action-btn">Send verification</button>
          </div>
        </form>

        <form className="settings-row settings-row-stack" onSubmit={handleChangePassword}>
          <div className="settings-row-text">
            <div className="settings-row-label">Change password</div>
            <div className="settings-row-help">Use at least 8 characters with one number or symbol.</div>
          </div>
          <div className="settings-input-grid">
            <input
              type="password"
              className="settings-input"
              placeholder="Current password"
              value={pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
              autoComplete="current-password"
            />
            <input
              type="password"
              className="settings-input"
              placeholder="New password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              autoComplete="new-password"
            />
            <button type="submit" className="btn btn-secondary settings-action-btn">Update password</button>
          </div>
        </form>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Logout everywhere</div>
            <div className="settings-row-help">Keeps this session signed in; signs out everyone else.</div>
          </div>
          <button
            type="button"
            className="btn btn-secondary settings-action-btn"
            onClick={logoutEverywhere}
          >Logout everywhere</button>
        </div>
      </section>

      {/* 3. Video preferences ------------------------------------------ */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">Video preferences</div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Default video quality</div>
            <div className="settings-row-help">Resolution used for each personalised render.</div>
          </div>
          <select
            className="settings-select"
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
          >
            <option value="720p">720p · faster, smaller files</option>
            <option value="1080p">1080p · recommended</option>
            <option value="1440p">1440p · premium</option>
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Mastermind watermark</div>
            <div className="settings-row-help">Apply the corner watermark to every personalised render.</div>
          </div>
          <label className={`switch${watermark ? ' switch-on' : ''}`}>
            <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} />
            <span className="switch-thumb" />
          </label>
        </div>
      </section>

      {/* 4. WhatsApp preferences --------------------------------------- */}
      <section className="dash-card settings-card">
        <div className="settings-section-title">WhatsApp preferences</div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Send delay</div>
            <div className="settings-row-help">Seconds to wait between consecutive sends to avoid throttling.</div>
          </div>
          <div className="settings-stepper">
            <button type="button" className="settings-stepper-btn"
              onClick={() => setSendDelay((n) => Math.max(0, n - 5))}>−</button>
            <input
              type="number"
              className="settings-stepper-input"
              value={sendDelay}
              min={0}
              onChange={(e) => setSendDelay(Math.max(0, Number(e.target.value) || 0))}
            />
            <button type="button" className="settings-stepper-btn"
              onClick={() => setSendDelay((n) => n + 5)}>+</button>
            <span className="settings-stepper-suffix">sec</span>
          </div>
        </div>
      </section>

      {/* 5. Storage & usage -------------------------------------------- */}
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

      {/* 6. Danger zone ------------------------------------------------ */}
      <section className="dash-card settings-card settings-danger-card">
        <div className="settings-section-title settings-section-title-danger">Danger zone</div>

        <div className="settings-row settings-danger-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Delete all generated media</div>
            <div className="settings-row-help">Permanently remove every personalised video and image from disk. This cannot be undone.</div>
          </div>
          <button type="button" className="btn settings-danger-btn"
            onClick={() => showToast('Delete-all confirmation TBD', 'info')}>
            Delete all media
          </button>
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
