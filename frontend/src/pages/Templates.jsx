import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import { API_BASE, BACKEND_CONFIGURED } from '../config'
import { useTemplateSlot } from '../TemplateContext'

const MAX_BYTES = 200 * 1024 * 1024 // 200 MB hard cap (matches the dropzone copy)

const ACCEPT = {
  video: 'video/mp4,video/quicktime,video/x-msvideo,video/*',
  image: 'image/png,image/jpeg,image/webp,image/*',
}

function prettySize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function extOf(filename) {
  if (!filename) return ''
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1).toUpperCase() : ''
}

export default function Templates() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('video') // 'video' | 'image'
  // Template preview lives in a context that outlives route transitions
  // so navigating to /sheets and back doesn't wipe the drop-zone state.
  // Each kind has its own slot; switching the tab swaps which slot we
  // read/write.
  const videoSlot = useTemplateSlot('video')
  const imageSlot = useTemplateSlot('image')
  const activeSlot = mode === 'video' ? videoSlot : imageSlot
  const file       = activeSlot.slot?.file ?? null
  const previewURL = activeSlot.slot?.previewURL ?? null
  const [dragging, setDragging] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [savedInfo, setSavedInfo] = useState(null) // { path, bytes, kind }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // Transient post-save toast — replaces the persistent green "Saved" badge.
  // Auto-dismisses after a short window so the page stays clean.
  const [toast, setToast] = useState(null) // { message } | null
  const toastTimerRef = useRef(null)
  // Persistent saved-template state from backend. Each entry:
  // { filename, url, size, mtime } or null.
  const [remote, setRemote] = useState({ video: null, image: null })
  const inputRef = useRef(null)

  function showToast(message) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ message })
    toastTimerRef.current = setTimeout(() => setToast(null), 2400)
  }
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
  }, [])

  // Fetch one kind from /current-template. 404 → null entry; non-404 errors
  // bubble to the operator-facing error banner.
  async function fetchCurrent(kind) {
    try {
      const res = await fetch(`${API_BASE}/current-template?kind=${kind}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data && data.status === 'success' && data.url) {
        return {
          filename: data.filename,
          url:      data.url,
          size:     data.size,
          mtime:    data.mtime,
        }
      }
      return null
    } catch (e) {
      // Network failure — surface via the error banner once.
      const msg = (e && e.message) ? e.message : String(e)
      setError((prev) => prev || `Could not load saved ${kind} template: ${msg}.`)
      return null
    }
  }

  // Hydrate both kinds in parallel on mount so the saved template appears
  // immediately after a refresh / Vite restart / Flask restart. In
  // frontend-preview mode there's no backend to query — skip entirely.
  useEffect(() => {
    if (!BACKEND_CONFIGURED) return
    let cancelled = false
    Promise.all([fetchCurrent('video'), fetchCurrent('image')]).then(([v, i]) => {
      if (cancelled) return
      setRemote({ video: v, image: i })
    })
    return () => { cancelled = true }
  }, [])

  function validate(f) {
    if (!f) return 'No file selected.'
    if (f.size > MAX_BYTES) {
      return `File is ${prettySize(f.size)}; max allowed is 200 MB.`
    }
    const type = f.type || ''
    if (mode === 'video' && !type.startsWith('video/')) {
      return `Selected file is "${type || 'unknown type'}". Switch to Image mode to upload it.`
    }
    if (mode === 'image' && !type.startsWith('image/')) {
      return `Selected file is "${type || 'unknown type'}". Switch to Video mode to upload it.`
    }
    return null
  }

  function handleFiles(list) {
    const f = list && list[0]
    if (!f) return
    const err = validate(f)
    if (err) {
      setError(err)
      return
    }
    setError(null)
    // Revoke the previous object URL before swapping it for a fresh one
    // so we don't leak blobs across re-picks.
    if (previewURL) {
      try { URL.revokeObjectURL(previewURL) } catch (_) {}
    }
    const url = URL.createObjectURL(f)
    activeSlot.setSlot({
      file:       f,
      previewURL: url,
      name:       f.name,
      size:       f.size,
      type:       f.type,
      savedAt:    null,
    })
    setSavedAt(null)
    setSavedInfo(null)
  }

  function onDragOver(e) {
    e.preventDefault()
    setDragging(true)
  }
  function onDragLeave() {
    setDragging(false)
  }
  function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  function clearFile() {
    activeSlot.clearSlot()
    setSavedAt(null)
    setSavedInfo(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  function changeMode(next) {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  async function saveTemplate() {
    if (!file || saving) return
    if (!BACKEND_CONFIGURED) {
      // No backend wired yet — keep the local preview, mark it "saved"
      // so the Proceed → CTA appears, and let the operator continue
      // exploring the UI without an upload round-trip.
      setSavedAt(new Date())
      showToast('Saved in this session — backend not connected')
      activeSlot.setSlot({
        ...activeSlot.slot,
        savedAt: Date.now(),
      })
      return
    }
    setError(null)
    setSaving(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', mode)
      const res = await fetch(`${API_BASE}/upload-template`, {
        method: 'POST',
        body: form,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `upload failed (HTTP ${res.status})`)
      }
      setSavedInfo({ path: data.path, bytes: data.bytes, kind: data.kind })
      setSavedAt(new Date())
      showToast(`${mode === 'video' ? 'Video' : 'Image'} template uploaded`)
      // Refresh the persistent saved state so a subsequent reload (or even
      // an immediate clearFile() in this session) shows the new template.
      const fresh = await fetchCurrent(mode)
      setRemote((prev) => ({ ...prev, [mode]: fresh }))
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Save failed: ${msg}. Is the API running on ${API_BASE}?`)
    } finally {
      setSaving(false)
    }
  }

  // ---------- derived render state ----------
  const currentRemote = remote[mode]
  // Decide which source feeds the preview block:
  //   1) local File picked this session  → local
  //   2) backend says a template exists  → remote
  //   3) else                             → dropzone
  const showLocal  = !!file
  const showRemote = !file && !!currentRemote
  const showDrop   = !file && !currentRemote

  return (
    <>
      <PageHeader
        title="Upload Base Media"
        subtitle="Upload the master video or image that every personalised render will start from."
      />

      <section className="card tmpl-card">
        <div className="tmpl-toggle-row">
          <div className="seg-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'video'}
              className={`seg${mode === 'video' ? ' seg-active' : ''}`}
              onClick={() => changeMode('video')}
            >
              🎬 Video
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'image'}
              className={`seg${mode === 'image' ? ' seg-active' : ''}`}
              onClick={() => changeMode('image')}
            >
              🖼️ Image
            </button>
          </div>
        </div>

        {/* The file input is rendered unconditionally so that the "Choose a
            different file" button on the remote-preview view can still
            trigger it via inputRef. */}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT[mode]}
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />

        {showDrop && (
          <div
            className={`tmpl-drop${dragging ? ' tmpl-drop-active' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
            aria-label={`Drop a ${mode} here, or click to browse`}
          >
            <div className="tmpl-drop-art" aria-hidden="true">
              <div className="tmpl-drop-art-circle">
                <span className="tmpl-drop-art-icon">
                  {mode === 'video' ? '🎬' : '🖼️'}
                </span>
              </div>
              <div className="tmpl-drop-art-glow" />
            </div>
            <h3 className="tmpl-drop-title">Drop your {mode} here</h3>
            <p className="tmpl-drop-sub">
              or <span className="tmpl-drop-link">click to browse</span> ·{' '}
              {mode === 'video' ? 'MP4, MOV, WebM' : 'PNG, JPG, WebP'} · up to 200 MB
            </p>
          </div>
        )}

        {showLocal && (
          <div className="tmpl-preview">
            <div className="tmpl-preview-media">
              {mode === 'video' ? (
                <video
                  className="tmpl-preview-video"
                  src={previewURL}
                  controls
                  preload="metadata"
                />
              ) : (
                <img
                  className="tmpl-preview-image"
                  src={previewURL}
                  alt={file.name}
                />
              )}
            </div>
            <div className="tmpl-preview-meta">
              <div className="tmpl-preview-name">{file.name}</div>
              <div className="tmpl-preview-stats">
                <span>{(file.type || '').split('/')[1]?.toUpperCase() || extOf(file.name) || 'FILE'}</span>
                <span className="tmpl-preview-dot" aria-hidden="true">•</span>
                <span>{prettySize(file.size)}</span>
              </div>
              <div className="tmpl-preview-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={clearFile}
                >
                  Choose a different file
                </button>
                {savedAt ? (
                  <button
                    type="button"
                    className="btn btn-brand tmpl-proceed-btn"
                    onClick={() => navigate('/sheets')}
                    title="Continue to the recipient list"
                  >
                    Proceed <span className="tmpl-proceed-arrow" aria-hidden="true">→</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-brand"
                    onClick={saveTemplate}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save Template'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {showRemote && (
          <div className="tmpl-preview">
            <div className="tmpl-preview-media">
              {mode === 'video' ? (
                <video
                  className="tmpl-preview-video"
                  src={`${API_BASE}${currentRemote.url}`}
                  controls
                  preload="metadata"
                />
              ) : (
                <img
                  className="tmpl-preview-image"
                  src={`${API_BASE}${currentRemote.url}`}
                  alt={currentRemote.filename}
                />
              )}
            </div>
            <div className="tmpl-preview-meta">
              <div className="tmpl-preview-name">{currentRemote.filename}</div>
              <div className="tmpl-preview-stats">
                <span>{extOf(currentRemote.filename) || 'FILE'}</span>
                <span className="tmpl-preview-dot" aria-hidden="true">•</span>
                <span>{prettySize(currentRemote.size)}</span>
              </div>
              <div className="tmpl-preview-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => inputRef.current?.click()}
                >
                  Choose a different file
                </button>
                <button
                  type="button"
                  className="btn btn-brand tmpl-proceed-btn"
                  onClick={() => navigate('/sheets')}
                  title="Continue to the recipient list"
                >
                  Proceed <span className="tmpl-proceed-arrow" aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="tmpl-error" role="alert">
            <span aria-hidden="true">⚠️</span> {error}
          </div>
        )}

        <p className="tmpl-helper">
          Your uploaded template will be used for personalised media generation
        </p>
      </section>

      {toast && (
        <div className="tmpl-toast" role="status" aria-live="polite">
          <span className="tmpl-toast-tick" aria-hidden="true">✓</span>
          {toast.message}
        </div>
      )}
    </>
  )
}
