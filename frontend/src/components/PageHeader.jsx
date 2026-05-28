import { useLocation } from 'react-router-dom'

// Step badge + icon for the premium orange banner. Pages don't need to
// pass these — they're derived from the route so the banner stays
// consistent everywhere.
const PAGE_META = {
  '/templates':  { step: 'Step 1 · 4', icon: '↑' },
  '/sheets':     { step: 'Step 2 · 4', icon: '▥' },
  '/generated':  { step: 'Step 3 · 4', icon: '▣' },
  '/delivery':   { step: 'Step 4 · 4', icon: '➤' },
  '/settings':   { step: 'Workspace',  icon: '⚙' },
}

export default function PageHeader({ title, subtitle, actions }) {
  const { pathname } = useLocation()
  const meta = PAGE_META[pathname]

  return (
    <section className="page-banner" aria-label={title}>
      <div className="page-banner-bg" aria-hidden="true">
        <div className="page-banner-glow page-banner-glow-tl" />
        <div className="page-banner-glow page-banner-glow-br" />
        <div className="page-banner-grid" />
      </div>

      {meta && (
        <div className="page-banner-icon" aria-hidden="true">{meta.icon}</div>
      )}

      <div className="page-banner-body">
        {meta && <span className="page-banner-step">{meta.step}</span>}
        <h1 className="page-banner-title">{title}</h1>
        {subtitle && <p className="page-banner-subtitle">{subtitle}</p>}
      </div>

      {actions && <div className="page-banner-actions">{actions}</div>}
    </section>
  )
}
