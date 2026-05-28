import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PageHeader from '../components/PageHeader'

import { API_BASE, friendlyApiError } from '../config'
const JOB_POLL_MS  = 1500   // tight polling so progress feels live
const LIST_POLL_MS = 15000  // background refresh of /recipients

// ---------------------------------------------------------------------------
// Helpers — minimal CSV parser tolerant of quoted commas / quoted newlines.
// Header row optional; if present and looks like field names, it's skipped.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  if (!text || !text.trim()) return []
  const rows = []
  let row = ['']
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++ }
      else if (c === '"') inQuotes = false
      else row[row.length - 1] += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') row.push('')
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++
        rows.push(row); row = ['']
      } else row[row.length - 1] += c
    }
  }
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row)

  if (rows.length === 0) return []
  // Detect/skip header row.
  const first = rows[0].map((s) => (s || '').trim().toLowerCase())
  const looksLikeHeader =
    first.includes('name') || first.includes('phone') || first.includes('address')
  const dataRows = looksLikeHeader ? rows.slice(1) : rows
  // Field order: name, phone, address (the export.csv shape).
  const out = []
  for (const r of dataRows) {
    const name    = (r[0] || '').trim()
    const phone   = (r[1] || '').trim()
    const address = (r[2] || '').trim()
    if (!name && !phone && !address) continue // skip empty lines
    out.push({ name, phone, address })
  }
  return out
}

function blankRow() { return { id: null, name: '', phone: '', address: '' } }

export default function Sheets() {
  // Server-truth recipients list + validation issues.
  const [items, setItems]     = useState([])
  const [issues, setIssues]   = useState([])
  const [updatedAt, setUpdatedAt] = useState(0)
  const [loaded, setLoaded]   = useState(false)
  const [error, setError]     = useState(null)

  // Connected Google Sheet (or null).
  const [sheetSource, setSheetSource] = useState(null)

  // UI mode.
  const [editMode, setEditMode] = useState(false)
  const [addOpen,  setAddOpen]  = useState(false)
  // 'paste' | 'file' | 'gsheet' — which import method the add-panel shows.
  const [importMode, setImportMode] = useState('paste')
  const [csvText,  setCsvText]  = useState('')
  const [gsheetUrl, setGsheetUrl] = useState('')
  const [savingBulk, setSavingBulk] = useState(false)
  const [uploading,  setUploading]  = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [syncing,    setSyncing]    = useState(false)
  const fileInputRef = useRef(null)

  // Inline edit buffer — when in editMode we keep a local working copy so we
  // can save the whole table at once with /recipients/replace.
  const [buffer, setBuffer] = useState([])

  // Generation job.
  const [job, setJob] = useState(null)
  const jobTimerRef     = useRef(null)
  // Refresh button uses a 350ms minimum-spinner timer so the click is felt
  // even when the API responds instantly. Tracked in a ref so we can clear
  // it on unmount and avoid the "setState on unmounted component" warning.
  const refreshTimerRef = useRef(null)

  // Generate-menu (the dropdown that opens from the "Generate Media" CTA).
  // The menu is rendered via a portal at document.body so the page-banner's
  // overflow:hidden cannot clip it.
  const [genMenuOpen, setGenMenuOpen] = useState(false)
  const [genMenuPos, setGenMenuPos] = useState({ top: 0, right: 0, minWidth: 0 })
  const genTriggerRef = useRef(null)  // the <button> the menu is anchored to
  const genMenuRef    = useRef(null)  // the portal-mounted menu element

  // Refresh-button feedback state — separate from `syncing` (used by the
  // Google-Sheet sync) so the local-refresh path has its own tactile loading.
  const [refreshing, setRefreshing] = useState(false)

  // Search.
  const [query, setQuery] = useState('')

  // Global unmount cleanup for stray timers — prevents setState-on-unmounted
  // warnings if the user navigates away mid-refresh.
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    if (jobTimerRef.current)     clearInterval(jobTimerRef.current)
  }, [])

  // ---------- data fetching ----------
  async function refreshRecipients() {
    try {
      const res = await fetch(`${API_BASE}/recipients`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data && data.status === 'success') {
        setItems(data.items || [])
        setIssues(data.issues || [])
        setUpdatedAt(data.updatedAt || 0)
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

  async function refreshSheetSource() {
    try {
      const res = await fetch(`${API_BASE}/recipients/sheet-source`)
      if (!res.ok) return
      const data = await res.json()
      setSheetSource(data?.source || null)
    } catch { /* non-fatal */ }
  }

  async function refresh() {
    await Promise.all([refreshRecipients(), refreshSheetSource()])
  }

  useEffect(() => {
    let cancelled = false
    refresh()
    const t = setInterval(() => { if (!cancelled) refresh() }, LIST_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // ---------- buffer sync ----------
  // When entering edit mode, copy items into the buffer. Discard on cancel.
  function startEdit() {
    setBuffer(items.map((it) => ({ ...it })))
    setEditMode(true)
  }
  function cancelEdit() {
    setBuffer([])
    setEditMode(false)
  }
  function updateBufferRow(idx, field, value) {
    setBuffer((b) => b.map((r, i) => i === idx ? { ...r, [field]: value } : r))
  }
  function deleteBufferRow(idx) {
    setBuffer((b) => b.filter((_, i) => i !== idx))
  }
  function addBufferRow() {
    setBuffer((b) => [...b, blankRow()])
  }

  async function saveEdit() {
    setSavingBulk(true)
    try {
      const res = await fetch(`${API_BASE}/recipients/replace`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: buffer }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setEditMode(false)
      setBuffer([])
      await refresh()
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Save failed: ${msg}`)
    } finally {
      setSavingBulk(false)
    }
  }

  // ---------- "Add New Sheet" — paste CSV mode ----------
  async function importCsvText() {
    const parsed = parseCsv(csvText)
    if (parsed.length === 0) {
      setError('No rows parsed from CSV. Expected columns: name,phone,address')
      return
    }
    setSavingBulk(true)
    try {
      const res = await fetch(`${API_BASE}/recipients/replace`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: parsed }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setAddOpen(false)
      setCsvText('')
      await refresh()
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Import failed: ${msg}`)
    } finally {
      setSavingBulk(false)
    }
  }

  // ---------- Upload CSV/Excel file ----------
  async function importFile(file) {
    if (!file) return
    setError(null)
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${API_BASE}/recipients/import-file`, {
        method: 'POST',
        body:   form,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setAddOpen(false)
      // The new upload replaced recipients on the server — if a Google Sheet
      // was connected previously, the in-memory state still shows it but the
      // recipient data is no longer "from" that sheet. Best UX: clear the
      // sheet source so it stops claiming to be the active source.
      if (sheetSource) {
        await fetch(`${API_BASE}/recipients/sheet-source`, { method: 'DELETE' })
      }
      await refresh()
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Upload failed: ${msg}`)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ---------- Connect Google Sheet (public CSV-export URL) ----------
  async function connectGoogleSheet() {
    if (!gsheetUrl.trim()) {
      setError('Paste the Google Sheet URL first.')
      return
    }
    setError(null)
    setConnecting(true)
    try {
      const res = await fetch(`${API_BASE}/recipients/connect-google-sheet`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: gsheetUrl.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setAddOpen(false)
      setGsheetUrl('')
      await refresh()
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Connect failed: ${msg}`)
    } finally {
      setConnecting(false)
    }
  }

  async function syncGoogleSheet() {
    if (!sheetSource) return
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/recipients/sync-google-sheet`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Sync failed: ${msg}`)
    } finally {
      setSyncing(false)
    }
  }

  async function disconnectGoogleSheet() {
    try {
      await fetch(`${API_BASE}/recipients/sheet-source`, { method: 'DELETE' })
      await refreshSheetSource()
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Disconnect failed: ${msg}`)
    }
  }

  // ---------- Open Sheet ----------
  // If a Google Sheet is connected, open it in a new tab. Otherwise download
  // the local recipients as CSV (so the user always has *some* concrete
  // affordance instead of a no-op button).
  function openSheet() {
    if (sheetSource && sheetSource.url) {
      window.open(sheetSource.url, '_blank', 'noopener')
    } else {
      window.location.href = `${API_BASE}/recipients/export.csv`
    }
  }

  // ---------- Generation job (live progress) ----------
  function pollJob(jobId) {
    async function tick() {
      try {
        const res = await fetch(`${API_BASE}/generate-jobs/${jobId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setJob(data)
        if (data.state === 'done' || data.state === 'cancelled') {
          if (jobTimerRef.current) {
            clearInterval(jobTimerRef.current)
            jobTimerRef.current = null
          }
        }
      } catch (e) {
        // Network blip: keep polling.
      }
    }
    tick() // immediate
    if (jobTimerRef.current) clearInterval(jobTimerRef.current)
    jobTimerRef.current = setInterval(tick, JOB_POLL_MS)
  }

  useEffect(() => {
    return () => { if (jobTimerRef.current) clearInterval(jobTimerRef.current) }
  }, [])

  // Compute the menu's fixed-position coords from the trigger's rect, and
  // close on outside click / Escape / scroll / resize.
  useEffect(() => {
    if (!genMenuOpen) return
    function updatePos() {
      const t = genTriggerRef.current
      if (!t) return
      const r = t.getBoundingClientRect()
      // Align right edge to trigger right edge; menu width is the trigger
      // width plus a small bump for breathing room (with a 240px minimum so
      // narrow triggers still get a comfortable menu).
      const minWidth = Math.max(240, Math.round(r.width + 16))
      setGenMenuPos({
        top:      Math.round(r.bottom + 6),
        right:    Math.max(8, Math.round(window.innerWidth - r.right)),
        minWidth,
      })
    }
    function onDocClick(e) {
      // Click is outside the dropdown only if it's outside BOTH the trigger
      // and the portal-mounted menu (the menu lives at document.body now).
      const inTrigger = genTriggerRef.current?.contains(e.target)
      const inMenu    = genMenuRef.current?.contains(e.target)
      if (!inTrigger && !inMenu) setGenMenuOpen(false)
    }
    function onEsc(e) { if (e.key === 'Escape') setGenMenuOpen(false) }
    updatePos()
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true) // capture nested scrolls
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [genMenuOpen])

  // -----------------------------------------------------------------
  // Generation dispatch — STRICTLY isolated pipelines.
  //
  // There are exactly two handlers. The IMAGE handler can only POST a job
  // with kind='images'. The VIDEO handler can only POST kind='videos'.
  // The literal strings are hard-coded inside each function so no caller
  // can accidentally pass the wrong mode. There is no shared "kind = all"
  // path anywhere in the UI flow.
  // -----------------------------------------------------------------
  async function postJob(rowsToGenerate, kind) {
    // Hard guard — if someone calls this with anything other than the two
    // allowed modes, refuse outright. Belt-and-braces in case of a future
    // refactor regression. The console.error stays in production because
    // this should literally never fire — if it does, an operator wants to
    // see it.
    if (kind !== 'images' && kind !== 'videos') {
      // eslint-disable-next-line no-console
      console.error('[Generate] REFUSED — invalid kind:', kind)
      setError(`Internal: postJob called with invalid kind=${kind}`)
      return
    }
    setError(null)
    setJob(null)
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `%c[Generate] DISPATCHING kind=${kind.toUpperCase()} count=${rowsToGenerate.length} — sibling pipeline WILL NOT run`,
        'background:#F97316;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;',
      )
    }
    try {
      const res = await fetch(`${API_BASE}/generate-jobs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ recipients: rowsToGenerate, kind }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.job_id) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      if (data.kind !== kind) {
        // Backend echoed back the wrong kind — refuse to poll. This would
        // only happen if /generate-jobs had a server-side bug.
        throw new Error(
          `Server returned kind=${data.kind}, expected ${kind}. ` +
          'Aborting — server-side pipeline mismatch.'
        )
      }
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log(`[Generate] job ${data.job_id} accepted with kind=${data.kind.toUpperCase()}`)
      }
      pollJob(data.job_id)
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e)
      setError(`Failed to start job: ${msg}`)
    }
  }

  // Errors that genuinely prevent generation (the backend can't render
  // without these). Everything else (duplicates, format hints) is a
  // soft warning we surface but don't block on — the user can still
  // generate the valid rows.
  const BLOCKING_ERRORS = new Set([
    'name required',
    'phone required',
    'address required',
  ])

  function isRowBlocked(rowIdx) {
    const errs = issueByIndex.get(rowIdx)
    if (!errs) return false
    return errs.some((e) => BLOCKING_ERRORS.has(e))
  }

  function sliceForGeneration(count) {
    const limit  = Math.max(0, Math.min(count, items.length))
    const window = items.slice(0, limit)

    // Filter out rows with HARD errors. Soft warnings (duplicate phone,
    // duplicate address, format hints) pass through — operator already
    // sees them in the issues banner, and the backend tolerates them.
    const valid   = []
    const skipped = []
    window.forEach((row, idx) => {
      // Row's index in the full `items` list, not the filtered slice.
      const realIdx = items.indexOf(row)
      if (isRowBlocked(realIdx)) {
        skipped.push({ name: row.name, phone: row.phone, idx: realIdx + 1 })
      } else {
        valid.push(row)
      }
    })

    if (valid.length === 0) {
      setError(
        skipped.length
          ? `All ${skipped.length} selected row(s) have missing required fields — fix the data before generating.`
          : 'No recipients to generate.'
      )
      return null
    }

    if (skipped.length) {
      setError(
        `Skipping ${skipped.length} row(s) with missing name/phone/address (rows ${skipped.map((s) => s.idx).join(', ')}). ` +
        `Generating ${valid.length} valid row(s).`
      )
    }
    return valid
  }

  /** IMAGE PIPELINE — generates ONLY png/jpg outputs. Never calls the
   *  video generator. Hard-coded kind='images' is forwarded to the backend
   *  which already enforces strict isolation. */
  function handleGenerateImages(count) {
    setGenMenuOpen(false)
    const slice = sliceForGeneration(count)
    if (!slice) return
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[Generate] handleGenerateImages(${count}) — IMAGE PIPELINE ONLY`)
    }
    postJob(slice, 'images')
  }

  /** VIDEO PIPELINE — generates ONLY mp4 outputs. Never calls the image
   *  generator. Hard-coded kind='videos'. */
  function handleGenerateVideos(count) {
    setGenMenuOpen(false)
    const slice = sliceForGeneration(count)
    if (!slice) return
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[Generate] handleGenerateVideos(${count}) — VIDEO PIPELINE ONLY`)
    }
    postJob(slice, 'videos')
  }

  /** Hard refresh: re-fetch /recipients (and sheet-source) with visible
   *  spinner feedback so the user can see the action took. */
  async function refreshData() {
    if (refreshing) return
    setRefreshing(true)
    setError(null)
    try {
      await refresh()
    } finally {
      // Brief minimum so the click is felt; instant returns can feel broken.
      // Tracked in a ref so unmount-during-refresh cancels the pending state
      // flip instead of warning about setState on an unmounted component.
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null
        setRefreshing(false)
      }, 350)
    }
  }

  function retryFailed() {
    if (!job || !job.results) return
    const failedRows = job.results
      .filter((r) => !r.ok)
      .map((r) => ({ id: r.id, name: r.name, address: r.address, phone: r.phone }))
    if (failedRows.length === 0) return
    // Retry with the same kind the job was created with so we don't surprise
    // the user with a different scope of work. Route through the named
    // handlers so kind stays hard-coded per pipeline.
    if (job.kind === 'images') postJob(failedRows, 'images')
    else if (job.kind === 'videos') postJob(failedRows, 'videos')
  }

  async function cancelJob() {
    if (!job || !job.id) return
    try {
      await fetch(`${API_BASE}/generate-jobs/${job.id}/cancel`, { method: 'POST' })
    } catch { /* ignore */ }
  }

  /** Pause / resume the currently-running generation job. The backend
   *  keeps the in-flight row to completion (no partial files), then idles
   *  the worker until resume() flips the flag back. */
  async function togglePause() {
    if (!job || !job.id) return
    const path = job.paused ? 'resume' : 'pause'
    try {
      const res = await fetch(`${API_BASE}/generate-jobs/${job.id}/${path}`, {
        method: 'POST',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      // Optimistic flip — the next poll will confirm.
      setJob((j) => j ? { ...j, paused: !j.paused } : j)
    } catch (e) {
      setError(`Could not ${path} job: ${e.message || e}`)
    }
  }

  // ---------- derived state ----------
  const issueByIndex = useMemo(() => {
    const map = new Map()
    for (const iss of issues) map.set(iss.index, iss.errors)
    return map
  }, [issues])

  const visibleRows = editMode ? buffer : items
  const filtered = useMemo(() => {
    if (!query) return visibleRows
    const q = query.toLowerCase()
    return visibleRows.filter((r) =>
      [r.name, r.phone, r.address].some((s) => (s || '').toLowerCase().includes(q))
    )
  }, [visibleRows, query])

  // Map<row -> realIndex> built once per visibleRows change so the table
  // render can look up the real (unfiltered) index in O(1) instead of
  // calling visibleRows.indexOf(r) for every visible row (which is O(n^2)
  // and noticeable on lists of a few hundred recipients).
  const rowIndexMap = useMemo(() => {
    const m = new Map()
    visibleRows.forEach((r, idx) => m.set(r, idx))
    return m
  }, [visibleRows])

  const generating = job && (job.state === 'pending' || job.state === 'running')
  const jobFailed  = job && job.results && job.results.some((r) => !r.ok)
  const progressPct =
    job && job.total ? Math.round((job.progress / job.total) * 100) : 0

  return (
    <>
      <PageHeader
        title="Google Sheets"
        subtitle="Recipient list driving every personalised render — edit, validate, generate."
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setAddOpen((x) => !x)}
              disabled={editMode || generating}
            >➕ Add New Sheet</button>
            {/* Pause / Resume — three-state, state-aware classes:
                  · active    (running)        : green dot, amber pulse glow
                  · pausing   (transient)      : amber spinner, disabled
                  · paused    (worker idle)    : amber dot, no animation
                  · idle      (no active queue): grey dot, dimmed */}
            {(() => {
              const isPausing = generating && job?.paused && !job?.pauseEffective
              const isPaused  = generating && job?.paused &&  job?.pauseEffective
              const isActive  = generating && !job?.paused
              const cls =
                !generating ? ' sheets-pause-btn-idle' :
                isPausing   ? ' sheets-pause-btn-pausing' :
                isPaused    ? ' sheets-pause-btn-paused' :
                              ' sheets-pause-btn-active'
              const label =
                isPausing ? 'Pausing…' :
                isPaused  ? 'Resume Generation' :
                            'Pause Generation'
              const title =
                !generating ? 'No active generation queue' :
                isPausing   ? 'Pausing — current render finishing' :
                isPaused    ? 'Resume the generation queue' :
                              'Pause the generation queue (current row finishes first)'
              return (
                <button
                  type="button"
                  className={`btn sheets-pause-btn${cls}`}
                  onClick={togglePause}
                  disabled={!generating || isPausing}
                  title={title}
                >
                  {isPausing
                    ? <span className="sheets-pause-spinner" aria-hidden="true" />
                    : <span className="sheets-pause-dot"     aria-hidden="true" />}
                  <span className="sheets-pause-icon" aria-hidden="true">
                    {isPausing ? '' : isPaused ? '▶' : '⏸'}
                  </span>
                  <span className="sheets-pause-label">{label}</span>
                </button>
              )
            })()}
            {/* Trigger stays inline inside the banner; the menu is
                portal-mounted on document.body so the banner's
                overflow:hidden cannot clip it. */}
            {/* Count of rows that ARE actually generate-able right now
                (i.e. have the required fields). Soft warnings like
                duplicate-phone don't reduce this count — they're surfaced
                as a banner but don't block the button. */}
            {(() => {
              // intentionally inline so it picks up the latest items/issues
              // without an extra memo
            })()}
            <button
              ref={genTriggerRef}
              type="button"
              className={`btn btn-primary sheets-gen-trigger${genMenuOpen ? ' sheets-gen-trigger-open' : ''}`}
              onClick={() => setGenMenuOpen((x) => !x)}
              disabled={generating || editMode || items.length === 0}
              aria-haspopup="menu"
              aria-expanded={genMenuOpen}
              title={
                items.length === 0
                  ? 'No recipients to generate — connect a sheet first'
                  : (issues.length > 0
                      ? `${issues.length} soft warning(s) on the sheet — generation will skip rows with missing required fields`
                      : '')
              }
            >
              {generating
                ? `⏳ Generating ${job.progress}/${job.total}`
                : '▣ Generate Media'}
              {!generating && (
                <span className="sheets-gen-chevron" aria-hidden="true">▾</span>
              )}
            </button>
            {/* Two-section menu: Images and Videos are independent pipelines.
                Each section offers Generate All + a few common batch sizes. */}
            {genMenuOpen && createPortal(
              <div
                ref={genMenuRef}
                className="sheets-gen-menu sheets-gen-menu-wide"
                role="menu"
                style={{
                  top:      `${genMenuPos.top}px`,
                  right:    `${genMenuPos.right}px`,
                  minWidth: `${Math.max(genMenuPos.minWidth, 260)}px`,
                }}
              >
                <div className="sheets-gen-section">
                  <div className="sheets-gen-section-title">
                    <span className="sheets-gen-section-icon" aria-hidden="true">🖼</span>
                    Images
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="sheets-gen-item sheets-gen-item-all"
                    onClick={() => handleGenerateImages(items.length)}
                  >
                    Generate All Images ({items.length})
                  </button>
                  {[5, 10, 20, 50]
                    .filter((n) => n < items.length)
                    .map((n) => (
                      <button
                        key={`img-${n}`}
                        type="button"
                        role="menuitem"
                        className="sheets-gen-item"
                        onClick={() => handleGenerateImages(n)}
                      >
                        First {n} Images
                      </button>
                    ))}
                </div>
                <div className="sheets-gen-divider" role="separator" />
                <div className="sheets-gen-section">
                  <div className="sheets-gen-section-title">
                    <span className="sheets-gen-section-icon" aria-hidden="true">🎬</span>
                    Videos
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="sheets-gen-item sheets-gen-item-all"
                    onClick={() => handleGenerateVideos(items.length)}
                  >
                    Generate All Videos ({items.length})
                  </button>
                  {[5, 10, 20, 50]
                    .filter((n) => n < items.length)
                    .map((n) => (
                      <button
                        key={`vid-${n}`}
                        type="button"
                        role="menuitem"
                        className="sheets-gen-item"
                        onClick={() => handleGenerateVideos(n)}
                      >
                        First {n} Videos
                      </button>
                    ))}
                </div>
              </div>,
              document.body
            )}
          </>
        }
      />

      {/* Live queue status indicator — only renders while a job exists.
          Distinguishes three pause states:
            · running   — worker is actively rendering
            · pausing   — pause requested, current row still rendering
            · paused    — worker actually idle at the pause gate */}
      {job && (() => {
        const isDone    = job.state === 'done'
        const isCancel  = job.state === 'cancelled'
        const isPausing = job.paused && !job.pauseEffective && !isDone && !isCancel
        const isPaused  = job.paused &&  job.pauseEffective && !isDone && !isCancel
        const cls =
          isPaused  ? 'sheets-queue-status sheets-queue-status-paused' :
          isPausing ? 'sheets-queue-status sheets-queue-status-pausing' :
          isDone    ? 'sheets-queue-status sheets-queue-status-done'   :
          isCancel  ? 'sheets-queue-status sheets-queue-status-cancel' :
                      'sheets-queue-status sheets-queue-status-running'
        // Kind is strictly 'images' or 'videos' — the legacy 'all' mode is
        // unreachable from the UI (no handler dispatches it).
        const isImagesOnly = job.kind === 'images'
        const modeBadge = isImagesOnly
          ? { label: '🖼 IMAGES ONLY', cls: 'sheets-queue-mode-images' }
          : { label: '🎬 VIDEOS ONLY', cls: 'sheets-queue-mode-videos' }
        const kindLabel = isImagesOnly ? 'images' : 'videos'
        const text =
          isPaused  ? 'Generation paused' :
          isPausing ? 'Pausing — current render finishing…' :
          isDone    ? `Done — ${job.progress} ${kindLabel} produced (other pipeline not run)` :
          isCancel  ? 'Queue cancelled' :
                     `Generating ${kindLabel}… ${job.progress}/${job.total}`
        return (
          <div className={cls} role="status" aria-live="polite">
            <span className="sheets-queue-status-dot" aria-hidden="true" />
            <span className={`sheets-queue-mode ${modeBadge.cls}`}>
              {modeBadge.label}
            </span>
            <span className="sheets-queue-status-label">{text}</span>
          </div>
        )
      })()}

      {error && (
        <div className="tmpl-error" role="alert">
          <span aria-hidden="true">⚠️</span> {error}
        </div>
      )}

      {/* ---------- Generation progress card ---------- */}
      {job && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head row">
            <div>
              <h2>
                {job.state === 'running' && '⏳ Generating'}
                {job.state === 'pending' && '⏳ Starting'}
                {job.state === 'done'    && '✅ Generation complete'}
                {job.state === 'cancelled' && '✋ Generation cancelled'}
              </h2>
              <p className="subtle">
                {job.state === 'done'
                  ? `${job.succeeded}/${job.total} succeeded${job.failed ? `, ${job.failed} failed` : ''}.`
                  : `${job.progress}/${job.total} processed${
                      job.current ? ` — current: ${job.current.name || job.current.address}` : ''
                    }`
                }
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {generating && (
                <button type="button" className="btn btn-secondary" onClick={cancelJob}>
                  ✋ Cancel
                </button>
              )}
              {!generating && jobFailed && (
                <button type="button" className="btn btn-primary" onClick={retryFailed}>
                  ↻ Retry Failed ({job.failed})
                </button>
              )}
              {!generating && (
                <button type="button" className="btn btn-ghost" onClick={() => setJob(null)}>
                  Dismiss
                </button>
              )}
            </div>
          </div>
          <div
            aria-label="progress"
            style={{
              height: 6,
              background: 'rgba(15,23,42,0.06)',
              borderRadius: 999,
              overflow: 'hidden',
              marginTop: 8,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progressPct}%`,
                background: 'linear-gradient(90deg, #F97316, #EA580C)',
                transition: 'width 200ms ease',
              }}
            />
          </div>

          {job.state === 'done' && jobFailed && (
            <ul style={{ margin: '12px 0 0 0', paddingLeft: 18, fontSize: 13 }}>
              {job.results.filter((r) => !r.ok).map((r, i) => {
                const why = r.error
                  || r.video?.stderr
                  || r.image?.stderr
                  || 'unknown error'
                return (
                  <li key={i} style={{ color: '#B91C1C', marginBottom: 4 }}>
                    <strong>{r.name || r.address}</strong>: {String(why).split('\n').pop()}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {/* ---------- Add New Sheet — 3-mode import panel ---------- */}
      {addOpen && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head row">
            <div>
              <h2>Import recipients</h2>
              <p className="subtle">
                Choose a source. All three replace the current recipient list.
                Required columns: <code>name</code>, <code>phone</code>, <code>address</code>.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setAddOpen(false); setCsvText(''); setGsheetUrl('') }}
            >Close</button>
          </div>

          {/* Source switcher — uses existing filter-pill style classes */}
          <div className="filter-pills" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className={`filter-pill${importMode === 'paste'  ? ' filter-pill-active' : ''}`}
              onClick={() => setImportMode('paste')}
            >📋 Paste CSV</button>
            <button
              type="button"
              className={`filter-pill${importMode === 'file'   ? ' filter-pill-active' : ''}`}
              onClick={() => setImportMode('file')}
            >📁 Upload File</button>
            <button
              type="button"
              className={`filter-pill${importMode === 'gsheet' ? ' filter-pill-active' : ''}`}
              onClick={() => setImportMode('gsheet')}
            >🔗 Google Sheet</button>
          </div>

          {importMode === 'paste' && (
            <>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={'name,phone,address\nAarav Sharma,+91 77700 80900,"SKF Colony, Pune"'}
                rows={8}
                style={{
                  width: '100%', fontFamily: 'monospace', fontSize: 13,
                  padding: 12, borderRadius: 10, border: '1px solid rgba(15,23,42,0.12)',
                  background: 'rgba(15,23,42,0.02)', resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCsvText('')}
                  disabled={savingBulk}
                >Clear</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={importCsvText}
                  disabled={savingBulk || !csvText.trim()}
                >{savingBulk ? 'Importing…' : 'Replace recipients'}</button>
              </div>
            </>
          )}

          {importMode === 'file' && (
            <div>
              <p style={{ fontSize: 13.5, color: '#584237', margin: '0 0 12px 0' }}>
                Drag a <code>.csv</code> or <code>.xlsx</code> file here, or click to browse.
                The first sheet of an Excel workbook is used; header row is auto-detected.
              </p>
              <FileDrop
                disabled={uploading}
                onPick={importFile}
                fileInputRef={fileInputRef}
              />
              {uploading && (
                <p style={{ marginTop: 10, color: '#584237', fontSize: 13 }}>Uploading + parsing…</p>
              )}
            </div>
          )}

          {importMode === 'gsheet' && (
            <div>
              <p style={{ fontSize: 13.5, color: '#584237', margin: '0 0 12px 0' }}>
                Share your Google Sheet as <strong>“Anyone with the link can view”</strong>,
                then paste its URL below. No OAuth needed — the sheet's CSV export is
                re-fetched every time you click <em>Sync from Google</em>.
              </p>
              <input
                type="text"
                value={gsheetUrl}
                onChange={(e) => setGsheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/<sheet-id>/edit#gid=0"
                style={{
                  width: '100%', fontFamily: 'monospace', fontSize: 13,
                  padding: '10px 12px', borderRadius: 10,
                  border: '1px solid rgba(15,23,42,0.12)',
                  background: 'rgba(15,23,42,0.02)',
                }}
              />
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={connectGoogleSheet}
                  disabled={connecting || !gsheetUrl.trim()}
                >{connecting ? 'Connecting…' : 'Connect & Sync'}</button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------- Connected Google Sheet pill ---------- */}
      {sheetSource && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head row">
            <div>
              <h2>🔗 Google Sheet connected</h2>
              <p className="subtle">
                Last sync:{' '}
                <strong>{sheetSource.lastSync ? new Date(sheetSource.lastSync).toLocaleTimeString() : '—'}</strong>
                {' · '}
                {sheetSource.rowCount ?? '—'} rows
                {sheetSource.status === 'error' && (
                  <> · <span style={{ color: '#B91C1C' }}>error: {sheetSource.lastError || 'unknown'}</span></>
                )}
                {' · '}
                <a href={sheetSource.url} target="_blank" rel="noreferrer">open in Google Sheets ↗</a>
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={syncGoogleSheet}
                disabled={syncing || generating}
              >🔄 {syncing ? 'Syncing…' : 'Sync now'}</button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={disconnectGoogleSheet}
                disabled={syncing || generating}
              >Disconnect</button>
            </div>
          </div>
        </section>
      )}

      {/* ---------- Connection / meta card ---------- */}
      <section className="card">
        <div className="card-head row">
          <div>
            <h2>Connection Status</h2>
            <p className="subtle">
              Your recipient database is synced and ready for personalised
              video generation.
            </p>
          </div>
          <span className="pill pill-success">● Connected</span>
        </div>

        <div className="sheets-meta sheets-meta-premium">
          <div className="meta-cell">
            <div className="meta-label">Total Contacts</div>
            <div className="meta-value">{items.length}</div>
            <div className="meta-foot">{issues.length === 0 ? 'all rows valid' : `${issues.length} need attention`}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Columns detected</div>
            <div className="meta-value">3</div>
            <div className="meta-foot">Name · Phone · Address</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Last update</div>
            <div className="meta-value">{updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}</div>
            <div className="meta-foot">live recipient sync</div>
          </div>
        </div>

        <div className="sheet-actions">
          {/* Label is route-dependent: when a Google Sheet is connected the
              button opens the live sheet in a new tab; otherwise it
              downloads the local recipients as CSV (the real behavior). */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={openSheet}
            disabled={items.length === 0}
            title={sheetSource ? 'Open the connected Google Sheet in a new tab' : 'Download recipients as CSV'}
          >
            {sheetSource
              ? <><span>↗</span> Open Sheet</>
              : <><span>↓</span> Download Sheet</>}
          </button>
          {!editMode ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={startEdit}
              disabled={generating || addOpen}
            ><span>✏️</span> Edit Data</button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={saveEdit}
                disabled={savingBulk}
              >✓ Save changes ({buffer.length} rows)</button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={cancelEdit}
                disabled={savingBulk}
              >Cancel</button>
            </>
          )}
          {/* Refresh / Sync — wording + behaviour match the actual flow:
                * connected Google Sheet → real network sync (syncing state)
                * otherwise → local re-fetch of recipients.json (refreshing state)
              Each path has its own spinner so the click is always felt. */}
          <button
            type="button"
            className={`btn btn-secondary${(syncing || refreshing) ? ' is-busy' : ''}`}
            onClick={() => sheetSource ? syncGoogleSheet() : refreshData()}
            disabled={generating || syncing || refreshing}
            title={sheetSource
              ? 'Re-fetch the connected Google Sheet'
              : 'Re-read recipients.json from disk'}
          >
            <span className={`sheets-refresh-icon${(syncing || refreshing) ? ' sheets-refresh-spinning' : ''}`}>🔄</span>
            {' '}
            {syncing
              ? 'Syncing…'
              : refreshing
                ? 'Refreshing…'
                : (sheetSource ? 'Sync from Google' : 'Refresh Data')}
          </button>
        </div>
      </section>

      {/* ---------- Recipient table ---------- */}
      <section className="card sheets-recipient-card">
        <div className="card-head row sheets-recipient-head">
          <div>
            <h2>Recipient Data</h2>
            <p className="subtle">
              Showing {filtered.length} of {visibleRows.length} rows
              {editMode ? ' (edit mode)' : ''}.
            </p>
          </div>
          <div className="search search-inline">
            <span aria-hidden="true">🔍</span>
            <input
              type="text"
              placeholder="Search name, phone or address…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="table-wrap sheets-recipient-tablewrap">
          <table className="delivery-table sheets-recipient-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>Contact Name</th>
                <th>Phone Number</th>
                <th>Address</th>
                <th style={{ width: 200 }}>{editMode ? 'Actions' : 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, displayIdx) => {
                // The real row index against the full list (issues map uses
                // the full-list index, not filtered). O(1) Map lookup —
                // see `rowIndexMap` above for why this isn't `.indexOf()`.
                const realIdx = rowIndexMap.get(r) ?? -1
                const rowIssues = issueByIndex.get(realIdx)
                return (
                  <tr key={r.id || `new-${realIdx}`}>
                    <td className="cell-faint">{realIdx + 1}</td>

                    <td>
                      {editMode ? (
                        <input
                          value={r.name}
                          onChange={(e) => updateBufferRow(realIdx, 'name', e.target.value)}
                          placeholder="Name"
                          style={inputStyle}
                        />
                      ) : (
                        <div className="cell-name">
                          <span className="cell-avatar">
                            {(r.name || '?').split(' ').map((p) => p[0]).join('').slice(0,2).toUpperCase()}
                          </span>
                          <span>{r.name || <em style={{ color: '#B91C1C' }}>(missing name)</em>}</span>
                        </div>
                      )}
                    </td>

                    <td className="cell-file">
                      {editMode ? (
                        <input
                          value={r.phone}
                          onChange={(e) => updateBufferRow(realIdx, 'phone', e.target.value)}
                          placeholder="+91 99999 99999"
                          style={inputStyle}
                        />
                      ) : r.phone}
                    </td>

                    <td className="cell-address">
                      {editMode ? (
                        <input
                          value={r.address}
                          onChange={(e) => updateBufferRow(realIdx, 'address', e.target.value)}
                          placeholder="City, State"
                          style={inputStyle}
                        />
                      ) : r.address}
                    </td>

                    <td>
                      {editMode ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => deleteBufferRow(realIdx)}
                          title="Remove this row"
                        >🗑 Remove</button>
                      ) : rowIssues ? (
                        <span
                          className="status-pill status-failed"
                          title={rowIssues.join(' · ')}
                        >⚠️ {rowIssues[0]}</span>
                      ) : (
                        <span className="status-pill status-queued">✓ Valid</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && loaded && (
                <tr>
                  <td colSpan={5} className="cell-empty">
                    {visibleRows.length === 0
                      ? (editMode ? 'No rows. Click "+ Add Row" below to add one.' : 'No recipients yet. Use "Add New Sheet" to import a CSV.')
                      : `No rows match "${query}"`
                    }
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {editMode && (
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
            <button type="button" className="btn btn-secondary" onClick={addBufferRow}>
              + Add Row
            </button>
          </div>
        )}
      </section>
    </>
  )
}

const inputStyle = {
  width: '100%',
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid rgba(15,23,42,0.14)',
  background: '#fff',
  font: 'inherit',
  fontSize: 14,
}

// ---------------------------------------------------------------------------
// File drop / browse — accepts .csv and .xlsx. Reuses the existing tmpl-drop
// styles so we don't add new CSS classes.
// ---------------------------------------------------------------------------
function FileDrop({ disabled, onPick, fileInputRef }) {
  const [dragging, setDragging] = useState(false)
  function onDragOver(e) { e.preventDefault(); if (!disabled) setDragging(true) }
  function onDragLeave()  { setDragging(false) }
  function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const f = e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) onPick(f)
  }
  return (
    <div
      className={`tmpl-drop${dragging ? ' tmpl-drop-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !disabled && fileInputRef.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Drop a CSV or Excel file here, or click to browse"
      style={{ padding: '40px 24px', cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <div className="tmpl-drop-art" aria-hidden="true">
        <div className="tmpl-drop-art-circle">
          <span className="tmpl-drop-art-icon">📁</span>
        </div>
      </div>
      <h3 className="tmpl-drop-title">Drop CSV or Excel file</h3>
      <p className="tmpl-drop-sub">
        or <span className="tmpl-drop-link">click to browse</span> · .csv, .xlsx
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        onChange={(e) => {
          const f = e.target.files && e.target.files[0]
          if (f) onPick(f)
        }}
      />
    </div>
  )
}
