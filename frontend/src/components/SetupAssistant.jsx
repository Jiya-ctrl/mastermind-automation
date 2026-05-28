import { useNavigate } from 'react-router-dom'

// Four steps that mirror the real product workflow.
const STEPS = [
  {
    n:     1,
    icon:  '↑',
    title: 'Upload base media',
    body:  'Drop your master video or image template. Every personalised render starts from this.',
    to:    '/templates',
  },
  {
    n:     2,
    icon:  '▥',
    title: 'Connect recipients',
    body:  'Paste CSV, upload an Excel file, or connect a public Google Sheet of recipients.',
    to:    '/sheets',
  },
  {
    n:     3,
    icon:  '▣',
    title: 'Generate personalised videos',
    body:  'Each row becomes its own personalised render with an address + contact overlay.',
    to:    '/generated',
  },
  {
    n:     4,
    icon:  '➤',
    title: 'Send via WhatsApp',
    body:  'Queue + send with retry, persistence and live status tracking.',
    to:    '/delivery',
  },
]

export default function SetupAssistant({ open, onClose }) {
  const navigate = useNavigate()
  if (!open) return null

  function goTo(path) {
    onClose()
    navigate(path)
  }

  return (
    <div
      className="sa-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sa-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="sa-modal">
        <button
          type="button"
          className="sa-close"
          aria-label="Close"
          onClick={onClose}
        >×</button>

        <div className="sa-head">
          <span className="sa-eyebrow">✨ Setup Assistant</span>
          <h2 className="sa-title" id="sa-title">
            Your campaign in <span className="sa-title-accent">four steps</span>
          </h2>
          <p className="sa-sub">
            A short walkthrough of how Mastermind Automation turns a recipient
            list into personalised WhatsApp deliveries.
          </p>
        </div>

        <ol className="sa-steps">
          {STEPS.map((s) => (
            <li className="sa-step" key={s.n}>
              <div className="sa-step-num">{s.n}</div>
              <div className="sa-step-body">
                <div className="sa-step-row">
                  <span className="sa-step-icon" aria-hidden="true">{s.icon}</span>
                  <strong className="sa-step-title">{s.title}</strong>
                </div>
                <p className="sa-step-text">{s.body}</p>
                <button
                  type="button"
                  className="sa-step-link"
                  onClick={() => goTo(s.to)}
                >
                  Go to step <span aria-hidden="true">→</span>
                </button>
              </div>
            </li>
          ))}
        </ol>

        <div className="sa-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-brand"
            onClick={() => goTo('/templates')}
          >
            Start with step 1
          </button>
        </div>
      </div>
    </div>
  )
}
