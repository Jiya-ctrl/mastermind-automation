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
// validator accepts any string up to 64 chars, so the input also
// supports custom typing.
const FONT_OPTIONS = [
  // Sans-serif (UI / modern)
  'DejaVu Sans',
  'Inter',
  'Plus Jakarta Sans',
  'Manrope',
  'Open Sans',
  'Roboto',
  'Poppins',
  'Lato',
  'Montserrat',
  'Nunito',
  'Source Sans Pro',
  'Raleway',
  'Work Sans',
  'Arial',
  'Helvetica',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Calibri',
  'Segoe UI',
  // Serif (formal / editorial)
  'Times New Roman',
  'Georgia',
  'Merriweather',
  'Playfair Display',
  'Lora',
  'Cambria',
  'Garamond',
  'Book Antiqua',
  // Display / decorative
  'Bebas Neue',
  'Oswald',
  'Anton',
  // Monospace
  'Courier New',
  'Consolas',
  'Source Code Pro',
]

// Background mode — "orange_strip" and "white_strip" removed from the
// UI per operator request: they're just colour presets of custom_strip
// (#F97316 / #FFFFFF) so keeping all three was redundant. Backend
// still accepts them for any pre-existing persisted config.
const BG_MODES = [
  { key: 'on_template',  label: 'On template',  hint: 'Print directly on the template’s own area (recommended for templates with a designed footer)' },
  { key: 'custom_strip', label: 'Coloured strip', hint: 'Paint a full-width strip in any colour you pick — replaces the old Orange/White presets' },
]

const POSITION_OPTIONS = [
  { key: 'bottom', label: 'Bottom' },
  { key: 'center', label: 'Center' },
  { key: 'top',    label: 'Top' },
]

const ALIGN_OPTIONS = [
  { key: 'left',   label: 'Left'   },
  { key: 'center', label: 'Center' },
  { key: 'right',  label: 'Right'  },
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
  // Surfaced to the preview card so the operator can see WHY a template
  // failed to load (proxy issue / missing file / 401) — rather than the
  // current silent placeholder.
  const [templateError, setTemplateError] = useState({ image: null, video: null })
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
  // returns:
  //   - data_uri  (images only — inline base64, ZERO proxy/auth deps)
  //   - url       (signed URL on /files/templates/, used for video)
  // We prefer data_uri because it survives any reverse-proxy quirks
  // — the actual bytes are in the JSON response.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const kind of ['image', 'video']) {
        try {
          const res = await fetch(`${API_BASE}/current-template?kind=${kind}`)
          if (!res.ok) {
            const txt = await res.text().catch(() => '')
            console.warn(`[preview] /current-template?kind=${kind} → ${res.status}`, txt)
            if (!cancelled) {
              setTemplateError((e) => ({ ...e, [kind]: `HTTP ${res.status}` }))
            }
            continue
          }
          const data = await res.json().catch(() => ({}))
          const src = data?.data_uri || (data?.url ? `${API_BASE}${data.url}` : null)
          if (!src) {
            console.warn(`[preview] /current-template?kind=${kind} returned no usable source`, data)
            if (!cancelled) {
              setTemplateError((e) => ({ ...e, [kind]: 'no source in response' }))
            }
            continue
          }
          if (cancelled) return
          if (kind === 'image') setTemplateImageUrl(src)
          else setTemplateVideoUrl(src)
        } catch (e) {
          console.warn(`[preview] template fetch error (${kind}):`, e)
          if (!cancelled) {
            setTemplateError((s) => ({ ...s, [kind]: e.message || 'network error' }))
          }
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
            <Row label="Font family" hint="Pick from the list or type a custom font name">
              <input
                type="text"
                className="pstyle-input"
                list="pstyle-font-options"
                value={cfg.font_family}
                onChange={(e) => set('font_family', e.target.value)}
                spellCheck="false"
                placeholder="Start typing or pick from list…"
              />
              <datalist id="pstyle-font-options">
                {FONT_OPTIONS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Row>
            <Row label="Font size" hint="12–200 px. Type any number or drag the slider.">
              <div className="pstyle-stepper">
                <FreeNumberInput
                  min={12} max={200} step={1}
                  value={cfg.font_size}
                  fallback={defaults.font_size}
                  onCommit={(n) => set('font_size', n)}
                  className="pstyle-input pstyle-input-num"
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
            <Row label="Text color" hint="Used for all personalisation text (address, contact, phone, name)">
              <ColorField
                value={cfg.font_color}
                onChange={(v) => set('font_color', v)}
                presets={COLOUR_PRESETS}
              />
            </Row>
            <Row label="Bold everything" hint="Renders the entire personalisation block in bold weight">
              <Toggle
                value={cfg.bold_name}
                onChange={(v) => set('bold_name', v)}
              />
            </Row>
            <Row label="Text alignment" hint="How lines align within the strip / overlay area">
              <div className="pstyle-segment">
                {ALIGN_OPTIONS.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    className={`pstyle-segment-btn${(cfg.text_align || 'left') === a.key ? ' pstyle-segment-btn-active' : ''}`}
                    onClick={() => set('text_align', a.key)}
                  >{a.label}</button>
                ))}
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
              <Row label="Strip height" hint="How tall the strip is (5%–50% of the frame). Type any value or drag.">
                <div className="pstyle-stepper">
                  <FreeNumberInput
                    min={0.05} max={0.5} step={0.01} decimals={2}
                    value={cfg.strip_height_pct}
                    fallback={defaults.strip_height_pct}
                    onCommit={(n) => set('strip_height_pct', n)}
                    className="pstyle-input pstyle-input-num"
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
            <Row label="Margin from edge" hint="Distance from the edge (0%–30% of frame height). Type any value or drag.">
              <div className="pstyle-stepper">
                <FreeNumberInput
                  min={0} max={0.3} step={0.01} decimals={2}
                  value={cfg.margin_pct}
                  fallback={defaults.margin_pct}
                  onCommit={(n) => set('margin_pct', n)}
                  className="pstyle-input pstyle-input-num"
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
          <PreviewCard kind="image" cfg={cfg} mediaUrl={templateImageUrl}
                       data={previewData} errorMsg={templateError.image} />
          <PreviewCard kind="video" cfg={cfg} mediaUrl={templateVideoUrl}
                       data={previewData} errorMsg={templateError.video} />
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
function PreviewCard({ kind, cfg, mediaUrl, data, errorMsg }) {
  const isImage = kind === 'image'
  const preview = data || FALLBACK_PREVIEW

  // Strip background colour — derived from background_mode + strip_color.
  // 'on_template' renders without a coloured strip so the text floats on
  // the actual template media, matching production behaviour. Legacy
  // orange_strip / white_strip values are kept readable for any saved
  // configs that still hold them.
  const stripBg =
    cfg.background_mode === 'orange_strip' ? '#F97316' :
    cfg.background_mode === 'white_strip'  ? '#FFFFFF' :
    cfg.background_mode === 'custom_strip' ? cfg.strip_color :
    'transparent'

  // Scale the operator's font_size down for the miniature preview.
  const previewFontPx = Math.max(7, Math.min(14, Math.round(cfg.font_size * 0.18)))

  // Strip-height: preview the operator's strip_height_pct directly so
  // dragging the slider produces a visible effect. The strip occupies a
  // share of the frame height equal to strip_height_pct.
  const hasStrip = cfg.background_mode !== 'on_template'
  const stripHeightCss = hasStrip
    ? `${Math.round((cfg.strip_height_pct || 0.24) * 100)}%`
    : 'auto'
  const textAlign = cfg.text_align || 'left'
  const fontWeight = cfg.bold_name ? 700 : 400

  // Vertical alignment within the card — drives flexbox justify-content
  // on the wrapper so the overlay sits where the operator chose.
  const justify =
    cfg.position === 'top'    ? 'flex-start' :
    cfg.position === 'center' ? 'center'     :
                                'flex-end'

  // Margin from edge — wrap padding reflects the operator's margin_pct
  // so dragging the slider visibly shifts the strip in/out from the edge.
  const wrapPadding = `${Math.round((cfg.margin_pct || 0) * 100)}% 0`

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
              {errorMsg
                ? <>Couldn't load template<br/><small style={{ opacity: 0.85 }}>{errorMsg}</small></>
                : <>Template {isImage ? 'image' : 'video'} plays here</>}
            </div>
          )}
        <div
          className="pstyle-preview-overlay-wrap"
          style={{ justifyContent: justify, padding: wrapPadding }}
        >
          <div
            className="pstyle-preview-overlay"
            style={{
              padding:     '8px 12px',
              height:      stripHeightCss,
              minHeight:   hasStrip ? stripHeightCss : 'auto',
              boxSizing:   'border-box',
              display:     'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              background:  stripBg,
              color:       cfg.font_color,
              fontFamily:  `'${cfg.font_family}', system-ui, sans-serif`,
              fontSize:    previewFontPx,
              fontWeight,
              textAlign,
            }}
          >
            <div className="pstyle-preview-line">
              Address: {preview.address}
            </div>
            <div className="pstyle-preview-line">
              Contact: {preview.name} {preview.phone}
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

// Number input that lets the operator type freely — partial values
// like "5" or "0." don't snap to the min until they blur or hit Enter.
// Solves the "I can't type a value, it keeps jumping" complaint without
// removing the clamp guarantee (committed value is always in range).
function FreeNumberInput({ value, min, max, step, decimals, fallback, onCommit, className }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    // Sync external changes (slider drag, save reload) into the draft —
    // but only if the operator isn't actively editing a different value.
    const parsedDraft = parseFloat(draft)
    if (!Number.isFinite(parsedDraft) || parsedDraft !== Number(value)) {
      setDraft(String(value))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function commit() {
    let n = parseFloat(draft)
    if (!Number.isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    if (typeof decimals === 'number') n = Math.round(n * 10 ** decimals) / 10 ** decimals
    setDraft(String(n))
    if (n !== Number(value)) onCommit(n)
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      className={className}
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
      }}
    />
  )
}

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
