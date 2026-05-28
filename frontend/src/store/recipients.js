/**
 * Central recipients store — every successful /generate call adds an entry here.
 *
 * Persisted to localStorage via zustand's `persist` middleware with corruption
 * recovery: if the saved JSON is unreadable, the store falls back to an empty
 * list instead of crashing the app.
 *
 * Status vocabulary (canonical across pages):
 *   'Queued' | 'Sending' | 'Delivered' | 'Failed'
 *
 * Dashboard maps these to its shorter labels (Sent/Pending/Failed) in its
 * render layer; we keep the canonical names here so Delivery + Generated can
 * filter cleanly.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const STORAGE_KEY = 'mediaflow:recipients-v1'

// Avatar tones used by Dashboard's <op-avatar-*> classes.
const AVATAR_TONES = ['peach', 'blue-grey', 'orange', 'grey']

function newId() {
  // crypto.randomUUID is available in modern browsers; fallback for older ones
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function basename(p) {
  if (!p) return ''
  // Handle both Windows and POSIX separators.
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

function deriveDisplayName(address, phone) {
  // Prefer the phone as the canonical "recipient" identity; fall back to
  // the first segment of the address if no phone was supplied.
  if (phone && phone.trim()) return phone.trim()
  if (address && address.trim()) return address.trim().split(',')[0]
  return 'Unknown recipient'
}

function deriveCity(address) {
  if (!address) return null
  // best-effort: last comma segment, trimmed; cap to 40 chars.
  const parts = String(address).split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  return parts[parts.length - 1].slice(0, 40)
}

// Validates a stored entry — drops anything that doesn't look like a recipient.
function isValidEntry(e) {
  return e
    && typeof e === 'object'
    && typeof e.id === 'string'
    && typeof e.generatedAt === 'number'
}

export const useRecipientsStore = create(
  persist(
    (set, get) => ({
      items: [],

      /**
       * Add a recipient after a successful /generate response.
       * Returns the newly created entry.
       */
      addFromGenerate({ address, phone, imagePath, videoPath }) {
        const ts = Date.now()
        const id = newId()
        const items = get().items
        const tone = AVATAR_TONES[items.length % AVATAR_TONES.length]
        const entry = {
          id,
          recipientName: deriveDisplayName(address, phone),
          address: (address || '').trim(),
          phone: (phone || '').trim(),
          city: deriveCity(address),
          imagePath: imagePath || null,
          videoPath: videoPath || null,
          imageFileName: basename(imagePath),
          videoFileName: basename(videoPath),
          generatedAt: ts,
          // New entries are queued; a future WhatsApp send flow will flip
          // them to Sending / Delivered / Failed.
          status: 'Queued',
          avatarTone: tone,
        }
        set({ items: [entry, ...items] })
        return entry
      },

      updateStatus(id, status) {
        set((s) => ({
          items: s.items.map((it) => (it.id === id ? { ...it, status } : it)),
        }))
      },

      removeOne(id) {
        set((s) => ({ items: s.items.filter((it) => it.id !== id) }))
      },

      clearAll() {
        set({ items: [] })
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => {
        // Defensive: localStorage isn't available in some sandboxes.
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage
          }
        } catch { /* ignore */ }
        // No-op storage so the store still works in memory.
        return {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        }
      }),
      // Corruption-recovery: ignore unreadable / mis-shaped entries silently.
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== 'object') return current
        const rawItems = Array.isArray(persisted.items) ? persisted.items : []
        const items = rawItems.filter(isValidEntry)
        return { ...current, items }
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          // localStorage value was malformed; reset cleanly.
          try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
        }
      },
    }
  )
)

// -----------------------------------------------------------------------------
// Display helpers used by pages
// -----------------------------------------------------------------------------

/** Map a Date to "HH:MM today" / "Yesterday" / "DD MMM" coarse-bucket label. */
export function formatGeneratedAt(epochMs) {
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

/** Coarse date bucket used by the Generated page filter. */
export function dateBucket(epochMs) {
  if (!epochMs) return 'Earlier'
  const d = new Date(epochMs)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const ms = epochMs
  if (ms >= startOfToday) return 'Today'
  if (ms >= startOfToday - 86400000) return 'Yesterday'
  if (ms >= startOfToday - 2 * 86400000) return '2 days ago'
  return 'Earlier'
}

/** Map Delivery's status to Dashboard's shorter pill set. */
export function dashboardStatusLabel(status) {
  switch (status) {
    case 'Delivered': return 'Sent'
    case 'Sending':   return 'Pending'
    case 'Queued':    return 'Pending'
    case 'Failed':    return 'Failed'
    default:          return 'Pending'
  }
}
