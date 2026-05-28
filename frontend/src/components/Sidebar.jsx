import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import SetupAssistant from './SetupAssistant'

// Settings has been moved to the profile dropdown — only operational pages
// belong in the sidebar nav now.
const NAV_ITEMS = [
  { to: '/',           label: 'Dashboard',        icon: '▦' },
  { to: '/templates',  label: 'Upload Template',  icon: '↑' },
  { to: '/sheets',     label: 'Google Sheets',    icon: '▥' },
  { to: '/generated',  label: 'Generated Media',  icon: '▣' },
  { to: '/delivery',   label: 'WhatsApp Send',    icon: '➤' },
]

export default function Sidebar() {
  const [assistantOpen, setAssistantOpen] = useState(false)

  // Close on Escape when the modal is open.
  useEffect(() => {
    if (!assistantOpen) return
    function onKey(e) { if (e.key === 'Escape') setAssistantOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [assistantOpen])

  return (
    <aside className="sidebar">
      <div className="brand">
        <img
          src="/mastermind-logo.jpg"
          alt="Mastermind Abacus — The Brain Booster"
          className="brand-img"
          width="200"
          height="200"
        />
      </div>

      <nav className="nav">
        <div className="nav-group">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `nav-item${isActive ? ' nav-item-active' : ''}`
              }
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn btn-brand sidebar-cta sidebar-cta-assistant"
          onClick={() => setAssistantOpen(true)}
          aria-haspopup="dialog"
        >
          <span className="sidebar-cta-icon" aria-hidden="true">✨</span>
          <span className="sidebar-cta-label">
            <span className="sidebar-cta-title">Setup Assistant</span>
            <span className="sidebar-cta-hint">Guided 4-step workflow</span>
          </span>
        </button>
      </div>

      <SetupAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
      />
    </aside>
  )
}
