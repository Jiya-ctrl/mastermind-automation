import { useEffect, useRef, useState } from 'react'

const FEED = [
  { id: 1, icon: '✅', tone: 'success', title: 'Spring Enrolment campaign completed',  meta: '847 / 847 delivered · 2m ago' },
  { id: 2, icon: '⚠️', tone: 'danger',  title: '3 deliveries failed in Hyderabad batch', meta: 'Invalid WhatsApp numbers · 6m ago' },
  { id: 3, icon: '🚀', tone: 'info',    title: 'Mumbai Outreach campaign launched',     meta: '287 recipients in queue · 18m ago' },
  { id: 4, icon: '📄', tone: 'muted',   title: 'Google Sheet synced',                   meta: '1,245 rows · 22m ago' },
  { id: 5, icon: '🎨', tone: 'info',    title: 'Template "Pune Branch" updated',        meta: 'by Naveen · 1h ago' },
]

export default function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    function onEsc(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div className="notif-wrap" ref={ref}>
      <button
        type="button"
        className={`icon-btn${open ? ' icon-btn-active' : ''}`}
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        <span className="dot" />
      </button>
      {open && (
        <div className="notif-panel" role="menu">
          <div className="notif-panel-head">
            <div>
              <div className="notif-title">Notifications</div>
              <div className="notif-sub">{FEED.length} new updates</div>
            </div>
            <button type="button" className="btn btn-ghost">Mark all read</button>
          </div>
          <ul className="notif-feed">
            {FEED.map((n) => (
              <li key={n.id} className="notif-item">
                <span className={`notif-icon notif-icon-${n.tone}`}>{n.icon}</span>
                <div className="notif-body">
                  <div className="notif-item-title">{n.title}</div>
                  <div className="notif-item-meta">{n.meta}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="notif-panel-foot">
            <button type="button" className="btn btn-ghost">View all activity →</button>
          </div>
        </div>
      )}
    </div>
  )
}
