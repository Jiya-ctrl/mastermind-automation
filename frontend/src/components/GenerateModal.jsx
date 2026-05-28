import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRecipientsStore } from '../store/recipients'

import { API_BASE } from '../config'

export default function GenerateModal({ open, onClose }) {
  const [name, setName]       = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone]     = useState('')
  // Generation mode — strictly one or the other. Image is default because
  // it's much faster (sub-second vs 30-60s for video) so users who don't
  // explicitly pick get the cheaper outcome.
  const [kind, setKind] = useState('image')
  // 'idle' | 'loading' | 'success' | 'error'
  const [phase, setPhase] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const firstInputRef = useRef(null)
  const addFromGenerate = useRecipientsStore((s) => s.addFromGenerate)

  // Reset on open
  useEffect(() => {
    if (open) {
      setPhase('idle')
      setError(null)
      setResult(null)
      setKind('image')
      const t = setTimeout(() => firstInputRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [open])

  // Esc to close (only when not loading — never abandon a render)
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape' && phase !== 'loading') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, phase, onClose])

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  const submit = useCallback(async (e) => {
    e.preventDefault()
    const n = name.trim()
    const a = address.trim()
    const p = phone.trim()
    if (!a || !p) return
    setPhase('loading')
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, address: a, phone: p, kind }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.status !== 'success') {
        const msg =
          data?.error ||
          (data?.image?.stderr || '').trim().split('\n').pop() ||
          (data?.video?.stderr || '').trim().split('\n').pop() ||
          `Server returned HTTP ${res.status}`
        throw new Error(msg)
      }
      // Persist the new entry so it appears on Dashboard / Generated / Delivery.
      try {
        addFromGenerate({
          name: n,
          address: a,
          phone: p,
          imagePath: data?.image?.path || null,
          videoPath: data?.video?.path || null,
        })
      } catch (storeErr) {
        // Store failure should not break the user-visible success state.
        // Gated to DEV so production consoles stay clean.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.error('Failed to persist recipient:', storeErr)
        }
      }
      setResult(data)
      setPhase('success')
    } catch (err) {
      // Network failures land here (Failed to fetch, etc.)
      setError(
        err?.message?.includes('Failed to fetch')
          ? 'Could not reach API at ' + API_BASE + '. Is the Flask server running?'
          : err?.message || 'Generation failed'
      )
      setPhase('error')
    }
  }, [name, address, phone, kind, addFromGenerate])

  const retry = useCallback(() => {
    setPhase('idle')
    setError(null)
  }, [])

  if (!open) return null

  // Render via portal at the document body so the overlay escapes any
  // ancestor stacking context (the sidebar's backdrop-filter establishes
  // its own, which previously kept the dim layer below the sidebar).
  return createPortal(
    <div
      className="gm-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget && phase !== 'loading') onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gm-title"
    >
      <div className="gm-dialog">
        <div className="gm-head">
          <h2 id="gm-title" className="gm-title">Generate Personalised Media</h2>
          {phase !== 'loading' && (
            <button
              type="button"
              className="gm-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>

        {phase === 'idle' && (
          <form onSubmit={submit} className="gm-body" noValidate>
            <p className="gm-help">
              Personalise an image or a video for one recipient. Pick the
              format below — pipelines are strictly independent, so you
              only pay for what you choose.
            </p>
            {/* Kind toggle — strict one-or-the-other. Image is the faster,
                cheaper default; Video is opt-in. */}
            <div className="gm-kind" role="radiogroup" aria-label="Generation mode">
              <label className={`gm-kind-opt${kind === 'image' ? ' gm-kind-opt-active' : ''}`}>
                <input
                  type="radio"
                  name="gm-kind"
                  value="image"
                  checked={kind === 'image'}
                  onChange={() => setKind('image')}
                />
                <span className="gm-kind-icon" aria-hidden="true">🖼</span>
                <span className="gm-kind-body">
                  <span className="gm-kind-title">Generate Image</span>
                  <span className="gm-kind-hint">PNG · fast (under 1s)</span>
                </span>
              </label>
              <label className={`gm-kind-opt${kind === 'video' ? ' gm-kind-opt-active' : ''}`}>
                <input
                  type="radio"
                  name="gm-kind"
                  value="video"
                  checked={kind === 'video'}
                  onChange={() => setKind('video')}
                />
                <span className="gm-kind-icon" aria-hidden="true">🎬</span>
                <span className="gm-kind-body">
                  <span className="gm-kind-title">Generate Video</span>
                  <span className="gm-kind-hint">MP4 · 30–60 seconds</span>
                </span>
              </label>
            </div>
            <label className="gm-field">
              <span className="gm-field-label">Recipient name</span>
              <input
                ref={firstInputRef}
                type="text"
                className="gm-input"
                placeholder="e.g. Aarav Sharma"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </label>
            <label className="gm-field">
              <span className="gm-field-label">Address</span>
              <input
                type="text"
                className="gm-input"
                placeholder="e.g. SKF Colony, Pune"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                maxLength={120}
                required
              />
            </label>
            <label className="gm-field">
              <span className="gm-field-label">Phone number</span>
              <input
                type="text"
                className="gm-input"
                placeholder="e.g. +91 77700 80900"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={80}
                required
              />
            </label>
            <div className="gm-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="btn btn-brand"
                disabled={!address.trim() || !phone.trim()}
              >
                {kind === 'image' ? 'Generate Image' : 'Generate Video'}
              </button>
            </div>
          </form>
        )}

        {phase === 'loading' && (
          <div className="gm-body gm-status">
            <div className="gm-spinner" aria-hidden="true" />
            <p className="gm-status-title">
              {kind === 'image'
                ? 'Generating image render…'
                : 'Generating video render…'}
            </p>
            <p className="gm-status-sub">
              {kind === 'image'
                ? 'Rendering the personalised PNG. Should be ready in a second.'
                : 'Compositing the personalised MP4 with libass. This usually takes 30–60 seconds.'}
            </p>
          </div>
        )}

        {phase === 'success' && result && (
          <div className="gm-body gm-status">
            <div className="gm-tick" aria-hidden="true">✓</div>
            <p className="gm-status-title">
              {result.kind === 'video'
                ? 'Video generated successfully'
                : 'Image generated successfully'}
            </p>
            {result.image?.path && (
              <div className="gm-result-line">
                <span className="gm-result-label">Image</span>
                <code className="gm-result-path">{result.image.path}</code>
              </div>
            )}
            {result.video?.path && (
              <div className="gm-result-line">
                <span className="gm-result-label">Video</span>
                <code className="gm-result-path">{result.video.path}</code>
              </div>
            )}
            <div className="gm-actions">
              <button type="button" className="btn btn-secondary" onClick={retry}>
                Generate another
              </button>
              <button type="button" className="btn btn-brand" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="gm-body gm-status">
            <div className="gm-cross" aria-hidden="true">!</div>
            <p className="gm-status-title">Generation failed</p>
            <p className="gm-error-detail">{error}</p>
            <div className="gm-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-brand" onClick={retry}>Retry</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
