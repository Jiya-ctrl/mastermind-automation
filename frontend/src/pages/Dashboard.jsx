import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import GenerateModal from '../components/GenerateModal'

import { API_BASE, friendlyApiError } from '../config'
const POLL_MS  = 12000

const ACTIONS = [
  { to: '/templates',  icon: '↑',  title: 'Upload Template',      desc: 'Base video or image template', tone: 'orange'  },
  { to: '/sheets',     icon: '▥',  title: 'Connect Google Sheet', desc: 'Recipient list and details',   tone: 'emerald' },
  { to: 'generate',    icon: '▣',  title: 'Generate Personalised Media',  desc: 'Pick image or video — one render at a time', tone: 'blue' },
  { to: '/delivery',   icon: '➤',  title: 'Send WhatsApp',        desc: 'Deliver to every contact',     tone: 'peach'   },
]

// Local helpers (Dashboard no longer reads from store/recipients).
function initialsOf(name) {
  const parts = String(name || '').split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '–'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function statusClass(s) {
  return {
    Sent: 'op-status-sent',
    Pending: 'op-status-pending',
    Failed: 'op-status-failed',
  }[s]
}
function statusIcon(s) {
  return { Sent: '●', Pending: '◴', Failed: '✕' }[s]
}

// Map canonical statuses → the shorter labels the Dashboard pill uses.
// The backend can emit a wider set of statuses than the original three
// (Read/Media Sent/Awaiting Reply come from Meta callbacks) — they all
// need to land in the right pill or the operator sees stale "Pending"
// on rows that have actually been delivered + read.
function dashboardStatusLabel(status) {
  switch (status) {
    case 'Delivered':
    case 'Read':
    case 'Sent':
    case 'Media Sent':       return 'Sent'
    case 'Sending':
    case 'Queued':
    case 'Awaiting Reply':   return 'Pending'
    case 'Failed':           return 'Failed'
    default:                 return 'Pending'
  }
}

function formatGeneratedAt(epochMs) {
  if (!epochMs || typeof epochMs !== 'number') return '—'
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm} today`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (isYesterday) return `${hh}:${mm} yesterday`
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

// Stable tone for avatar — derived from the id so each recipient looks the
// same across renders without needing a stored value.
const AVATAR_TONES = ['peach', 'blue-grey', 'orange', 'grey']
function toneFor(id) {
  let h = 0
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length]
}

export default function Dashboard() {
  const [generateOpen, setGenerateOpen] = useState(false)
  const [stats, setStats] = useState(null)
  const [latest, setLatest] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    let timer = null
    let inFlight = false

    async function fetchStats() {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const res = await fetch(`${API_BASE}/dashboard-stats`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        if (data && data.status === 'success') {
          setStats(data.stats)
          setLatest(Array.isArray(data.latest) ? data.latest : [])
          setError(null)
        } else {
          setError(data?.error || 'unexpected response')
        }
      } catch (e) {
        if (!cancelled) {
          setError(friendlyApiError(e, API_BASE))
        }
      } finally {
        inFlight = false
        if (!cancelled) {
          timer = window.setTimeout(fetchStats, POLL_MS)
        }
      }
    }

    fetchStats()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  // KPI cards are driven by /dashboard-stats. Tones + helper text are
  // chosen to match the existing 3-card layout (orange / success / danger).
  // Terminology rule: speak in "media / images / videos / renders" — never
  // "recipients" or "templates available," which conflate analytics with
  // unrelated state.
  const kpis = useMemo(() => {
    if (!stats) return null
    const totalMedia = (stats.totalImages || 0) + (stats.totalVideos || 0)
    // Helper for the headline card — show the breakdown when both kinds
    // exist; otherwise just the relevant one.
    let mediaHelper
    if (stats.totalImages && stats.totalVideos) {
      mediaHelper = `${stats.totalVideos} videos · ${stats.totalImages} images`
    } else if (stats.totalVideos) {
      mediaHelper = `${stats.totalVideos} videos`
    } else if (stats.totalImages) {
      mediaHelper = `${stats.totalImages} images`
    } else {
      mediaHelper = 'no renders yet'
    }
    return [
      {
        label:  'Media Generated',
        value:  String(totalMedia),
        tone:   'orange',
        helper: mediaHelper,
      },
      {
        label:  'Media Sent',
        value:  String((stats.videosSent || 0) + (stats.imagesSent || 0)),
        tone:   'success',
        // Mirrors the "Media Generated" helper format so the two cards
        // read as a matched pair. Wires up to delivery tracking once the
        // WhatsApp integration is live — until then the counts are 0.
        helper: `${stats.videosSent || 0} videos sent · ${stats.imagesSent || 0} images sent`,
      },
      {
        label:  'Failed',
        value:  String(stats.failedCount),
        tone:   'danger',
        helper: stats.failedCount > 0
          ? `${stats.failedCount} render${stats.failedCount === 1 ? '' : 's'} — needs retry`
          : 'all renders successful',
      },
    ]
  }, [stats])

  // Generated card: most recent 6 entries; Delivery card: most recent 6.
  // (latest from API is already capped at 6 server-side.)
  const generatedRows = latest.slice(0, 6)
  const deliveryRows  = latest.slice(0, 6)

  return (
    <>
      <GenerateModal open={generateOpen} onClose={() => setGenerateOpen(false)} />

      {error && (
        <div className="tmpl-error" role="alert" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚠️</span> {error}
        </div>
      )}

      {/* KPI row -------------------------------------------------------- */}
      <div className="op-kpi-grid op-kpi-grid-3">
        {(kpis || [
          { label: 'Media Generated',  value: '—', tone: 'orange',  helper: 'loading…' },
          { label: 'Media Sent',       value: '—', tone: 'success', helper: 'loading…' },
          { label: 'Failed',           value: '—', tone: 'danger',  helper: 'loading…' },
        ]).map((k) => (
          <section key={k.label} className={`op-kpi op-kpi-${k.tone}`}>
            <div className="op-kpi-label">{k.label}</div>
            <div className="op-kpi-value">{k.value}</div>
            {k.helper && <div className="op-kpi-helper">{k.helper}</div>}
          </section>
        ))}
      </div>

      {/* Action row ----------------------------------------------------- */}
      <div className="op-actions">
        {ACTIONS.map((a) => {
          const inner = (
            <>
              <span className={`op-action-icon op-action-icon-${a.tone}`}>{a.icon}</span>
              <div className="op-action-body">
                <div className="op-action-title">{a.title}</div>
                <div className="op-action-desc">{a.desc}</div>
              </div>
            </>
          )
          if (a.to === 'generate') {
            return (
              <button
                key="generate"
                type="button"
                className="op-action op-action-button"
                onClick={() => setGenerateOpen(true)}
              >
                {inner}
              </button>
            )
          }
          return (
            <Link key={a.to} to={a.to} className="op-action">
              {inner}
            </Link>
          )
        })}
      </div>

      {/* Generated + Delivery ------------------------------------------- */}
      <div className="op-grid">
        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">Generated Media</h2>
              <p className="dash-card-sub">Most recent personalised renders.</p>
            </div>
            <Link to="/generated" className="btn-explore">
              All media <span aria-hidden="true">→</span>
            </Link>
          </div>

          {generatedRows.length === 0 ? (
            <div className="op-empty">
              No personalised media yet. Use the <strong>Generate Media</strong> action above to create your first one.
            </div>
          ) : (
            <ul className="op-list">
              {generatedRows.map((g) => {
                const label = dashboardStatusLabel(g.status)
                return (
                  <li key={g.id} className="op-row">
                    <span className={`op-avatar op-avatar-${toneFor(g.id)}`}>
                      {initialsOf(g.name)}
                    </span>
                    <div className="op-row-body">
                      <div className="op-row-name">{g.name}</div>
                      <div className="op-row-meta">Generated · {formatGeneratedAt(g.createdAt)}</div>
                    </div>
                    <span className={`op-pill ${statusClass(label)}`}>
                      <span className="op-pill-dot" aria-hidden="true">{statusIcon(label)}</span>
                      {label}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">Delivery Status</h2>
              <p className="dash-card-sub">Latest WhatsApp delivery results.</p>
            </div>
            <Link to="/delivery" className="btn-explore">
              All delivery <span aria-hidden="true">→</span>
            </Link>
          </div>

          {deliveryRows.length === 0 ? (
            <div className="op-empty">
              No deliveries to show yet.
            </div>
          ) : (
          <div className="op-table-wrap">
            <table className="op-table">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Time sent</th>
                </tr>
              </thead>
              <tbody>
                {deliveryRows.map((d) => {
                  const label = dashboardStatusLabel(d.status)
                  const isSent = label === 'Sent'
                  return (
                    <tr key={d.id}>
                      <td className="op-table-name">{d.name}</td>
                      <td>
                        <span className={`op-pill ${statusClass(label)}`}>
                          <span className="op-pill-dot" aria-hidden="true">{statusIcon(label)}</span>
                          {label}
                        </span>
                      </td>
                      <td className="op-table-time">{isSent ? formatGeneratedAt(d.createdAt) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
        </section>
      </div>

      {/* Promotional banner — a single premium orange automation card. */}
      <section className="dash-banner" aria-label="Abacus automation overview">
        <div className="dash-banner-bg" aria-hidden="true">
          <div className="dash-banner-glow dash-banner-glow-tl" />
          <div className="dash-banner-glow dash-banner-glow-br" />
          <div className="dash-banner-mesh" />
        </div>

        <div className="dash-banner-art" aria-hidden="true">
          <svg viewBox="0 0 160 160" className="dash-banner-abacus" xmlns="http://www.w3.org/2000/svg">
            <rect x="20" y="24" width="120" height="112" rx="14"
                  fill="rgba(255, 255, 255, 0.10)"
                  stroke="rgba(255, 255, 255, 0.85)" strokeWidth="3" />
            <line x1="20" y1="56"  x2="140" y2="56"  stroke="rgba(255,255,255,0.42)" strokeWidth="2" />
            <line x1="20" y1="80"  x2="140" y2="80"  stroke="rgba(255,255,255,0.42)" strokeWidth="2" />
            <line x1="20" y1="104" x2="140" y2="104" stroke="rgba(255,255,255,0.42)" strokeWidth="2" />
            {/* Row 1 */}
            <circle cx="40"  cy="56" r="6.5" fill="#FFFFFF" />
            <circle cx="60"  cy="56" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="80"  cy="56" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="100" cy="56" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="120" cy="56" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            {/* Row 2 */}
            <circle cx="40"  cy="80" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="60"  cy="80" r="6.5" fill="#FFFFFF" />
            <circle cx="80"  cy="80" r="6.5" fill="#FFFFFF" />
            <circle cx="100" cy="80" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="120" cy="80" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            {/* Row 3 */}
            <circle cx="40"  cy="104" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="60"  cy="104" r="6.5" fill="rgba(255,255,255,0.18)" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="80"  cy="104" r="6.5" fill="#FFFFFF" />
            <circle cx="100" cy="104" r="6.5" fill="#FFFFFF" />
            <circle cx="120" cy="104" r="6.5" fill="#FFFFFF" />
          </svg>
        </div>

        <div className="dash-banner-body">
          <h2 className="dash-banner-title">
            Boost Your Reach with Abacus Automation <span aria-hidden="true">🚀</span>
          </h2>
          <p className="dash-banner-sub">
            Personalised videos. Bulk WhatsApp delivery. Smarter outreach. Better results.
          </p>
          <ul className="dash-banner-feats">
            <li className="dash-banner-feat"><span aria-hidden="true">📈</span> Reach More</li>
            <li className="dash-banner-feat"><span aria-hidden="true">⏱️</span> Save Time</li>
            <li className="dash-banner-feat"><span aria-hidden="true">🎯</span> Better Results</li>
            <li className="dash-banner-feat"><span aria-hidden="true">📡</span> Real-time Tracking</li>
          </ul>
        </div>
      </section>
    </>
  )
}
