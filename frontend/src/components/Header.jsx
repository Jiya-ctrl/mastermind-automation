import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { signOut as authSignOut } from '../auth'

export default function Header() {
  const { pathname } = useLocation()
  const navigate     = useNavigate()
  const onDashboard  = pathname === '/'

  // Profile dropdown.
  const [menuOpen, setMenuOpen] = useState(false)
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
  function signOut() {
    setMenuOpen(false)
    authSignOut()
    navigate('/login', { replace: true })
  }

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
                onClick={signOut}
              >
                <span className="profile-menu-icon">⏻</span> Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
