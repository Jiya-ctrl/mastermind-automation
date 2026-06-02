import { useEffect, useState } from 'react'
import { API_BASE, friendlyApiError } from '../config'

// Tab labels in display order. Keys also drive the active-tab state.
const TABS = [
  { key: 'text',       label: '🅰 Text' },
  { key: 'background', label: '🎨 Background' },
  { key: 'position',   label: '📐 Position' },
]

// Full operator palette — laid out Paint-style as a tight 8-column
// grid. Covers every brand scenario in one glance so the operator
// rarely needs the native gradient picker (which is still available
// for true-custom values via the picker chip + hex input).
const COLOUR_PRESETS = [
  // Row 1 — Neutrals (light → dark)
  '#FFFFFF', '#F3F4F6', '#E5E7EB', '#D1D5DB', '#9CA3AF', '#6B7280', '#374151', '#000000',
  // Row 2 — Brand orange / warm browns
  '#FFF1DC', '#FED7AA', '#FDBA74', '#FB923C', '#F97316', '#EA580C', '#9A3412', '#5E2A0F',
  // Row 3 — Reds / pinks / yellows
  '#FECACA', '#F87171', '#EF4444', '#DC2626', '#FCD34D', '#F59E0B', '#FB7185', '#E11D48',
  // Row 4 — Cool greens / teals / blues / purples
  '#86EFAC', '#10B981', '#047857', '#14B8A6', '#60A5FA', '#3B82F6', '#1D4ED8', '#0B1C30',
  // Row 5 — Magentas / violets / pastel accents
  '#A855F7', '#7C3AED', '#EC4899', '#DB2777', '#FBCFE8', '#BFDBFE', '#BBF7D0', '#5E6F95',
]

// Fallback preview data — used ONLY when the operator has no rows in
// their connected sheet yet. As soon as /recipients returns at least
// one row, we render that recipient's actual fields so the operator
// sees the real text they're styling.
const FALLBACK_PREVIEW = {
  name:    'Sample Name',
  phone:   '9999999999',
  address: 'Sample Address, City',
}

// Curated font cascade — system-safe defaults so renders never fall
// back to a missing font. Operator picks from this list; the API
// validator accepts any string up to 64 chars, so power users can
// extend in future without backend changes.
const FONT_OPTIONS = [
  'DejaVu Sans',
  'Inter',
  'Plus Jakarta Sans',
  'Manrope',
  'Open Sans',
  'Roboto',
  'Poppins',
  'Lato',
]

const BG_MODES = [
  { key: 'on_template',  label: 'On template',       hint: 'Print directly on the template’s own area (recommended for templates with a designed footer)' },
  { key: 'orange_strip', label: 'Orange strip',      hint: 'Paint a full-width orange band across the bottom before printing text' },
  { key: 'white_strip',  label: 'White strip',       hint: 'Paint a full-width white band — best with dark text' },
  { key: 'custom_strip', label: 'Custom strip',      hint: 'Pick your own strip colour' },
]

const POSITION_OPTIONS = [
  { key: 'bottom', label: 'Bottom' },
  { key: 'center', label: 'Center' },
  { key: 'top',    label: 'Top' },
]

export default function PersonalisationPanel() {
  // Loaded from /personalisation-config on mount, then mutated in
  // place as the operator tweaks fields. Saved as a delta on Save.
  const [cfg, setCfg]               = useState(null)
  const [original, setOriginal]     = useState(null)
  const [defaults, setDefaults]     = useState(null)
  const [activeTab, setActiveTab]   = useState('text')
  const [saving, setSaving]         = useState(false)
  const [resetting, setResetting]   = useState(false)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [toast, setToast]           = useState(null)
  // Object URLs for the actual uploaded template image + video so the
  // preview cards render the operator's real assets instead of a
  // generic placeholder. Fetched as blobs because /files/templates/*
  // requires a Bearer token (config.js injects it automatically).
  const [templateImageUrl, setTemplateImageUrl] = useState(null)
  const [templateVideoUrl, setTemplateVideoUrl] = useState(null)
  // Live recipient data — the operator wants to see their REAL sheet
  // text in the preview, not a hardcoded mock. Falls back to a generic
  // sample when the sheet is empty.
  const [previewData, setPreviewData] = useState(FALLBACK_PREVIEW)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/personalisation-config`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        if (cancelled) return
        setCfg(data.config)
        setOriginal(data.config)
        setDefaults(data.defaults)
      } catch (e) {
        if (!cancelled) setError(friendlyApiError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Resolve the operator's uploaded template URLs. /current-template
  // now returns a SIGNED url that any <img>/<video> tag can load —
  // same signed-URL scheme already used by /files/videos/ and
  // /files/images/. No blob dance, no auth headers needed on the
  // resulting URL, just a regular HTTP src attribute.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const kind of ['image', 'video']) {
        try {
          const res = await fetch(`${API_BASE}/current-template?kind=${kind}`)
          if (!res.ok) {
            console.warn(`[preview] /current-template?kind=${kind} → ${res.status}`)
            continue
          }
          const data = await res.json().catch(() => ({}))
          if (!data?.url) {
            console.warn(`[preview] /current-template?kind=${kind} returned no url`, data)
            continue
          }
          if (cancelled) return
          const full = `${API_BASE}${data.url}`
          if (kind === 'image') setTemplateImageUrl(full)
          else setTemplateVideoUrl(full)
        } catch (e) {
          console.warn(`[preview] template fetch error (${kind}):`, e)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Pull the first connected recipient so the preview shows REAL
  // sheet data (name / phone / address) instead of a hardcoded mock.
  // The operator wanted to see what their actual rendered output will
  // look like, not generic Lorem-style placeholder text.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/recipients`)
        if (!res.ok) return
        const data = await res.json().catch(() => ({}))
        const first = Array.isArray(data?.items) ? data.items[0] : null
        if (!first || cancelled) return
        setPreviewData({
          name:    (first.name    || '').trim() || FALLBACK_PREVIEW.name,
          phone:   (first.phone   || '').trim() || FALLBACK_PREVIEW.phone,
          address: (first.address || '').trim() || FALLBACK_PREVIEW.address,
        })
      } catch {
        // Sheet not connected yet — keep the fallback preview data.
      }
    })()
    return () => { cancelled = true }
  }, [])

  function set(k, v) {
    setCfg((prev) => ({ ...prev, [k]: v }))
  }

  function flashToast(msg, kind = 'success') {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 2400)
  }

  // Only POST the keys that actually changed — keeps the audit log
  // clean and avoids overwriting fields the operator never touched.
  function changedKeys() {
    if (!cfg || !original) return []
    return Object.keys(cfg).filter((k) => cfg[k] !== original[k])
  }

  async function saveChanges() {
    if (saving) return
    setError(null)
    const keys = changedKeys()
    if (keys.length === 0) {
      flashToast('No changes to save', 'info')
      return
    }
    const payload = {}
    for (const k of keys) payload[k] = cfg[k]
    setSaving(true)
    try {
      const res = await fetch(`${API_BASE}/personalisation-config`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = data.errors?.join('; ') || data.error || `HTTP ${res.status}`
        throw new Error(msg)
      }
      setCfg(data.config)
      setOriginal(data.config)
      flashToast(`Saved ${keys.length} change${keys.length === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      setError(friendlyApiError(e))
    } finally {
      setSaving(false)
    }
  }

  async function resetToDefaults() {
    if (resetting) return
    if (!window.confirm('Reset personalisation style to defaults? This cannot be undone.')) return
    setError(null)
    setResetting(true)
    try {
      const res = await fetch(`${API_BASE}/personalisation-config`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setCfg(data.config)
      setOriginal(data.config)
      flashToast('Reset to defaults', 'success')
    } catch (e) {
      setError(friendlyApiError(e))
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <section className="card pstyle-card">
        <div className="card-head row"><h2>🎨 Personalisation Style</h2></div>
        <div className="pstyle-loading">Loading current style…</div>
      </section>
    )
  }

  if (!cfg) {
    return (
      <section className="card pstyle-card">
        <div className="card-head row"><h2>🎨 Personalisation Style</h2></div>
        <div className="pstyle-error">
          Couldn't load style config{error ? `: ${error}` : ''}.
        </div>
      </section>
    )
  }

  const dirty = changedKeys().length > 0

  return (
    <section className="card pstyle-card">
      <div className="card-head row pstyle-head">
        <div>
          <h2>🎨 Personalisation Style</h2>
          <p className="subtle">
            Control how the recipient's name, phone, and address render
            on every generated image and video. Applies on the next
            render.
          </p>
        </div>
        <div className="pstyle-head-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={resetToDefaults}
            disabled={resetting || saving}
            title="Reset all fields to factory defaults"
          >{resetting ? 'Resetting…' : 'Reset to default'}</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={saveChanges}
            disabled={saving || resetting || !dirty}
            title={dirty ? 'Save changes — applies on next render' : 'No changes to save'}
          >{saving ? 'Saving…' : dirty ? `Save ${changedKeys().length} change${changedKeys().length === 1 ? '' : 's'}` : 'Saved'}</button>
        </div>
      </div>

      <div className="pstyle-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`pstyle-tab${activeTab === t.key ? ' pstyle-tab-active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >{t.label}</button>
        ))}
      </div>

      <div className="pstyle-split">
      <div className="pstyle-body">
        {activeTab === 'text' && (
          <div className="pstyle-grid">
            <Row label="Font family" hint="Used for all personalisation text">
              <select
                className="pstyle-input"
                value={cfg.font_family}
                onChange={(e) => set('font_family', e.target.value)}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
                {!FONT_OPTIONS.includes(cfg.font_family) && (
                  <option value={cfg.font_family}>{cfg.font_family} (custom)</option>
                )}
              </select>
            </Row>
            <Row label="Font size" hint="12–200 px. Auto-fits down if a line overflows.">
              <div className="pstyle-stepper">
                <input
                  type="number"
                  min="12" max="200"
                  className="pstyle-input pstyle-input-num"
                  value={cfg.font_size}
                  onChange={(e) => set('font_size', clampInt(e.target.value, 12, 200, defaults.font_size))}
                />
                <input
                  type="range"
                  min="12" max="200"
                  value={cfg.font_size}
                  onChange={(e) => set('font_size', parseInt(e.target.value, 10))}
                  className="pstyle-slider"
                />
              </div>
            </Row>
            <Row label="Text color" hint="Used for address, contact label, phone (the name line follows the bold toggle below)">
              <ColorField
                value={cfg.font_color}
                onChange={(v) => set('font_color', v)}
                presets={COLOUR_PRESETS}
              />
            </Row>
            <Row label="Bold the name line" hint="Highlights the recipient's name relative to the rest of the block">
              <Toggle
                value={cfg.bold_name}
                onChange={(v) => set('bold_name', v)}
              />
            </Row>
            <Row label="Shadow opacity" hint="0 = no shadow · 1 = strongest. Helps legibility on busy backgrounds.">
              <div className="pstyle-stepper">
                <input
                  type="number"
                  min="0" max="1" step="0.05"
                  className="pstyle-input pstyle-input-num"
                  value={cfg.shadow_opacity}
                  onChange={(e) => set('shadow_opacity', clampFloat(e.target.value, 0, 1, defaults.shadow_opacity))}
                />
                <input
                  type="range"
                  min="0" max="1" step="0.05"
                  value={cfg.shadow_opacity}
                  onChange={(e) => set('shadow_opacity', parseFloat(e.target.value))}
                  className="pstyle-slider"
                />
              </div>
            </Row>
          </div>
        )}

        {activeTab === 'background' && (
          <div className="pstyle-grid">
            <Row label="Background mode" hint="Choose what sits behind the personalisation text">
              <div className="pstyle-mode-list">
                {BG_MODES.map((m) => (
                  <label
                    key={m.key}
                    className={`pstyle-mode${cfg.background_mode === m.key ? ' pstyle-mode-active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="bg-mode"
                      value={m.key}
                      checked={cfg.background_mode === m.key}
                      onChange={() => set('background_mode', m.key)}
                    />
                    <div>
                      <div className="pstyle-mode-label">{m.label}</div>
                      <div className="pstyle-mode-hint">{m.hint}</div>
                    </div>
                  </label>
                ))}
              </div>
            </Row>
            {cfg.background_mode === 'custom_strip' && (
              <Row label="Strip colour" hint="Used when 'Custom strip' mode is selected">
                <ColorField
                  value={cfg.strip_color}
                  onChange={(v) => set('strip_color', v)}
                  presets={COLOUR_PRESETS}
                />
              </Row>
            )}
            {cfg.background_mode !== 'on_template' && (
              <Row label="Strip height" hint="As fraction of frame height (0.05–0.50). Affects strip modes only.">
                <div className="pstyle-stepper">
                  <input
                    type="number"
                    min="0.05" max="0.5" step="0.01"
                    className="pstyle-input pstyle-input-num"
                    value={cfg.strip_height_pct}
                    onChange={(e) => set('strip_height_pct', clampFloat(e.target.value, 0.05, 0.5, defaults.strip_height_pct))}
                  />
                  <input
                    type="range"
                    min="0.05" max="0.5" step="0.01"
                    value={cfg.strip_height_pct}
                    onChange={(e) => set('strip_height_pct', parseFloat(e.target.value))}
                    className="pstyle-slider"
                  />
                  <span className="pstyle-meta">{Math.round(cfg.strip_height_pct * 100)}% of frame</span>
                </div>
              </Row>
            )}
          </div>
        )}

        {activeTab === 'position' && (
          <div className="pstyle-grid">
            <Row label="Vertical position" hint="Where the personalisation block sits within the frame">
              <div className="pstyle-segment">
                {POSITION_OPTIONS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={`pstyle-segment-btn${cfg.position === p.key ? ' pstyle-segment-btn-active' : ''}`}
                    onClick={() => set('position', p.key)}
                  >{p.label}</button>
                ))}
              </div>
            </Row>
            <Row label="Margin from edge" hint="As fraction of frame height (0.0–0.30). Pushes text away from the chosen edge.">
              <div className="pstyle-stepper">
                <input
                  type="number"
                  min="0" max="0.3" step="0.01"
                  className="pstyle-input pstyle-input-num"
                  value={cfg.margin_pct}
                  onChange={(e) => set('margin_pct', clampFloat(e.target.value, 0, 0.3, defaults.margin_pct))}
                />
                <input
                  type="range"
                  min="0" max="0.3" step="0.01"
                  value={cfg.margin_pct}
                  onChange={(e) => set('margin_pct', parseFloat(e.target.value))}
                  className="pstyle-slider"
                />
                <span className="pstyle-meta">{Math.round(cfg.margin_pct * 100)}% of frame height</span>
              </div>
            </Row>
            <div className="pstyle-info">
              Note: position changes apply to the LIBASS overlay (video).
              Image renderer uses its own strip layout for now — full
              parity is coming in the next iteration.
            </div>
          </div>
        )}
      </div>

      {/* Live preview — updates in real time as the operator edits. Two
          mock cards (image + video) sit in the right column so the
          operator can see styling changes WITHOUT scrolling. Sticky
          so the preview follows the operator down through the form. */}
      <aside className="pstyle-preview-section">
        <div className="pstyle-preview-head">
          <h3>🔍 Live preview</h3>
          <p className="pstyle-preview-sub">
            Updates as you edit.
          </p>
        </div>
        <div className="pstyle-preview-grid">
          <PreviewCard kind="image" cfg={cfg} mediaUrl={templateImageUrl} data={previewData} />
          <PreviewCard kind="video" cfg={cfg} mediaUrl={templateVideoUrl} data={previewData} />
        </div>
      </aside>
      </div>

      {error && <div className="pstyle-error">⚠ {error}</div>}
      {toast && (
        <div className={`pstyle-toast pstyle-toast-${toast.kind}`} role="status">
          {toast.msg}
        </div>
      )}
    </section>
  )
}


// ---------- Live preview card ----------------------------------------------

/**
 * Visual mock of how a personalised image/video will look with the current
 * config. Pure CSS — no backend round-trip — so the operator gets instant
 * feedback while dragging sliders. Aspect ratios match real outputs
 * (4:5 for image, 9:16 for video) so the proportions read correctly.
 */
function PreviewCard({ kind, cfg, mediaUrl, data }) {
  const isImage = kind === 'image'
  const preview = data || FALLBACK_PREVIEW

  // Strip background colour — derived from background_mode + strip_color.
  // 'on_template' renders without a coloured strip so the text floats on
  // the actual template media, matching production behaviour.
  const stripBg =
    cfg.background_mode === 'orange_strip' ? '#F97316' :
    cfg.background_mode === 'white_strip'  ? '#FFFFFF' :
    cfg.background_mode === 'custom_strip' ? cfg.strip_color :
    'transparent'

  // Preview font size is scaled — preview cards are ~200px wide so we
  // shrink the actual font_size aggressively but stay legible. A
  // linear scale (46→3px) would be unreadable, so we use a perceptual
  // size that still reacts to operator changes.
  const previewFontPx = Math.max(7, Math.min(12, Math.round(cfg.font_size * 0.18)))

  // Strip auto-sizes to its content in preview so the text never gets
  // clipped — the real renderer applies strip_height_pct on the actual
  // frame, but in this miniature preview we just let it grow as tall as
  // the lines need.
  const stripStyle = { padding: '10px 14px' }

  // Vertical alignment within the card — drives flexbox justify-content
  // on the wrapper so the overlay sits where the operator chose.
  const justify =
    cfg.position === 'top'    ? 'flex-start' :
    cfg.position === 'center' ? 'center'     :
                                'flex-end'

  return (
    <div className="pstyle-preview-card">
      <div className="pstyle-preview-card-label">
        {isImage ? '📷 Image render' : '🎬 Video render (last 5.5s)'}
      </div>
      <div className={`pstyle-preview-frame pstyle-preview-frame-${kind}`}>
        {mediaUrl
          ? (isImage
              ? <img className="pstyle-preview-media" src={mediaUrl} alt="Template" />
              : <video className="pstyle-preview-media" src={mediaUrl} muted autoPlay loop playsInline />)
          : (
            <div className="pstyle-preview-placeholder">
              Template {isImage ? 'image' : 'video'} plays here
            </div>
          )}
        <div
          className="pstyle-preview-overlay-wrap"
          style={{ justifyContent: justify }}
        >
          <div
            className="pstyle-preview-overlay"
            style={{
              ...stripStyle,
              background:  stripBg,
              color:       cfg.font_color,
              fontFamily:  `'${cfg.font_family}', system-ui, sans-serif`,
              fontSize:    previewFontPx,
              textShadow:  cfg.shadow_opacity > 0
                ? `0 1px 2px rgba(0,0,0,${cfg.shadow_opacity})`
                : 'none',
            }}
          >
            <div className="pstyle-preview-line">
              Address: {preview.address}
            </div>
            <div className="pstyle-preview-line pstyle-preview-line-label">
              Contact:
            </div>
            <div
              className="pstyle-preview-line"
              style={{ fontWeight: cfg.bold_name ? 700 : 400 }}
            >
              {preview.name}
            </div>
            <div className="pstyle-preview-line">
              {preview.phone}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


// ---------- tiny pieces -----------------------------------------------------

function Row({ label, hint, children }) {
  return (
    <div className="pstyle-row">
      <div className="pstyle-row-label">
        <div className="pstyle-row-label-main">{label}</div>
        {hint && <div className="pstyle-row-label-hint">{hint}</div>}
      </div>
      <div className="pstyle-row-control">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`pstyle-toggle${value ? ' pstyle-toggle-on' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="pstyle-toggle-knob" />
    </button>
  )
}

function ColorField({ value, onChange, presets }) {
  return (
    <div className="pstyle-color">
      <label className="pstyle-color-picker-wrap" title="Open full colour picker (gradient + RGB)">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="pstyle-color-picker"
          aria-label="Pick a colour"
        />
        <span className="pstyle-color-picker-hint">Click to open full picker</span>
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(normaliseHex(e.target.value, value))}
        className="pstyle-input pstyle-input-hex"
        spellCheck="false"
        maxLength={7}
      />
      <div className="pstyle-color-presets pstyle-color-presets-compact">
        {presets.map((p, idx) => (
          <button
            key={`${p}-${idx}`}
            type="button"
            className={`pstyle-color-preset${p.toUpperCase() === value.toUpperCase() ? ' pstyle-color-preset-active' : ''}`}
            style={{ background: p }}
            title={p}
            onClick={() => onChange(p)}
            aria-label={`Pick ${p}`}
          />
        ))}
      </div>
    </div>
  )
}


// ---------- helpers ---------------------------------------------------------

function clampInt(raw, lo, hi, fallback) {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

function clampFloat(raw, lo, hi, fallback) {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n * 1000) / 1000))
}

function normaliseHex(raw, fallback) {
  let s = (raw || '').trim().toUpperCase()
  if (!s.startsWith('#')) s = '#' + s
  if (/^#[0-9A-F]{6}$/.test(s)) return s
  // Allow typing in progress (don't reject partial input mid-edit);
  // sanitise length and characters, keep the partial string so the
  // operator can finish typing without state resetting.
  s = '#' + s.slice(1).replace(/[^0-9A-F]/g, '').slice(0, 6)
  if (s.length === 7 && /^#[0-9A-F]{6}$/.test(s)) return s
  // Partial input — keep showing it but the persisted value stays
  // valid by returning the last good fallback when length < 7.
  return s.length === 7 ? s : fallback
}
