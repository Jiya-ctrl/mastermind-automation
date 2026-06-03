import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PageHeader from '../components/PageHeader'

import { API_BASE, friendlyApiError } from '../config'
// Tight polling while any delivery is in flight; relaxed otherwise.
const POLL_MS_ACTIVE = 1500
const POLL_MS_IDLE   = 8000

// Status filter chips. `Sending` is omitted because it's transient (the
// brief moment between Queued and Meta accepting). `Pending Callback`
// (the new non-failure state for "Meta accepted, awaiting webhook") and
// `Read` (recipient opened) are first-class filters.
const TABS = ['All', 'Queued', 'Awaiting Reply', 'Pending Callback', 'Media Sent', 'Delivered', 'Read', 'Failed']

// Top-level media-kind filter — sits above the table and hides rows of
// the opposite kind when set. Labels match the spec exactly.
const MEDIA_FILTERS = [
  { id: 'all',   label: 'All' },
  { id: 'video', label: 'Videos Generated' },
  { id: 'image', label: 'Images Generated' },
]

function initialsOf(name) {
  const parts = String(name || '').split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '–'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatRelative(epochMs) {
  if (!epochMs || typeof epochMs !== 'number') return 'never'
  const diff = Date.now() - epochMs
  if (diff < 0) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 5)     return 'just now'
  if (s < 60)    return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)    return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)    return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function formatTimestamp(epochMs) {
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

export default function Delivery() {
  const [items, setItems]   = useState([])
  const [counts, setCounts] = useState({
    Delivered: 0, Sending: 0, Queued: 0, Failed: 0,
    'Awaiting Reply': 0, 'Media Sent': 0,
  })
  const [worker, setWorker] = useState(null)
  const [error, setError]   = useState(null)
  const [loaded, setLoaded] = useState(false)
  // Backend response schema version — surfaced in the page header so a
  // quick glance tells us whether the latest backend code is actually
  // running (or whether a deploy is still cached / failed).
  const [schemaV, setSchemaV] = useState(null)
  // Send Media dropdown — opens a menu with explicit options
  // (images / videos / first 5 / all) so the operator picks exactly
  // what they want sent. Closes on outside-click via the useEffect
  // below.
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  const sendMenuRef = useRef(null)
  const sendMenuBtnRef = useRef(null)
  // Position calculated from the button's bounding-rect when the menu
  // opens — needed because the parent .page-banner has overflow:hidden
  // which would otherwise clip the dropdown.
  const [sendMenuPos, setSendMenuPos] = useState({ top: 0, right: 0 })

  // Operator-configurable send-gap (seconds between consecutive
  // sends). Same backend endpoint as the Settings page so changes
  // here propagate everywhere.
  const [sendGap, setSendGap]         = useState(null)
  const [sendGapSaving, setSendGapSaving] = useState(false)

  const [tab, setTab]         = useState('All')
  const [query, setQuery]     = useState('')
  // Top-level media-kind filter — All / Videos Generated / Images Generated.
  const [mediaKind, setMediaKind] = useState('all')

  // 'acting' disables bulk buttons while a server call is in flight so the
  // user cannot double-click into a duplicate retry / enqueue.
  const [acting, setActing] = useState(false)

  // Send Media is now a single-click button (no dropdown). Backend's
  // auto-mode picks image OR video per recipient from WHATSAPP_MEDIA_KIND
  // env preference, so the operator never picks media files manually.

  // Toast feedback — auto-dismissing pill at the bottom-center of the page.
  const [toast, setToast]   = useState(null) // { kind, message } | null
  const toastTimerRef = useRef(null)

  // Webhook diagnostics. Populated by polling /deliveries/webhook-status
  // every 10 s while the page is mounted. Shape:
  //   { callback_url, public_base_url, verify_token_present,
  //     app_secret_present, provider,
  //     last_callback: { received_at_ms, ip, wamid, meta_status, error,
  //                      verify_at_ms } | null,
  //     last_seen_public_base_url, tunnel_rotated }
  const [webhookStatus, setWebhookStatus] = useState(null)
  const whTimerRef = useRef(null)

  // WhatsApp template config (drives whether sends use template flow or
  // freeform). Shape on the wire:
  //   { template_image, template_video, template_lang,
  //     template_body_params: string[] }
  // Plus `modes: { image, video }` for the human-readable summary.
  // `tplDraft` mirrors the inputs while editing; `tplSaving` disables the
  // Save button during the round-trip.
  const [tplConfig, setTplConfig] = useState(null)
  const [tplDraft,  setTplDraft]  = useState(null)
  const [tplSaving, setTplSaving] = useState(false)
  const [tplError,  setTplError]  = useState(null)

  // Two-step diagnostics — polled every 8 s while the page is mounted.
  // Surfaces flow state, prompt-template configured?, last inbound, last
  // media-stage transition. Lets the operator see why a delivery is or
  // isn't progressing without grepping the backend log.
  const [diag, setDiag] = useState(null)
  const diagTimerRef = useRef(null)

  const timerRef = useRef(null)

  function showToast(message, kind = 'success') {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ kind, message })
    toastTimerRef.current = setTimeout(() => setToast(null), 2800)
  }

  async function fetchList() {
    try {
      const res = await fetch(`${API_BASE}/delivery-status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data && data.status === 'success' && Array.isArray(data.items)) {
        setItems(data.items)
        setCounts({
          Delivered: data.counts?.Delivered ?? 0,
          Sending:   data.counts?.Sending   ?? 0,
          Queued:    data.counts?.Queued    ?? 0,
          Failed:    data.counts?.Failed    ?? 0,
        })
        setWorker(data.worker || null)
        if (typeof data.schema_version === 'number') {
          setSchemaV(data.schema_version)
        }
        setError(null)
      } else {
        setError(data?.error || 'unexpected response')
      }
    } catch (e) {
      setError(friendlyApiError(e, API_BASE))
    } finally {
      setLoaded(true)
    }
  }

  // Adaptive polling — tight while work is in flight, relaxed when idle.
  //
  // The cadence (active vs idle) is read from a ref inside a single,
  // never-rearmed timer. This avoids the "polling storm" that happened
  // when the effect depended on `counts.Queued`/`counts.Sending`:
  // every counter change torn down + reinstalled the timer, and each
  // reinstall called fetchList() immediately, producing a flood of
  // duplicate requests while the queue drained.
  const cadenceRef = useRef(POLL_MS_IDLE)
  useEffect(() => {
    cadenceRef.current = (counts.Queued > 0) || (counts.Sending > 0)
      ? POLL_MS_ACTIVE
      : POLL_MS_IDLE
  }, [counts.Queued, counts.Sending])

  useEffect(() => {
    let cancelled = false
    function schedule() {
      if (cancelled) return
      timerRef.current = setTimeout(async () => {
        if (cancelled) return
        await fetchList()
        if (cancelled) return  // guard late-resolving fetch on unmount
        schedule()
      }, cadenceRef.current)
    }
    fetchList().then(() => { if (!cancelled) schedule() })
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Webhook diagnostics polling — fixed 10 s cadence. Independent of the
  // delivery-list cadence because tunnel rotations and Meta-callback
  // arrivals happen on their own clock; we don't want them to ride the
  // (potentially relaxed) idle delivery poll.
  async function fetchWebhookStatus() {
    try {
      const res = await fetch(`${API_BASE}/deliveries/webhook-status`)
      if (!res.ok) return
      const data = await res.json()
      if (data && typeof data === 'object') {
        setWebhookStatus(data)
      }
    } catch {
      // Silent — the panel just keeps showing the previous snapshot.
    }
  }

  // Template config — fetched once on mount, then again after each save.
  // No periodic poll: the value is operator-controlled (not externally
  // mutated like webhook-status), so polling would be wasted requests.
  async function fetchTemplateConfig() {
    try {
      const res = await fetch(`${API_BASE}/deliveries/template-config`)
      if (!res.ok) return
      const data = await res.json()
      if (data && data.config) {
        setTplConfig(data)
        // Initialise the draft only if it hasn't been edited yet —
        // otherwise we'd clobber in-progress operator typing on a re-fetch.
        setTplDraft((prev) => prev ?? {
          flow:                  data.config.flow                 || 'direct',
          template_image:        data.config.template_image       || '',
          template_video:        data.config.template_video       || '',
          template_lang:         data.config.template_lang        || 'en',
          template_body_params:  Array.isArray(data.config.template_body_params)
            ? data.config.template_body_params.join(',')
            : '',
          prompt_template:       data.config.prompt_template      || '',
          prompt_lang:           data.config.prompt_lang          || 'en',
          prompt_body_params:    Array.isArray(data.config.prompt_body_params)
            ? data.config.prompt_body_params.join(',')
            : '',
        })
      }
    } catch {
      // Silent — the panel will show its previous snapshot.
    }
  }

  // Two-step diagnostics fetcher. Cheap GET; we poll every 8 s so the
  // operator sees inbound replies + state transitions land in near-real
  // time without manually refreshing.
  async function fetchDiagnostics() {
    try {
      const res = await fetch(`${API_BASE}/deliveries/diagnostics`)
      if (!res.ok) return
      const data = await res.json()
      if (data && data.status === 'success') setDiag(data)
    } catch {
      // Silent — panel keeps its last snapshot.
    }
  }

  async function simulateReply(deliveryId) {
    if (!deliveryId) return
    try {
      const res = await fetch(`${API_BASE}/deliveries/${encodeURIComponent(deliveryId)}/simulate-reply`, {
        method: 'POST',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        showToast(data.error || `simulate failed (HTTP ${res.status})`, 'danger')
        return
      }
      showToast(`Simulated reply advanced ${data.advanced} row(s)`, 'success')
      // Refresh both the deliveries table and diagnostics immediately
      // so the operator sees the state transition without waiting for
      // the next poll tick.
      await Promise.all([fetchList(), fetchDiagnostics()])
    } catch (e) {
      showToast(friendlyApiError(e), 'danger')
    }
  }

  async function saveTemplateConfig() {
    if (!tplDraft || tplSaving) return
    setTplSaving(true)
    setTplError(null)
    try {
      const body = {
        flow:                 (tplDraft.flow || 'direct'),
        template_image:       (tplDraft.template_image || '').trim(),
        template_video:       (tplDraft.template_video || '').trim(),
        template_lang:        (tplDraft.template_lang  || 'en').trim() || 'en',
        // Backend accepts a single comma-separated string OR an array of
        // strings; we send the comma string verbatim for simplicity.
        template_body_params: (tplDraft.template_body_params || '').trim(),
        prompt_template:      (tplDraft.prompt_template || '').trim(),
        prompt_lang:          (tplDraft.prompt_lang     || 'en').trim() || 'en',
        prompt_body_params:   (tplDraft.prompt_body_params || '').trim(),
      }
      const res = await fetch(`${API_BASE}/deliveries/template-config`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `save failed (HTTP ${res.status})`)
      }
      showToast('Template config saved')
      // Refresh the canonical config view from server.
      setTplConfig({ ...data, modes: tplConfig?.modes })
      await fetchTemplateConfig()
    } catch (e) {
      setTplError(friendlyApiError(e))
    } finally {
      setTplSaving(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    function tick() {
      if (cancelled) return
      whTimerRef.current = setTimeout(async () => {
        if (cancelled) return
        await fetchWebhookStatus()
        if (cancelled) return
        tick()
      }, 10_000)
    }
    fetchWebhookStatus().then(() => { if (!cancelled) tick() })
    // Template config: one-shot fetch on mount. No periodic poll — see
    // fetchTemplateConfig for why.
    fetchTemplateConfig()
    // Diagnostics: poll every 8 s so inbound replies + media-stage
    // transitions appear in the panel near-realtime.
    function diagTick() {
      if (cancelled) return
      diagTimerRef.current = setTimeout(async () => {
        if (cancelled) return
        await fetchDiagnostics()
        if (cancelled) return
        diagTick()
      }, 8000)
    }
    fetchDiagnostics().then(() => { if (!cancelled) diagTick() })
    return () => {
      cancelled = true
      if (whTimerRef.current)   clearTimeout(whTimerRef.current)
      if (diagTimerRef.current) clearTimeout(diagTimerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close the Send Media dropdown on outside-click + recalc its
  // viewport position. The menu is portalled to document.body so the
  // page-banner's overflow:hidden doesn't clip it — that means we
  // need to drive its position from the button's getBoundingClientRect.
  useEffect(() => {
    if (!sendMenuOpen) return
    function onDocClick(e) {
      const inMenu = sendMenuRef.current && sendMenuRef.current.contains(e.target)
      const inBtn  = sendMenuBtnRef.current && sendMenuBtnRef.current.contains(e.target)
      if (!inMenu && !inBtn) setSendMenuOpen(false)
    }
    function reposition() {
      const btn = sendMenuBtnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      setSendMenuPos({
        top:   r.bottom + 8,
        right: Math.max(8, window.innerWidth - r.right),
      })
    }
    reposition()
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [sendMenuOpen])

  // Load the current send-gap once on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/deliveries/send-gap`)
        if (!res.ok) return
        const data = await res.json().catch(() => ({}))
        if (!cancelled && typeof data?.seconds === 'number') {
          setSendGap(Math.round(data.seconds))
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Debounced POST so click-mashing the +/- buttons fires one request.
  useEffect(() => {
    if (sendGap === null) return
    const t = setTimeout(async () => {
      setSendGapSaving(true)
      try {
        const res = await fetch(`${API_BASE}/deliveries/send-gap`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ seconds: sendGap }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          showToast(`Send gap save failed: ${data?.error || res.status}`, 'error')
        } else {
          showToast(`Send gap → ${sendGap}s`, 'success')
        }
      } catch (e) {
        showToast(`Send gap save failed: ${e.message || e}`, 'error')
      } finally {
        setSendGapSaving(false)
      }
    }, 400)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendGap])

  // Toast cleanup on unmount.
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
  }, [])

  // (Column-header dropdown removed — replaced by top-level kind chips.)

  // (No dropdown anymore — Send Media is a single-click button.)

  // ---------- actions ----------
  async function postJson(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method:  'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body:    body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.status !== 'success') {
      throw new Error(data?.error || `HTTP ${res.status}`)
    }
    return data
  }

  // Generic enqueue. Backend accepts `limit` (0 = all) AND `kind`
  // ('image' or 'video'). The Send Media ▾ dropdown has separate Image
  // and Video sections — each menu item passes its own kind here so a
  // single click can send only images OR only videos to N recipients.
  async function enqueueBatch(limit, kind, label) {
    if (acting) return
    setActing(true)
    setError(null)
    try {
      const data = await postJson('/deliveries/enqueue-all', { limit, kind })
      // Backend returns `enqueued` as a COUNT (int), with the full record
      // objects in `items`. Don't treat enqueued as a list.
      const n = typeof data.enqueued === 'number'
        ? data.enqueued
        : (Array.isArray(data.items) ? data.items.length : 0)
      if (n === 0) {
        showToast(
          `Nothing new to send — every eligible ${kind || 'render'} already has a delivery record.`,
          'info',
        )
      } else {
        const kindLabel = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'delivery'
        showToast(
          `Queued ${n} ${kindLabel}${n === 1 ? '' : 's'}${label ? ` (${label})` : ''}`,
          'success',
        )
      }
      await fetchList()
    } catch (e) {
      setError(`Send failed: ${e.message || e}`)
      showToast(`Send failed: ${e.message || e}`, 'error')
    } finally {
      setActing(false)
    }
  }

  async function retryAllFailed() {
    // Hard gate — disabled state should prevent this, but guard the call
    // anyway in case a rapid click slips through during a poll refresh.
    if (acting || counts.Failed === 0) return
    setActing(true)
    setError(null)
    try {
      const data = await postJson('/deliveries/retry-failed')
      const n = data.requeued ?? 0
      if (n === 0) {
        showToast('No failed deliveries to retry.', 'info')
      } else {
        showToast(`Re-queued ${n} failed ${n === 1 ? 'delivery' : 'deliveries'}`, 'success')
      }
      await fetchList()
    } catch (e) {
      setError(`Retry all failed: ${e.message || e}`)
      showToast(`Retry failed: ${e.message || e}`, 'error')
    } finally {
      setActing(false)
    }
  }

  async function retryOne(deliveryId) {
    if (!deliveryId) return
    setError(null)
    try {
      await postJson(`/deliveries/${deliveryId}/retry`)
      showToast('Re-queued for delivery', 'success')
      await fetchList()
    } catch (e) {
      setError(`Retry failed: ${e.message || e}`)
      showToast(`Retry failed: ${e.message || e}`, 'error')
    }
  }

  async function toggleWorker() {
    if (!worker) return
    setError(null)
    try {
      if (worker.alive) {
        await postJson('/deliveries/worker/stop')
        showToast('Worker paused', 'info')
      } else {
        await postJson('/deliveries/worker/start')
        showToast('Worker started', 'success')
      }
      await fetchList()
    } catch (e) {
      setError(`Worker toggle failed: ${e.message || e}`)
      showToast(`Worker toggle failed: ${e.message || e}`, 'error')
    }
  }

  // ---------- derived ----------
  const failedCount = counts.Failed
  // Per-kind pending counts. With the new (stem, kind) row shape every
  // row carries a single media_kind, so we can count directly.
  const pendingImages = items.filter(
    (r) => (r.media_kind === 'image') && !r.delivery_id,
  ).length
  const pendingVideos = items.filter(
    (r) => (r.media_kind === 'video') && !r.delivery_id,
  ).length
  // Total pending across both kinds — drives the dropdown button's
  // count badge AND the disable state for the button.
  const availableToSend = pendingImages + pendingVideos

  // Per-row helpers — read the BACKEND's live detection FIRST so the UI
  // is never out of sync with the filesystem. `detected_kind` /
  // `detected_filename` come from `_detect_media_for_stem` on every
  // GET /delivery-status; they win over any snapshot stored on the
  // delivery row.
  function rowMediaKind(r) {
    const live = (r.detected_kind || '').toLowerCase()
    if (live === 'image' || live === 'video') return live
    // Fallback for filesystem-only rows or anything malformed.
    const k = (r.media_kind || '').toLowerCase()
    if (k === 'image' || k === 'video') return k
    if (r.image_filename && !r.video_filename) return 'image'
    if (r.video_filename && !r.image_filename) return 'video'
    return null
  }
  function rowMediaFilename(r) {
    if (r.detected_filename) return r.detected_filename
    const k = rowMediaKind(r)
    if (k === 'image') return r.image_filename || ''
    if (k === 'video') return r.video_filename || ''
    return ''
  }

  const rows = useMemo(() => items.filter((r) => {
    if (tab !== 'All' && r.status !== tab) return false
    if (mediaKind !== 'all' && rowMediaKind(r) !== mediaKind) return false
    if (!query) return true
    const q = query.toLowerCase()
    const haystack = [
      r.name || '', r.id || '',
      r.recipient_name || '', r.recipient_phone || '', r.recipient_address || '',
      r.video_filename || '', r.image_filename || '',
    ]
    return haystack.some((s) => s.toLowerCase().includes(q))
  }), [items, tab, query, mediaKind])  // eslint-disable-line react-hooks/exhaustive-deps

  const sendDisabled = acting || availableToSend === 0
  const retryDisabled = acting || failedCount === 0

  return (
    <>
      <PageHeader
        title="WhatsApp Delivery"
        subtitle={
          worker
            ? `Provider: ${worker.provider} · Worker ${worker.alive ? 'running' : 'stopped'}${schemaV ? ` · schema v${schemaV}` : ''} · ${items.length} rows`
            : 'Per-recipient WhatsApp delivery state.'
        }
        actions={
          <>
            {/* Inline send-gap stepper — same backend knob as the
                Settings page so changes here propagate. Compact 3-button
                layout to fit alongside Send/Retry. */}
            <div className="send-gap-inline" title="Seconds between consecutive sends (Meta-friendly pacing)">
              <span className="send-gap-inline-label">Gap</span>
              <button
                type="button"
                className="send-gap-inline-btn"
                onClick={() => setSendGap((n) => Math.max(0, (n ?? 0) - 5))}
                disabled={sendGap === null || sendGap <= 0}
              >−</button>
              <input
                type="number"
                className="send-gap-inline-input"
                value={sendGap ?? ''}
                min={0}
                max={600}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(600, Number(e.target.value) || 0))
                  setSendGap(v)
                }}
              />
              <button
                type="button"
                className="send-gap-inline-btn"
                onClick={() => setSendGap((n) => Math.min(600, (n ?? 0) + 5))}
                disabled={sendGap === null}
              >+</button>
              <span className="send-gap-inline-suffix">
                s{sendGapSaving ? '…' : ''}
              </span>
            </div>

            {/* Send Media dropdown — explicit options so the operator
                picks exactly what to send instead of relying on auto-
                mode. Counts beside each option reflect the live pending
                rows so e.g. "Send all images (2)" tells you the
                outcome before you click. */}
            <button
              ref={sendMenuBtnRef}
              type="button"
              className="btn btn-secondary gen-banner-btn"
              onClick={() => setSendMenuOpen((o) => !o)}
              disabled={sendDisabled}
              title={availableToSend === 0
                ? 'Every ready render already has a delivery record'
                : `Pick what to send — ${pendingImages} image${pendingImages === 1 ? '' : 's'} and ${pendingVideos} video${pendingVideos === 1 ? '' : 's'} waiting`}
              aria-expanded={sendMenuOpen}
              aria-haspopup="menu"
            >
              ➤ Send Media{availableToSend > 0 ? ` (${availableToSend})` : ''} ▾
            </button>
            {sendMenuOpen && createPortal(
              <div
                className="send-menu send-menu-portal"
                role="menu"
                ref={sendMenuRef}
                style={{ top: sendMenuPos.top, right: sendMenuPos.right }}
              >
                <div className="send-menu-group">Images</div>
                <button
                  type="button"
                  role="menuitem"
                  className="send-menu-item"
                  disabled={pendingImages === 0 || acting}
                  onClick={() => { setSendMenuOpen(false); enqueueBatch(0, 'image', 'all images') }}
                >Send all images{pendingImages > 0 ? ` (${pendingImages})` : ''}</button>
                <button
                  type="button"
                  role="menuitem"
                  className="send-menu-item"
                  disabled={pendingImages === 0 || acting}
                  onClick={() => { setSendMenuOpen(false); enqueueBatch(5, 'image', 'first 5 images') }}
                >Send first 5 images</button>
                <div className="send-menu-sep" />
                <div className="send-menu-group">Videos</div>
                <button
                  type="button"
                  role="menuitem"
                  className="send-menu-item"
                  disabled={pendingVideos === 0 || acting}
                  onClick={() => { setSendMenuOpen(false); enqueueBatch(0, 'video', 'all videos') }}
                >Send all videos{pendingVideos > 0 ? ` (${pendingVideos})` : ''}</button>
                <button
                  type="button"
                  role="menuitem"
                  className="send-menu-item"
                  disabled={pendingVideos === 0 || acting}
                  onClick={() => { setSendMenuOpen(false); enqueueBatch(5, 'video', 'first 5 videos') }}
                >Send first 5 videos</button>
                <div className="send-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="send-menu-item"
                  disabled={availableToSend === 0 || acting}
                  onClick={() => { setSendMenuOpen(false); enqueueBatch(0, null, 'auto') }}
                >Send everything (auto-pick per recipient)</button>
              </div>,
              document.body,
            )}

            <button
              type="button"
              className="btn btn-primary gen-banner-btn"
              onClick={retryAllFailed}
              disabled={retryDisabled}
              title={failedCount === 0
                ? 'No failed deliveries to retry'
                : `Re-queue ${failedCount} failed delivery${failedCount === 1 ? '' : 'ies'}`}
            >
              ↻ Retry All Failed{failedCount > 0 ? ` (${failedCount})` : ''}
            </button>
          </>
        }
      />


      {webhookStatus?.tunnel_rotated && (
        <div className="dlv-tunnel-banner" role="alert">
          <span aria-hidden="true">⚠️</span>
          <div className="dlv-tunnel-banner-text">
            <strong>Webhook URL changed</strong>
            <span>
              Public base URL has rotated since the last callback. Update Meta's
              webhook configuration to{' '}
              <code>{webhookStatus.callback_url || '—'}</code>{' '}
              or callbacks will stop arriving.
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="tmpl-error" role="alert">
          <span aria-hidden="true">⚠️</span> {error}
        </div>
      )}

      <div className="status-summary">
        {[
          { label: 'Delivered',       value: counts.Delivered,                tone: 'success' },
          { label: 'Media Sent',      value: counts['Media Sent']      || 0,  tone: 'success' },
          { label: 'Awaiting Reply',  value: counts['Awaiting Reply']  || 0,  tone: 'warning' },
          { label: 'Sending',         value: counts.Sending,                  tone: 'warning' },
          { label: 'Queued',          value: counts.Queued,                   tone: 'muted'   },
          { label: 'Failed',          value: counts.Failed,                   tone: 'danger'  },
        ].map((s) => (
          <section key={s.label} className={`card status-summary-card status-summary-${s.tone}`}>
            <div className="analytics-label">{s.label}</div>
            <div className="analytics-value">{s.value}</div>
          </section>
        ))}
      </div>

      <section className="card">
        <div className="card-head row">
          <div className="filter-pills">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                className={`filter-pill${tab === t ? ' filter-pill-active' : ''}`}
                onClick={() => setTab(t)}
              >{t}</button>
            ))}
          </div>
          <div className="search search-inline">
            <span aria-hidden="true">🔍</span>
            <input
              type="text"
              placeholder="Search name, phone, address or filename…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Top-level media-kind filter — All / Videos Generated / Images
            Generated. Sits BETWEEN status chips and the table so it's
            visually separate from the status filter. */}
        <div className="dlv-kind-filter">
          {MEDIA_FILTERS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`filter-pill${mediaKind === k.id ? ' filter-pill-active' : ''}`}
              onClick={() => setMediaKind(k.id)}
            >{k.label}</button>
          ))}
        </div>

        <div className="table-wrap">
          <table className="delivery-table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Phone</th>
                <th style={{ width: 130 }}>Media Type</th>
                <th>Auto-detected filename</th>
                <th>Time</th>
                <th>Status</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const displayName  = r.recipient_name || r.name || '—'
                const displayPhone = r.recipient_phone || '—'
                const isFailed = r.status === 'Failed'
                let timeLabel = '—'
                if (r.deliveredAt)  timeLabel = formatTimestamp(r.deliveredAt)
                else if (r.sentAt)  timeLabel = formatTimestamp(r.sentAt)
                else                timeLabel = formatTimestamp(r.createdAt)
                return (
                  <tr key={r.row_id || r.id}>
                    <td>
                      <div className="cell-name">
                        <span className="cell-avatar">{initialsOf(displayName)}</span>
                        <span>{displayName}</span>
                      </div>
                    </td>
                    <td className="cell-file">{displayPhone}</td>
                    <td>
                      {(() => {
                        const k = rowMediaKind(r)
                        if (!k) {
                          // No file on disk at all — clearly indicate it.
                          return <span className="dlv-kind-pill dlv-kind-pill-none">—</span>
                        }
                        return (
                          <span className={`dlv-kind-pill dlv-kind-pill-${k}`}>
                            <span aria-hidden="true">{k === 'image' ? '🖼' : '🎬'}</span>
                            {k === 'image' ? 'Image' : 'Video'}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="cell-file">
                      {(() => {
                        const filename = rowMediaFilename(r)
                        if (!filename) {
                          return <span className="cell-faint">No media found</span>
                        }
                        return (
                          <span className="dlv-media-cell" title={filename}>
                            <span className="dlv-media-cell-name">{filename}</span>
                          </span>
                        )
                      })()}
                    </td>
                    <td className="cell-faint" title={r.last_error || ''}>{timeLabel}</td>
                    <td>
                      {(() => {
                        // Status pill — class name uses a dash-safe slug
                        // so multi-word statuses like "Pending Callback"
                        // get `status-pending-callback`.
                        const s    = r.status || 'Queued'
                        const slug = s.toLowerCase().replace(/\s+/g, '-')
                        const icon = {
                          'Delivered':        '✅',
                          'Read':             '👁',
                          'Sending':          '⏳',
                          'Pending Callback': '⏱',
                          'Queued':           '🕘',
                          'Failed':           '⚠️',
                          // Two-step engagement flow.
                          'Awaiting Reply':   '💬',
                          'Media Sent':       '📤',
                          'Replied':          '↩',
                        }[s] || ''
                        return (
                          <span
                            className={`status-pill status-${slug}`}
                            title={r.last_error ? `Last error: ${r.last_error}` : ''}
                          >
                            {icon && <span aria-hidden="true">{icon} </span>}
                            {s}
                            {r.attempts > 1 && s !== 'Delivered' && s !== 'Read' && ` ·${r.attempts}`}
                          </span>
                        )
                      })()}
                    </td>
                    <td>
                      {isFailed && r.delivery_id && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => retryOne(r.delivery_id)}
                          title={r.last_error || 'Retry this delivery'}
                        >↻ Retry</button>
                      )}
                      {r.status === 'Awaiting Reply' && r.delivery_id && (
                        <button
                          type="button"
                          className="btn btn-ghost dlv-simulate-btn"
                          onClick={() => simulateReply(r.delivery_id)}
                          title="Debug: synthesise an inbound YES reply to advance this row to stage 2"
                        >🧪 Simulate YES Reply</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {loaded && rows.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="cell-empty">
                    {items.length === 0
                      ? 'No deliveries yet. Generate personalised media from the Sheets page first, then click Send Media here.'
                      : 'No rows match the current filter.'}
                  </td>
                </tr>
              )}
              {!loaded && !error && (
                <tr>
                  <td colSpan={7} className="cell-empty">Loading delivery state…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {webhookStatus && (
        <section className="card dlv-webhook-panel">
          <header className="dlv-webhook-panel-head">
            <h3>Webhook Status</h3>
            <span className="dlv-webhook-panel-sub">
              Diagnostics for Meta → backend callbacks. Polled every 10 s.
            </span>
          </header>
          <div className="dlv-webhook-grid">
            <div className="dlv-webhook-cell">
              <div className="dlv-webhook-label">Last callback</div>
              <div className="dlv-webhook-value">
                {webhookStatus.last_callback?.received_at_ms
                  ? formatRelative(webhookStatus.last_callback.received_at_ms)
                  : <span className="cell-faint">no callbacks yet</span>}
              </div>
              {webhookStatus.last_callback?.meta_status && (
                <div className="dlv-webhook-sub">
                  Meta status: <code>{webhookStatus.last_callback.meta_status}</code>
                </div>
              )}
            </div>

            <div className="dlv-webhook-cell">
              <div className="dlv-webhook-label">Last webhook IP</div>
              <div className="dlv-webhook-value">
                {webhookStatus.last_callback?.ip
                  ? <code>{webhookStatus.last_callback.ip}</code>
                  : <span className="cell-faint">—</span>}
              </div>
              {webhookStatus.last_callback?.wamid && (
                <div className="dlv-webhook-sub" title={webhookStatus.last_callback.wamid}>
                  wamid: <code>{webhookStatus.last_callback.wamid.slice(0, 24)}…</code>
                </div>
              )}
            </div>

            <div className="dlv-webhook-cell">
              <div className="dlv-webhook-label">Last verify (GET hub.challenge)</div>
              <div className="dlv-webhook-value">
                {webhookStatus.last_callback?.verify_at_ms
                  ? formatRelative(webhookStatus.last_callback.verify_at_ms)
                  : <span className="cell-faint">never</span>}
              </div>
              <div className="dlv-webhook-sub">
                Verify token: {webhookStatus.verify_token_present
                  ? <span className="dlv-webhook-ok">✓ configured</span>
                  : <span className="dlv-webhook-bad">✗ missing</span>}
                {' · '}
                App secret: {webhookStatus.app_secret_present
                  ? <span className="dlv-webhook-ok">✓ configured</span>
                  : <span className="dlv-webhook-bad">✗ missing</span>}
              </div>
            </div>

            <div className="dlv-webhook-cell dlv-webhook-cell-wide">
              <div className="dlv-webhook-label">Public base URL</div>
              <div className="dlv-webhook-value">
                {webhookStatus.public_base_url
                  ? <code>{webhookStatus.public_base_url}</code>
                  : <span className="cell-faint">not configured</span>}
              </div>
              <div className="dlv-webhook-sub">
                Callback path:{' '}
                <code>{webhookStatus.callback_url || '—'}</code>
              </div>
            </div>
          </div>

          {webhookStatus.last_callback?.error && (
            <div className="dlv-webhook-error" title={webhookStatus.last_callback.error}>
              <span aria-hidden="true">⚠️</span>
              Last callback reported an error: <code>{webhookStatus.last_callback.error}</code>
            </div>
          )}
        </section>
      )}

      {tplDraft && (
        <section className="card dlv-tpl-panel">
          <header className="dlv-webhook-panel-head">
            <h3>
              WhatsApp Template &amp; Flow
              <span className={`dlv-flow-chip dlv-flow-chip-${tplConfig?.config?.flow === 'two-step' ? 'twostep' : 'direct'}`}>
                Active: {tplConfig?.config?.flow === 'two-step' ? 'Two-step engagement' : 'Direct'}
              </span>
            </h3>
            <span className="dlv-webhook-panel-sub">
              Choose the engagement flow + the approved Meta templates each stage ships. <strong>Two-step</strong> opens the 24-hour window with a text prompt before sending media; <strong>direct</strong> sends the media template up-front.
            </span>
          </header>

          {tplDraft.flow === 'two-step' && (
            <div className="dlv-twostep-explain" role="note">
              <div className="dlv-twostep-step">
                <span className="dlv-twostep-num">1</span>
                <div>
                  <div className="dlv-twostep-step-title">Send prompt</div>
                  <div className="dlv-twostep-step-sub">Ship the approved text-only template asking the recipient to reply.</div>
                </div>
              </div>
              <div className="dlv-twostep-arrow" aria-hidden="true">→</div>
              <div className="dlv-twostep-step">
                <span className="dlv-twostep-num">2</span>
                <div>
                  <div className="dlv-twostep-step-title">Wait for reply</div>
                  <div className="dlv-twostep-step-sub">Their inbound message opens Meta's 24-hour customer-service window.</div>
                </div>
              </div>
              <div className="dlv-twostep-arrow" aria-hidden="true">→</div>
              <div className="dlv-twostep-step">
                <span className="dlv-twostep-num">3</span>
                <div>
                  <div className="dlv-twostep-step-title">Auto-send media</div>
                  <div className="dlv-twostep-step-sub">Worker automatically ships the personalised image/video as freeform.</div>
                </div>
              </div>
            </div>
          )}

          <div className="dlv-flow-toggle" role="radiogroup" aria-label="Delivery flow">
            <button
              type="button"
              role="radio"
              aria-checked={tplDraft.flow === 'direct'}
              className={`dlv-flow-opt${tplDraft.flow === 'direct' ? ' dlv-flow-opt-active' : ''}`}
              onClick={() => {
                // Immediately persist the flow change so the backend
                // switches behaviour even before the operator hits Save.
                setTplDraft({ ...tplDraft, flow: 'direct' })
                fetch(`${API_BASE}/deliveries/template-config`, {
                  method:  'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ flow: 'direct' }),
                }).then(fetchTemplateConfig).then(fetchDiagnostics).catch(() => {})
              }}
            >
              <span className="dlv-flow-opt-title">Direct</span>
              <span className="dlv-flow-opt-sub">Media template up-front. Subject to Meta marketing filters.</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={tplDraft.flow === 'two-step'}
              className={`dlv-flow-opt${tplDraft.flow === 'two-step' ? ' dlv-flow-opt-active' : ''}`}
              onClick={() => {
                setTplDraft({ ...tplDraft, flow: 'two-step' })
                fetch(`${API_BASE}/deliveries/template-config`, {
                  method:  'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ flow: 'two-step' }),
                }).then(fetchTemplateConfig).then(fetchDiagnostics).catch(() => {})
              }}
            >
              <span className="dlv-flow-opt-title">Two-step engagement</span>
              <span className="dlv-flow-opt-sub">Text prompt → recipient replies → media inside 24h window.</span>
            </button>
          </div>

          {tplDraft.flow === 'two-step' && (
            <div className="dlv-tpl-grid dlv-tpl-grid-stage">
              <div className="dlv-tpl-stage-head">Stage 1 — Prompt template (text only)</div>

              <label className="dlv-tpl-field dlv-tpl-field-wide">
                <span className="dlv-tpl-label">Prompt template name</span>
                <input
                  type="text"
                  className="dlv-tpl-input"
                  placeholder="promo_media_update_prompt"
                  value={tplDraft.prompt_template}
                  onChange={(e) => setTplDraft({ ...tplDraft, prompt_template: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="dlv-tpl-hint">
                  Approved <strong>text-only</strong> template that asks the recipient to reply, e.g.{' '}
                  <em>“Hi {'{{1}}'}, your personalised Abacus media is ready 😊 Reply YES to receive it.”</em>
                </span>
              </label>

              <label className="dlv-tpl-field">
                <span className="dlv-tpl-label">Prompt language</span>
                <input
                  type="text"
                  className="dlv-tpl-input"
                  placeholder="en"
                  value={tplDraft.prompt_lang}
                  onChange={(e) => setTplDraft({ ...tplDraft, prompt_lang: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="dlv-tpl-hint">Language code registered for the prompt template.</span>
              </label>

              <label className="dlv-tpl-field">
                <span className="dlv-tpl-label">Prompt body parameters</span>
                <input
                  type="text"
                  className="dlv-tpl-input"
                  placeholder="{name}"
                  value={tplDraft.prompt_body_params}
                  onChange={(e) => setTplDraft({ ...tplDraft, prompt_body_params: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="dlv-tpl-hint">
                  One per <code>{'{{n}}'}</code> placeholder. Keys: <code>{'{name}'}</code> <code>{'{address}'}</code> <code>{'{phone}'}</code>.
                </span>
              </label>
            </div>
          )}

          <div className="dlv-tpl-grid dlv-tpl-grid-stage">
            <div className="dlv-tpl-stage-head">
              {tplDraft.flow === 'two-step' ? 'Stage 2 — Personalised media (sent after reply)' : 'Media template'}
            </div>

            <label className="dlv-tpl-field">
              <span className="dlv-tpl-label">Image template</span>
              <input
                type="text"
                className="dlv-tpl-input"
                placeholder="promo_media_update"
                value={tplDraft.template_image}
                onChange={(e) => setTplDraft({ ...tplDraft, template_image: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="dlv-tpl-hint">
                Name of the approved template with an IMAGE header.
              </span>
            </label>

            <label className="dlv-tpl-field">
              <span className="dlv-tpl-label">Video template</span>
              <input
                type="text"
                className="dlv-tpl-input"
                placeholder="promo_media_update"
                value={tplDraft.template_video}
                onChange={(e) => setTplDraft({ ...tplDraft, template_video: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="dlv-tpl-hint">
                Name of the approved template with a VIDEO header. Can be the same as image if your template accepts both header types.
              </span>
            </label>

            <label className="dlv-tpl-field">
              <span className="dlv-tpl-label">Language code</span>
              <input
                type="text"
                className="dlv-tpl-input"
                placeholder="en"
                value={tplDraft.template_lang}
                onChange={(e) => setTplDraft({ ...tplDraft, template_lang: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="dlv-tpl-hint">
                Must match the language the template was registered under in WhatsApp Manager.
              </span>
            </label>

            <label className="dlv-tpl-field dlv-tpl-field-wide">
              <span className="dlv-tpl-label">Body parameters</span>
              <input
                type="text"
                className="dlv-tpl-input"
                placeholder="{name},{address}"
                value={tplDraft.template_body_params}
                onChange={(e) => setTplDraft({ ...tplDraft, template_body_params: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="dlv-tpl-hint">
                Comma-separated, one per <code>{'{{n}}'}</code> placeholder. Available keys:{' '}
                <code>{'{name}'}</code> <code>{'{address}'}</code> <code>{'{phone}'}</code>. Leave empty if your template has no body variables.
              </span>
            </label>
          </div>

          <div className="dlv-tpl-row">
            <div className="dlv-tpl-modes">
              <span className="dlv-tpl-label">Active send modes</span>
              <span className="dlv-tpl-mode">
                Image: <code>{tplConfig?.modes?.image || '—'}</code>
              </span>
              <span className="dlv-tpl-mode">
                Video: <code>{tplConfig?.modes?.video || '—'}</code>
              </span>
              {tplConfig?.modes && (tplConfig.modes.image === 'freeform' || tplConfig.modes.video === 'freeform') && (
                <span className="dlv-tpl-warn">
                  ⚠ A kind is in freeform mode — Meta will reject sends to cold recipients.
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-brand"
              onClick={saveTemplateConfig}
              disabled={tplSaving}
            >
              {tplSaving ? 'Saving…' : 'Save template config'}
            </button>
          </div>

          {tplError && (
            <div className="dlv-webhook-error" role="alert">
              <span aria-hidden="true">⚠️</span> {tplError}
            </div>
          )}
        </section>
      )}

      {diag && (
        <section className="card dlv-tpl-panel dlv-diag-panel">
          <header className="dlv-webhook-panel-head">
            <h3>
              Two-step Diagnostics
              <span className={`dlv-flow-chip dlv-flow-chip-${diag.flow === 'two-step' ? 'twostep' : 'direct'}`}>
                Flow: {diag.flow}
              </span>
            </h3>
            <span className="dlv-webhook-panel-sub">
              Live snapshot of the two-step engagement flow. Polled every 8&nbsp;s.
            </span>
          </header>

          <div className="dlv-diag-grid">
            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Current flow</div>
              <div className="dlv-diag-value">{diag.flow}</div>
            </div>
            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Prompt template configured</div>
              <div className="dlv-diag-value">
                {diag.prompt_configured
                  ? <span className="dlv-diag-ok">✓ {diag.prompt_template}</span>
                  : <span className="dlv-diag-bad">✗ not set</span>}
              </div>
            </div>
            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Webhook <code>messages</code> subscription</div>
              <div className="dlv-diag-value">
                {diag.messages_subscription_detected
                  ? <span className="dlv-diag-ok">✓ detected (inbound received)</span>
                  : <span className="dlv-diag-warn">? unknown — no inbound yet at current callback URL</span>}
              </div>
            </div>
            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Awaiting Reply / Media in flight</div>
              <div className="dlv-diag-value">
                <code>{diag.two_step_counts?.awaiting_reply ?? 0}</code> awaiting
                {' · '}
                <code>{diag.two_step_counts?.media_in_flight ?? 0}</code> in flight
              </div>
            </div>

            <div className="dlv-diag-cell dlv-diag-cell-wide">
              <div className="dlv-tpl-label">Last inbound reply</div>
              <div className="dlv-diag-value">
                {diag.last_inbound
                  ? (
                      <span>
                        <code>{diag.last_inbound.digits || diag.last_inbound.phone}</code> · {diag.last_inbound.msg_type}
                        {diag.last_inbound.preview ? <> · <em>{diag.last_inbound.preview}</em></> : null}
                        {' · '}{formatRelative(diag.last_inbound.at_ms)}
                        {diag.last_inbound.simulated && <span className="dlv-diag-sim"> (simulated)</span>}
                      </span>
                    )
                  : <span className="cell-faint">no inbound message received yet</span>}
              </div>
            </div>

            <div className="dlv-diag-cell dlv-diag-cell-wide">
              <div className="dlv-tpl-label">Last media-stage transition</div>
              <div className="dlv-diag-value">
                {diag.last_media_transition
                  ? (
                      <span>
                        <code>{diag.last_media_transition.delivery_id}</code> · {diag.last_media_transition.phone}
                        {' · '}{formatRelative(diag.last_media_transition.at_ms)}
                      </span>
                    )
                  : <span className="cell-faint">none yet — no row has advanced past Awaiting Reply</span>}
              </div>
            </div>

            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Last prompt send</div>
              <div className="dlv-diag-value">
                {diag.last_prompt_send
                  ? (
                      <span>
                        {diag.last_prompt_send.ok ? '✓' : '✗'} {diag.last_prompt_send.delivery_id}
                        {' · '}{formatRelative(diag.last_prompt_send.at_ms)}
                        {diag.last_prompt_send.error
                          ? <div className="dlv-diag-err">{diag.last_prompt_send.error}</div>
                          : null}
                      </span>
                    )
                  : <span className="cell-faint">none</span>}
              </div>
            </div>
            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Last media send</div>
              <div className="dlv-diag-value">
                {diag.last_media_send
                  ? (
                      <span>
                        {diag.last_media_send.ok ? '✓' : '✗'} {diag.last_media_send.delivery_id}
                        {' · '}<code>{diag.last_media_send.mode || '?'}</code>
                        {' · '}{formatRelative(diag.last_media_send.at_ms)}
                        {diag.last_media_send.error
                          ? <div className="dlv-diag-err">{diag.last_media_send.error}</div>
                          : null}
                      </span>
                    )
                  : <span className="cell-faint">none</span>}
              </div>
            </div>
            <div className="dlv-diag-cell">
              <div className="dlv-tpl-label">Last media delivered (per webhook)</div>
              <div className="dlv-diag-value">
                {diag.last_media_delivered
                  ? (
                      <span>
                        ✓ {diag.last_media_delivered.delivery_id}
                        {' · '}{formatRelative(diag.last_media_delivered.at_ms)}
                      </span>
                    )
                  : <span className="cell-faint">none</span>}
              </div>
            </div>
          </div>
        </section>
      )}

      {toast && createPortal(
        <div className={`gen-toast gen-toast-${toast.kind}`} role="status" aria-live="polite">
          <span className="gen-toast-dot" aria-hidden="true" />
          {toast.message}
        </div>,
        document.body,
      )}
    </>
  )
}
