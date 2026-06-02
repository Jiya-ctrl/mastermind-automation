import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { signOut as authSignOut } from '../auth'

export default function Header() {
  const { pathname } = useLocation()
  const navigate     = useNavigate()
  const onDashboard  = pathname === '/'

  // Profile dropdown.
  const [menuOpen, setMenuOpen] = useState(false)
  // Logout confirmation modal — surfaced when the operator clicks Logout
  // from the profile dropdown so an accidental click doesn't kill an
  // in-progress send batch.
  const [confirmLogout, setConfirmLogout] = useState(false)
  const wrapperRef = useRef(null)

  // Welcome heading glow — fires once after a fresh login. The voice
  // itself is fired from Login (inside the user gesture) so the browser
  // doesn't block autoplay; here we just paint the amber halo.
  const [welcoming, setWelcoming] = useState(false)
  useEffect(() => {
    if (!onDashboard) return
    let pending = false
    try { pending = sessionStorage.getItem('mm_welcome_pending') === '1' } catch (_) {}
    if (!pending) return
    try { sessionStorage.removeItem('mm_welcome_pending') } catch (_) {}

    const startT = setTimeout(() => setWelcoming(true), 200)
    const endT   = setTimeout(() => setWelcoming(false), 3600)
    return () => { clearTimeout(startT); clearTimeout(endT) }
  }, [onDashboard])

  useEffect(() => {
    if (!menuOpen) return
    function onDocClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    function onEsc(e) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menuOpen])

  // Close the menu whenever the route changes.
  useEffect(() => { setMenuOpen(false) }, [pathname])

  function go(path) {
    setMenuOpen(false)
    navigate(path)
  }
  function askLogout() {
    setMenuOpen(false)
    setConfirmLogout(true)
  }
  function confirmedSignOut() {
    setConfirmLogout(false)
    authSignOut()
    navigate('/login', { replace: true })
  }

  // Escape closes the confirmation modal; click on the dimmed backdrop
  // also closes it (preserving the in-progress workflow).
  useEffect(() => {
    if (!confirmLogout) return
    const onKey = (e) => { if (e.key === 'Escape') setConfirmLogout(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmLogout])

  return (
    <header className={`header${onDashboard ? '' : ' header-slim'}`}>
      {onDashboard && <div className="header-orb" aria-hidden="true" />}
      <div className="header-left">
        {onDashboard && (
          <>
            <h1 className={`header-greeting${welcoming ? ' header-greeting-welcoming' : ''}`}>
              Welcome back,{' '}
              <span className="header-greeting-brand">Mastermind</span>{' '}
              <span className="header-greeting-wave" aria-hidden="true">👋</span>
            </h1>
            <p className="header-subtitle">
              Automate outreach. Personalise engagement. Scale effortlessly.
            </p>
          </>
        )}
        {/* Non-Dashboard pages: contextual title now lives in the
            page-level orange banner (PageHeader). The top bar carries
            only the user controls on those pages. */}
      </div>

      <div className="header-right">
        <div className="profile-wrapper" ref={wrapperRef}>
          <button
            type="button"
            className={`profile profile-button${menuOpen ? ' profile-open' : ''}`}
            onClick={() => setMenuOpen((x) => !x)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <div className="avatar avatar-logo" aria-hidden="true">
              <img src="/mastermind-logo.jpg" alt="" />
            </div>
            <div className="profile-meta">
              <div className="profile-name">Mastermind</div>
              <div className="profile-role">ADMINISTRATOR</div>
            </div>
            <span className="profile-chevron" aria-hidden="true">▾</span>
          </button>

          {menuOpen && (
            <div className="profile-menu" role="menu">
              <div className="profile-menu-head">
                <div className="profile-menu-name">Mastermind</div>
                <div className="profile-menu-mail">admin@mastermindabacus.com</div>
              </div>
              <button
                type="button"
                role="menuitem"
                className="profile-menu-item"
                onClick={() => go('/settings')}
              >
                <span className="profile-menu-icon">⚙</span> Settings
              </button>
              <div className="profile-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="profile-menu-item profile-menu-item-danger"
                onClick={askLogout}
              >
                <span className="profile-menu-icon">⏻</span> Logout
              </button>
            </div>
          )}
        </div>
      </div>

      {confirmLogout && createPortal(
        <div
          className="logout-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-confirm-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmLogout(false)
          }}
        >
          <div className="logout-confirm-card">
            <div className="logout-confirm-icon" aria-hidden="true">⏻</div>
            <h3 id="logout-confirm-title" className="logout-confirm-title">
              Sign out of the workspace?
            </h3>
            <p className="logout-confirm-sub">
              You'll be returned to the login screen. Any in-progress send
              batches will continue running in the background.
            </p>
            <div className="logout-confirm-actions">
              <button
                type="button"
                className="logout-confirm-btn logout-confirm-btn-cancel"
                onClick={() => setConfirmLogout(false)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="logout-confirm-btn logout-confirm-btn-danger"
                onClick={confirmedSignOut}
              >
                Yes, sign out
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </header>
  )
}
