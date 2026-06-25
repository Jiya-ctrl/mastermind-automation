import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PageHeader from '../components/PageHeader'

import { API_BASE, friendlyApiError } from '../config'
const POLL_MS  = 12000

// Media-kind filter — images and videos are independent pipelines so each
// renders as its own card with its own preview system. This is the ONLY
// filter on the page besides Search; status/date filters were removed for
// a calmer, premium SaaS feel.
const KINDS = [
  { id: 'all',    label: 'All',    icon: '◇' },
  { id: 'images', label: 'Images', icon: '🖼' },
  { id: 'videos', label: 'Videos', icon: '🎬' },
]

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

// Flatten a /list-generated item (which may carry both an image and a video
// for the same recipient) into one card per asset. Each card is typed so the
// grid can render the right preview system and open the right modal — no
// mixing of image-overlay UI for videos or vice-versa.
function flattenToCards(items) {
  const cards = []
  for (const m of items) {
    const base = {
      stem:      m.id,
      name:      m.name,
      status:    m.status,
      createdAt: m.createdAt,
    }
    if (m.image) {
      cards.push({
        ...base,
        cardId:   `${m.id}__image`,
        type:     'image',
        filename: m.image.filename || `${m.id}.png`,
        url:      m.image.url ? `${API_BASE}${m.image.url}` : '',
        size:     m.image.size || 0,
      })
    }
    if (m.video) {
      cards.push({
        ...base,
        cardId:   `${m.id}__video`,
        type:     'video',
        filename: m.video.filename || `${m.id}.mp4`,
        url:      m.video.url ? `${API_BASE}${m.video.url}` : '',
        size:     m.video.size || 0,
      })
    }
  }
  return cards
}

export default function Generated() {
  const [items, setItems]   = useState([])
  const [error, setError]   = useState(null)
  const [loaded, setLoaded] = useState(false)

  const [query, setQuery] = useState('')
  const [kind, setKind]   = useState('all')

  // Selection is keyed by cardId — every media file is its own selectable
  // entity. Selecting the image card for "Banjara_Hills_Hyderabad" does
  // NOT touch the matching video card; they're independent assets with
  // independent delete and download actions.
  const [selected, setSelected] = useState(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [confirmModal, setConfirmModal] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)

  // Preview modal state — one of:
  //   { type: 'image', card }   — lightbox with the full PNG
  //   { type: 'video', card }   — <video controls> player
  //   null
  const [preview, setPreview] = useState(null)

  // Initial load + polling.
  useEffect(() => {
    let cancelled = false
    let timer = null

    async function fetchList() {
      try {
        const res = await fetch(`${API_BASE}/list-generated`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        if (data && data.status === 'success' && Array.isArray(data.items)) {
          setItems(data.items)
          setError(null)
        } else {
          setError(data?.error || 'unexpected response shape')
        }
      } catch (e) {
        if (cancelled) return
        setError(friendlyApiError(e, API_BASE))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }

    fetchList()
    timer = setInterval(fetchList, POLL_MS)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [])

  // Prune selected cards that no longer exist (after a successful delete
  // or external filesystem change). Operates on cardId since selection is
  // per-asset, not per-recipient.
  useEffect(() => {
    if (selected.size === 0) return
    const live = new Set()
    for (const m of items) {
      if (m.image) live.add(`${m.id}__image`)
      if (m.video) live.add(`${m.id}__video`)
    }
    let needsPrune = false
    selected.forEach((id) => { if (!live.has(id)) needsPrune = true })
    if (needsPrune) {
      setSelected((prev) => {
        const next = new Set()
        prev.forEach((id) => { if (live.has(id)) next.add(id) })
        return next
      })
    }
  }, [items])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
  }, [])

  function showToast(message, kind = 'info') {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ kind, message })
    toastTimerRef.current = setTimeout(() => setToast(null), 2600)
  }

  // -------- derived: per-asset cards + filters --------
  const allCards = useMemo(() => flattenToCards(items), [items])

  const cards = useMemo(() => allCards.filter((c) => {
    if (kind === 'images' && c.type !== 'image') return false
    if (kind === 'videos' && c.type !== 'video') return false
    if (!query) return true
    const q = query.toLowerCase()
    const haystack = [c.name || '', c.filename || '', c.stem || '']
    return haystack.some((s) => s.toLowerCase().includes(q))
  }), [allCards, query, kind])

  // Counts per kind for the chip badges. Count distinct assets, not stems,
  // so a recipient with both formats contributes to both Images and Videos.
  const kindCounts = useMemo(() => ({
    all:    allCards.length,
    images: allCards.filter((c) => c.type === 'image').length,
    videos: allCards.filter((c) => c.type === 'video').length,
  }), [allCards])

  // Selection (by cardId) — which cards are visible right now?
  const visibleCardIds = useMemo(() => cards.map((c) => c.cardId), [cards])
  const allVisibleSelected =
    visibleCardIds.length > 0 && visibleCardIds.every((id) => selected.has(id))
  const someSelected = selected.size > 0

  function toggleOne(cardId) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (visibleCardIds.every((id) => prev.has(id))) {
        const next = new Set(prev)
        visibleCardIds.forEach((id) => next.delete(id))
        return next
      }
      const next = new Set(prev)
      visibleCardIds.forEach((id) => next.add(id))
      return next
    })
  }
  function exitSelectionMode() {
    setSelectionMode(false)
    setSelected(new Set())
  }

  useEffect(() => {
    if (!selectionMode) return
    function onKey(e) { if (e.key === 'Escape') exitSelectionMode() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectionMode])

  // Card click — in selection mode toggle THIS card only; otherwise open
  // the preview modal appropriate to the card's type.
  function handleCardClick(e, card) {
    if (e.target.closest('.thumb-select, .thumb-actions, a, button, input')) return
    if (selectionMode) { toggleOne(card.cardId); return }
    setPreview({ type: card.type, card })
  }

  // -------- delete --------
  // Always sends the per-asset { items: [{stem, kind}] } payload so the
  // backend never touches the sibling asset (image's video, or vice-versa).
  async function deleteAssets(assets) {
    if (!assets.length) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/list-generated/delete`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: assets }),
      })
      const data = await res.json().catch(() => ({}))
      const deleted = data?.deleted || []
      const failCount = (data?.failed || []).length
      const imageCount = deleted.filter((d) => d.kind === 'image').length
      const videoCount = deleted.filter((d) => d.kind === 'video').length
      const fresh = await fetch(`${API_BASE}/list-generated`).then((r) => r.json()).catch(() => null)
      if (fresh && fresh.status === 'success') setItems(fresh.items || [])
      setSelectionMode(false)
      setSelected(new Set())
      if (failCount === 0) {
        const parts = []
        if (imageCount) parts.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`)
        if (videoCount) parts.push(`${videoCount} video${videoCount === 1 ? '' : 's'}`)
        showToast(`Deleted ${parts.join(' and ') || 'nothing'}`, 'success')
      } else {
        showToast(`Deleted ${deleted.length}, ${failCount} failed`, 'info')
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Delete failed: ${msg}`)
    } finally {
      setDeleting(false)
      setConfirmModal(null)
    }
  }

  // Map current selection (cardIds) back to the per-asset payload the
  // backend expects: [{stem, kind}, ...].
  function selectedAssets() {
    const byCardId = new Map(allCards.map((c) => [c.cardId, c]))
    const assets = []
    selected.forEach((cardId) => {
      const c = byCardId.get(cardId)
      if (c) assets.push({ stem: c.stem, kind: c.type })
    })
    return assets
  }

  function quickDeleteCard(card, e) {
    e.stopPropagation()
    setConfirmModal({
      assets:  [{ stem: card.stem, kind: card.type }],
      title:   'Delete this file?',
      message: `${card.filename} will be permanently removed from disk.`,
      cta:     'Delete',
    })
  }

  function confirmDeleteSelected() {
    const assets = selectedAssets()
    if (assets.length === 0) return
    const imageCount = assets.filter((a) => a.kind === 'image').length
    const videoCount = assets.filter((a) => a.kind === 'video').length
    const parts = []
    if (imageCount) parts.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`)
    if (videoCount) parts.push(`${videoCount} video${videoCount === 1 ? '' : 's'}`)
    setConfirmModal({
      assets,
      title:   'Delete selected media?',
      message: `${parts.join(' and ')} will be permanently removed from disk. Sibling files are NOT touched.`,
      cta:     `Delete ${assets.length}`,
    })
  }

  // Download every selected asset, file-by-file (image or video — exactly
  // what the user picked, nothing more).
  function downloadSelected() {
    const byCardId = new Map(allCards.map((c) => [c.cardId, c]))
    selected.forEach((cardId) => {
      const c = byCardId.get(cardId)
      if (!c?.url) return
      const a = document.createElement('a')
      a.href = c.url
      a.download = c.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    })
  }

  function handleDownloadAction() {
    if (!selectionMode) { setSelectionMode(true); return }
    if (selected.size === 0) { showToast('Tap renders below to select', 'info'); return }
    downloadSelected()
  }
  function handleDeleteAction() {
    if (!selectionMode) { setSelectionMode(true); return }
    if (selected.size === 0) { showToast('Tap renders below to select', 'info'); return }
    confirmDeleteSelected()
  }

  // Bulk wipe of every file of a given kind. Useful right before running a
  // clean Generate-Images-only or Generate-Videos-only test so the gallery
  // starts empty and the user can confirm exactly what each pipeline produced.
  const [wipeModal, setWipeModal] = useState(null) // { kinds: [...] } | null
  async function wipeKinds(kinds) {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/list-generated/wipe`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ kinds }),
      })
      const data = await res.json().catch(() => ({}))
      const okCount = (data?.deleted || []).length
      const fresh = await fetch(`${API_BASE}/list-generated`).then((r) => r.json()).catch(() => null)
      if (fresh && fresh.status === 'success') setItems(fresh.items || [])
      const label = kinds.length === 2
        ? 'images and videos'
        : `${kinds[0]}s`
      showToast(`Wiped ${okCount} ${label}`, 'success')
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Wipe failed: ${msg}`)
    } finally {
      setDeleting(false)
      setWipeModal(null)
    }
  }

  // Click outside any card / toolbar / action surface / modal exits
  // selection mode (Google Photos / Drive parity).
  useEffect(() => {
    if (!selectionMode) return
    function onDocClick(e) {
      if (e.target.closest(
        '.thumb-generated, .gen-selectbar, .page-banner-actions, ' +
        '.gen-confirm-overlay, .gen-toast, .gen-preview-overlay'
      )) return
      exitSelectionMode()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [selectionMode])

  return (
    <>
      <PageHeader
        title="Generated Media"
        subtitle="Every personalised video and image produced by the pipeline."
        actions={
          !selectionMode ? (
            <>
              <button
                type="button"
                className="btn btn-secondary gen-banner-btn"
                onClick={handleDownloadAction}
                title="Enter selection mode to download renders"
              >⬇ Download</button>
              <button
                type="button"
                className="btn btn-secondary gen-danger-btn gen-banner-btn"
                onClick={handleDeleteAction}
                title="Enter selection mode to delete renders"
              >🗑 Delete</button>
              <button
                type="button"
                className="btn btn-secondary gen-banner-btn gen-wipe-btn"
                onClick={() => setWipeModal({ kinds: ['image', 'video'] })}
                disabled={allCards.length === 0}
                title="Bulk-delete every render on disk — useful for testing pipeline isolation"
              >🧹 Wipe…</button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`btn btn-secondary gen-banner-btn${someSelected ? '' : ' gen-banner-btn-waiting'}`}
                onClick={handleDownloadAction}
                title={someSelected
                  ? `Download ${selected.size} selected ${selected.size === 1 ? 'render' : 'renders'}`
                  : 'Tap renders below to select first'}
              >
                ⬇ Download Selected{someSelected ? ` (${selected.size})` : ''}
              </button>
              <button
                type="button"
                className={`btn btn-secondary gen-danger-btn gen-banner-btn${someSelected ? '' : ' gen-banner-btn-waiting'}`}
                onClick={handleDeleteAction}
                title={someSelected
                  ? `Delete ${selected.size} selected ${selected.size === 1 ? 'render' : 'renders'}`
                  : 'Tap renders below to select first'}
              >
                🗑 Delete Selected{someSelected ? ` (${selected.size})` : ''}
              </button>
              <button
                type="button"
                className="btn btn-ghost gen-banner-btn gen-banner-cancel"
                onClick={exitSelectionMode}
                title="Exit selection mode (ESC)"
              >✕ Cancel</button>
            </>
          )
        }
      />

      {/* Minimal filter bar — search on the left, three Type chips on the
          right. No card chrome, no labels, no extra background — keeps the
          gallery breathing. */}
      <div className="gen-filterbar">
        <div className="gen-filterbar-search">
          <span className="gen-filterbar-search-icon" aria-hidden="true">🔍</span>
          <input
            type="text"
            placeholder="Search recipient or filename…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="gen-filterbar-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >×</button>
          )}
        </div>
        <div className="gen-filterbar-chips" role="tablist" aria-label="Media type">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={kind === k.id}
              className={`gen-kind-chip${kind === k.id ? ' gen-kind-chip-active' : ''}`}
              onClick={() => setKind(k.id)}
            >
              <span className="gen-kind-chip-icon" aria-hidden="true">{k.icon}</span>
              <span className="gen-kind-chip-label">{k.label}</span>
              <span className="gen-kind-chip-count">{kindCounts[k.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {selectionMode && (
        <div className="gen-selectbar gen-selectbar-active">
          <span className="gen-selectbar-count">
            <strong>{selected.size}</strong>
            <span className="gen-selectbar-text-faint">
              {` of ${visibleCardIds.length} selected`}
            </span>
          </span>
          <div className="gen-selectbar-actions">
            <label className="gen-selectbar-all-toggle">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
                aria-label="Select all visible renders"
              />
              <span className="gen-selectbar-box" aria-hidden="true" />
              <span>Select all ({visibleCardIds.length})</span>
            </label>
          </div>
        </div>
      )}

      {error && (
        <div className="tmpl-error" role="alert">
          <span aria-hidden="true">⚠️</span> {error}
        </div>
      )}

      <div className={`gen-grid${selectionMode ? ' gen-grid-selecting' : ''}`}>
        {cards.map((card) => {
          const isSel = selected.has(card.cardId)
          const subtitle = card.name || card.stem
          const isVideo = card.type === 'video'
          const cardTitle = selectionMode
            ? (isSel ? 'Selected — click to deselect' : 'Click to select')
            : (isVideo ? 'Click to play video' : 'Click to open preview')
          return (
            <figure
              key={card.cardId}
              className={`gen-card thumb thumb-generated${isSel ? ' thumb-selected' : ''}`}
              onClick={(e) => handleCardClick(e, card)}
              role="button"
              tabIndex={0}
              aria-pressed={selectionMode ? isSel : undefined}
              title={cardTitle}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  if (selectionMode) toggleOne(card.cardId)
                  else setPreview({ type: card.type, card })
                }
              }}
            >
              <label className="thumb-select" aria-label={`Select ${card.filename}`}>
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => toggleOne(card.cardId)}
                />
                <span aria-hidden="true" />
              </label>

              <div className="thumb-selected-overlay" aria-hidden="true">
                <span className="thumb-selected-check">✓</span>
              </div>

              <div className="gen-media-wrap">
                {isVideo ? (
                  <>
                    {/* Native <video> with preload="metadata" so the browser
                        renders the first frame as a poster. No controls
                        here — clicking the card opens the full player. */}
                    <video
                      className="gen-media gen-media-video"
                      src={card.url}
                      muted
                      playsInline
                      preload="metadata"
                      tabIndex={-1}
                    />
                    <span className="gen-media-play" aria-hidden="true">▶</span>
                    <span className="gen-media-type-badge" aria-hidden="true">🎬 Video</span>
                  </>
                ) : (
                  <>
                    <img
                      className="gen-media gen-media-image"
                      src={card.url}
                      alt={card.filename}
                      loading="lazy"
                    />
                    <span className="gen-media-type-badge" aria-hidden="true">🖼 Image</span>
                  </>
                )}
                <span className={`thumb-badge thumb-status-${(card.status || 'queued').toLowerCase()}`}>
                  {card.status === 'Delivered' && '✅ '}
                  {card.status === 'Sending'   && '⏳ '}
                  {card.status === 'Queued'    && '🕘 '}
                  {card.status === 'Failed'    && '⚠️ '}
                  {card.status}
                </span>
              </div>

              <figcaption className="gen-card-caption">
                <strong className="gen-card-title">{card.filename}</strong>
                <span className="gen-card-sub">
                  {subtitle} · {formatGeneratedAt(card.createdAt)}
                </span>
                <button
                  type="button"
                  className="gen-card-delete-btn"
                  title="Delete this file"
                  onClick={(e) => quickDeleteCard(card, e)}
                  aria-label={`Delete ${card.filename}`}
                >🗑</button>
              </figcaption>
            </figure>
          )
        })}
        {loaded && cards.length === 0 && !error && (
          <div className="empty-state">
            {allCards.length === 0
              ? 'No personalised media on disk yet. Open Google Sheets and click Generate Media to create your first one.'
              : 'No generated media matches the current filters.'}
          </div>
        )}
        {!loaded && !error && (
          <div className="empty-state">Loading generated media…</div>
        )}
      </div>

      {/* ------------------ Preview modals ----------------------------- */}
      {preview && (
        <PreviewModal
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}

      {/* Confirmation modal — portal so it escapes any clipped parent */}
      {confirmModal && createPortal(
        <div
          className="gen-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gen-confirm-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setConfirmModal(null)
          }}
        >
          <div className="gen-confirm">
            <div className="gen-confirm-icon" aria-hidden="true">🗑</div>
            <h2 id="gen-confirm-title" className="gen-confirm-title">{confirmModal.title}</h2>
            <p className="gen-confirm-msg">{confirmModal.message}</p>
            <div className="gen-confirm-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmModal(null)}
                disabled={deleting}
              >Cancel</button>
              <button
                type="button"
                className="btn gen-confirm-cta"
                onClick={() => deleteAssets(confirmModal.assets)}
                disabled={deleting}
              >{deleting ? 'Deleting…' : confirmModal.cta}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Wipe-by-kind modal — gives the user three explicit buttons so it's
          impossible to wipe the wrong half by accident. */}
      {wipeModal && createPortal(
        <div
          className="gen-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gen-wipe-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setWipeModal(null)
          }}
        >
          <div className="gen-confirm gen-wipe-modal">
            <div className="gen-confirm-icon" aria-hidden="true">🧹</div>
            <h2 id="gen-wipe-title" className="gen-confirm-title">Wipe legacy renders</h2>
            <p className="gen-confirm-msg">
              Pick what to remove. This is useful before a clean isolation
              test — wipe everything, then click Generate Images and watch
              ONLY images come back.
            </p>
            <div className="gen-wipe-stats">
              <span><strong>{kindCounts.images}</strong> images on disk</span>
              <span className="gen-wipe-stats-dot" aria-hidden="true">·</span>
              <span><strong>{kindCounts.videos}</strong> videos on disk</span>
            </div>
            <div className="gen-confirm-actions gen-wipe-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => wipeKinds(['image'])}
                disabled={deleting || kindCounts.images === 0}
              >🖼 Wipe images only ({kindCounts.images})</button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => wipeKinds(['video'])}
                disabled={deleting || kindCounts.videos === 0}
              >🎬 Wipe videos only ({kindCounts.videos})</button>
              <button
                type="button"
                className="btn gen-confirm-cta"
                onClick={() => wipeKinds(['image', 'video'])}
                disabled={deleting || allCards.length === 0}
              >{deleting ? 'Wiping…' : `Wipe EVERYTHING (${allCards.length})`}</button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setWipeModal(null)}
                disabled={deleting}
              >Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && createPortal(
        <div className={`gen-toast gen-toast-${toast.kind}`} role="status">
          <span className="gen-toast-dot" aria-hidden="true" />
          {toast.message}
        </div>,
        document.body
      )}
    </>
  )
}

// =========================================================================
// Preview modal — separate component so the lightbox and video player can
// own their own state (zoom, playback) without re-rendering the grid.
// =========================================================================
function PreviewModal({ preview, onClose }) {
  const { type, card } = preview
  const isImage = type === 'image'
  const [zoomed, setZoomed] = useState(false)

  // ESC to close.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function downloadAsset() {
    if (!card?.url) return // guard against an item without a URL (defensive)
    const a = document.createElement('a')
    a.href = card.url
    a.download = card.filename || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return createPortal(
    <div
      className={`gen-preview-overlay${zoomed ? ' gen-preview-overlay-zoomed' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${isImage ? 'Image' : 'Video'} preview — ${card.filename}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`gen-preview gen-preview-${type}`}>
        <div className="gen-preview-head">
          <div className="gen-preview-head-info">
            <span className="gen-preview-head-type">
              {isImage ? '🖼 Image' : '🎬 Video'}
            </span>
            <strong className="gen-preview-head-name">{card.filename}</strong>
            <span className="gen-preview-head-sub">
              {card.name || card.stem}
            </span>
          </div>
          <div className="gen-preview-head-actions">
            {isImage && (
              <button
                type="button"
                className="btn btn-ghost gen-preview-iconbtn"
                onClick={() => setZoomed((z) => !z)}
                title={zoomed ? 'Fit to window' : 'Zoom to actual size'}
              >
                {zoomed ? '⊟ Fit' : '⊞ Zoom'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost gen-preview-iconbtn"
              onClick={downloadAsset}
              title="Download to your computer"
            >⬇ Download</button>
            <button
              type="button"
              className="btn btn-ghost gen-preview-iconbtn gen-preview-close"
              onClick={onClose}
              title="Close (ESC)"
              aria-label="Close preview"
            >✕</button>
          </div>
        </div>

        <div className="gen-preview-body">
          {isImage ? (
            <img
              className={`gen-preview-image${zoomed ? ' gen-preview-image-zoomed' : ''}`}
              src={card.url}
              alt={card.filename}
              onClick={() => setZoomed((z) => !z)}
            />
          ) : (
            <video
              className="gen-preview-video"
              src={card.url}
              controls
              autoPlay
              playsInline
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
