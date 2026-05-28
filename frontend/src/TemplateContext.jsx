// In-memory + sessionStorage cache for the uploaded template preview so
// switching routes inside the SPA doesn't wipe what the operator just
// dropped on the Templates page. The actual File object lives in memory
// only (browsers don't let JS reconstruct a File from a stored path);
// metadata + the object-URL preview are mirrored to sessionStorage so a
// route transition rehydrates the visible preview card immediately.
//
// On full page reload the in-memory File is gone, but if the metadata
// is in sessionStorage we still render the filename / size / kind so
// the operator knows "yes, a file was selected this session" — they
// just need to re-pick it before uploading. This matches the user's
// "navigation shouldn't clear preview" ask without bloating storage
// with multi-MB data URLs.

import { createContext, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'mm_template_preview_v1'

// Shape:
//   { video: Slot|null, image: Slot|null }
// Slot:
//   { file: File|null, previewURL: string|null, name, size, type, savedAt }

function loadInitial() {
  if (typeof sessionStorage === 'undefined') return { video: null, image: null }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { video: null, image: null }
    const parsed = JSON.parse(raw)
    // File / object-URL don't survive serialisation — strip both back to
    // null so consumers re-pick the file before any upload. Metadata is
    // preserved for the empty-state hint.
    return {
      video: parsed.video ? { ...parsed.video, file: null, previewURL: null } : null,
      image: parsed.image ? { ...parsed.image, file: null, previewURL: null } : null,
    }
  } catch (_) {
    return { video: null, image: null }
  }
}

function persist(state) {
  if (typeof sessionStorage === 'undefined') return
  try {
    const serialisable = {
      video: state.video ? {
        name: state.video.name, size: state.video.size,
        type: state.video.type, savedAt: state.video.savedAt,
      } : null,
      image: state.image ? {
        name: state.image.name, size: state.image.size,
        type: state.image.type, savedAt: state.image.savedAt,
      } : null,
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serialisable))
  } catch (_) {}
}

const TemplateCtx = createContext(null)

export function TemplateProvider({ children }) {
  const [state, setState] = useState(loadInitial)

  useEffect(() => { persist(state) }, [state])

  function setSlot(kind, slot) {
    setState((prev) => ({ ...prev, [kind]: slot }))
  }
  function clearSlot(kind) {
    setState((prev) => {
      const next = prev[kind]
      if (next?.previewURL) {
        try { URL.revokeObjectURL(next.previewURL) } catch (_) {}
      }
      return { ...prev, [kind]: null }
    })
  }

  return (
    <TemplateCtx.Provider value={{ state, setSlot, clearSlot }}>
      {children}
    </TemplateCtx.Provider>
  )
}

export function useTemplateSlot(kind) {
  const ctx = useContext(TemplateCtx)
  if (!ctx) throw new Error('useTemplateSlot must be inside <TemplateProvider>')
  return {
    slot: ctx.state[kind],
    setSlot: (slot) => ctx.setSlot(kind, slot),
    clearSlot: () => ctx.clearSlot(kind),
  }
}
