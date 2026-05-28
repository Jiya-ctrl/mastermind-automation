import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  completePasswordReset,
  formatRecoveryKey,
  getFixedUserId,
  hasDeviceToken,
  isAuthenticated,
  passwordMeetsRules,
  passwordRuleChecks,
  passwordStrength,
  registerDevice,
  secretUnlock,
  signIn,
  unlockWithDevice,
  verifyRecoveryKey,
} from '../auth'
import { BACKEND_CONFIGURED } from '../config'

// ---------- inline icons --------------------------------------------------
const IconUser = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
  </svg>
)
const IconLock = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/>
  </svg>
)
const IconEye = ({ open }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    {open ? (
      <path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5C21.3 7.6 17 4.5 12 4.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>
    ) : (
      <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27z"/>
    )}
  </svg>
)
const IconCheck = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <path d="M9 16.2l-3.5-3.5L4 14.2 9 19.2 20 8.2 18.6 6.8z"/>
  </svg>
)
const IconKey = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
  </svg>
)
const IconShield = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 14l-4-4 1.4-1.4L11 12.2l5.6-5.6L18 8l-7 7z"/>
  </svg>
)

// ---------- Welcome voice (TTS) ------------------------------------------
function scheduleWelcomeVoice() {
  if (typeof window === 'undefined') return
  const synth = window.speechSynthesis
  if (!synth) return
  function pickVoice() {
    const voices = synth.getVoices()
    if (!voices.length) return null
    const prefs = [
      /Samantha/i, /Microsoft Zira/i, /Microsoft Aria/i, /Microsoft Jenny/i,
      /Karen/i, /Microsoft.*Female/i, /Google.*English.*Female/i,
      /Google US English/i, /Female/i,
    ]
    for (const re of prefs) {
      const v = voices.find((x) => re.test(x.name))
      if (v) return v
    }
    return voices.find((v) => (v.lang || '').startsWith('en')) || voices[0]
  }
  let spoken = false
  function doSpeak() {
    if (spoken) return
    spoken = true
    try {
      const u = new SpeechSynthesisUtterance('Hey... Welcome to Mastermind Automation.')
      const v = pickVoice()
      if (v) u.voice = v
      u.lang   = 'en-US'
      u.rate   = 0.92
      u.pitch  = 1.0
      u.volume = 0.75
      synth.speak(u)
    } catch (_) {}
  }
  if (synth.getVoices().length > 0) { doSpeak(); return }
  const onChanged = () => {
    synth.removeEventListener('voiceschanged', onChanged)
    doSpeak()
  }
  synth.addEventListener('voiceschanged', onChanged)
  setTimeout(() => {
    synth.removeEventListener('voiceschanged', onChanged)
    doSpeak()
  }, 400)
}

// ---------- bead audio ----------------------------------------------------
function playBeadClick(volume = 0.12) {
  if (typeof window === 'undefined') return
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    if (!playBeadClick.ctx) playBeadClick.ctx = new Ctx()
    const ctx = playBeadClick.ctx
    if (ctx.state !== 'running') ctx.resume().catch(() => {})
    const t  = ctx.currentTime
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.5
    lp.connect(ctx.destination)
    const base = 720
    const partials = [
      { f: base,     a: 1.00, d: 0.34 },
      { f: base * 4, a: 0.36, d: 0.14 },
      { f: base * 9, a: 0.10, d: 0.06 },
    ]
    partials.forEach(({ f, a, d }) => {
      const osc = ctx.createOscillator()
      const gn  = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(f, t)
      osc.frequency.exponentialRampToValueAtTime(f * 0.95, t + d * 0.5)
      gn.gain.setValueAtTime(0, t)
      gn.gain.linearRampToValueAtTime(volume * a, t + 0.005)
      gn.gain.exponentialRampToValueAtTime(0.0001, t + d)
      osc.connect(gn); gn.connect(lp)
      osc.start(t); osc.stop(t + d + 0.02)
    })
  } catch (_) {}
}

// ---------- Interactive abacus -------------------------------------------
const ROD_COUNT     = 4
const BEAD_COUNT    = 9
const TOTAL_SLOTS   = 11
const SLOT_WIDTH_PX = 32
const PATTERN       = [1, 2, 3, 4]

function beadSlot(beadIdx, activeCount) {
  if (beadIdx < BEAD_COUNT - activeCount) return beadIdx
  return TOTAL_SLOTS - BEAD_COUNT + beadIdx
}

function Abacus({ onUnlock }) {
  // ────────────────────────────────────────────────────────────────────
  //  Hidden login state machine.
  //
  //  Two parallel counters per rod:
  //    counts  — VISIBLE bead positions. Drifts on its own (ambient idle
  //              animation) AND advances forward when the user lands a
  //              correct click. On mistake/idle we snap back to baseline.
  //    secret  — INVISIBLE per-rod click counter. Drives the unlock
  //              detector. Target = PATTERN = [1, 2, 3, 4]: click rod 0
  //              once, rod 1 twice, rod 2 three times, rod 3 four times,
  //              strictly in that order.
  //
  //  Strict mismatch: ANY click on a rod that isn't the next expected
  //  rod resets the whole secret + shakes the frame.
  //
  //  3-second idle timer: each correct click arms a 3s timeout. If no
  //  further click lands before it fires, the sequence silently resets
  //  (no shake — the operator just walked away).
  //
  //  baselineRef freezes the ambient bead positions at the first click
  //  of an attempt so resets can slide every bead smoothly back home
  //  without re-randomising the layout.
  // ────────────────────────────────────────────────────────────────────
  const [counts, setCounts]    = useState([4, 6, 3, 5])
  const [secret, setSecret]    = useState([0, 0, 0, 0])
  const [unlocking, setUnlock] = useState(false)
  const [shake,    setShake]   = useState(false)
  const inPatternRef   = useRef(false)
  const audioActiveRef = useRef(false)
  const baselineRef    = useRef(null) // counts snapshot at first click of attempt
  const idleResetRef   = useRef(null) // setTimeout handle for 3s idle reset

  useEffect(() => {
    function applyState() {
      const ok = document.visibilityState === 'visible' && document.hasFocus()
      audioActiveRef.current = ok
      const ctx = playBeadClick.ctx
      if (!ctx) return
      if (!ok && ctx.state === 'running')   { try { ctx.suspend() } catch (_) {} }
      else if (ok && ctx.state === 'suspended') { try { ctx.resume() } catch (_) {} }
    }
    applyState()
    document.addEventListener('visibilitychange', applyState)
    window.addEventListener('blur', applyState)
    window.addEventListener('focus', applyState)
    return () => {
      document.removeEventListener('visibilitychange', applyState)
      window.removeEventListener('blur', applyState)
      window.removeEventListener('focus', applyState)
      audioActiveRef.current = false
      const ctx = playBeadClick.ctx
      if (ctx && ctx.state === 'running') { try { ctx.suspend() } catch (_) {} }
    }
  }, [])

  function tick(vol) {
    if (!audioActiveRef.current) return
    playBeadClick(vol)
  }

  useEffect(() => {
    if (unlocking) return
    const id = setInterval(() => {
      if (!audioActiveRef.current) return
      if (inPatternRef.current) return
      const idx = Math.floor(Math.random() * ROD_COUNT)
      const dir = Math.random() < 0.5 ? -1 : 1
      let original = null
      setCounts((prev) => {
        original = prev[idx]
        return prev.map((c, i) =>
          i !== idx ? c : Math.max(2, Math.min(7, c + dir))
        )
      })
      tick(0.06)
      setTimeout(() => {
        if (original === null || inPatternRef.current) return
        if (!audioActiveRef.current) return
        setCounts((prev) => prev.map((c, i) => (i !== idx ? c : original)))
      }, 1800)
    }, 6500)
    return () => clearInterval(id)
  }, [unlocking])

  useEffect(() => {
    if (unlocking) return
    const done = PATTERN.every((req, i) => secret[i] === req)
    if (!done) return
    // Sequence solved — stop the idle countdown so it can't yank state
    // out from under the unlock animation, then fire the success burst.
    if (idleResetRef.current) {
      clearTimeout(idleResetRef.current)
      idleResetRef.current = null
    }
    setUnlock(true)
    tick(0.20)
    setTimeout(() => tick(0.16), 280)
    setCounts([8, 8, 8, 8])
    setTimeout(() => onUnlock?.(), 1400)
  }, [secret, unlocking, onUnlock])

  // Cancel any pending idle timer when this Abacus unmounts (e.g. user
  // routes away mid-sequence) so it can't fire on a dead component.
  useEffect(() => () => {
    if (idleResetRef.current) clearTimeout(idleResetRef.current)
  }, [])

  // After the unlock burst fires, re-arm the abacus so the operator can
  // try again if the downstream signIn failed (wrong password, etc).
  // On a successful login the parent unmounts this component before the
  // timeout fires — the cleanup cancels it cleanly.
  useEffect(() => {
    if (!unlocking) return
    const id = setTimeout(() => {
      setUnlock(false)
      setSecret([0, 0, 0, 0])
      if (baselineRef.current) {
        setCounts(baselineRef.current)
        baselineRef.current = null
      }
      inPatternRef.current = false
    }, 2500)
    return () => clearTimeout(id)
  }, [unlocking])

  // Slide every rod back to whatever baseline we captured at the first
  // click of the attempt. Used by both kinds of reset (mistake + idle).
  // Optional `withShake` adds the no-no shake; idle resets skip it.
  function resetSequence(withShake) {
    setSecret([0, 0, 0, 0])
    if (baselineRef.current) {
      setCounts(baselineRef.current)
      baselineRef.current = null
    }
    if (idleResetRef.current) {
      clearTimeout(idleResetRef.current)
      idleResetRef.current = null
    }
    inPatternRef.current = false
    if (withShake) {
      tick(0.10)
      setShake(true)
      setTimeout(() => setShake(false), 480)
    }
  }

  function armIdleReset() {
    if (idleResetRef.current) clearTimeout(idleResetRef.current)
    // 3s pause between steps → silent reset (no shake, just slide back).
    idleResetRef.current = setTimeout(() => resetSequence(false), 3000)
  }

  function onBeadClick(e, rodIdx) {
    e.stopPropagation()
    if (unlocking) return
    inPatternRef.current = true

    // Find the next rod the operator must hit (first rod where the
    // recorded click count is still below the pattern target).
    let expected = -1
    for (let i = 0; i < ROD_COUNT; i++) {
      if (secret[i] < PATTERN[i]) { expected = i; break }
    }

    // Strict mismatch — any wrong row (or any click after the pattern is
    // fully entered, which would also fall through here) hard-resets the
    // attempt and shakes the frame.
    if (rodIdx !== expected) {
      resetSequence(true)
      return
    }

    // Correct click. Capture the baseline at the moment the attempt
    // begins so reset can restore *these* bead positions, not a stale
    // snapshot from a previous attempt.
    if (baselineRef.current === null) {
      baselineRef.current = counts
    }

    tick(0.14)
    // Slide one bead forward on the correct rod.
    setCounts((prev) => prev.map((v, i) =>
      i !== rodIdx ? v : Math.min(BEAD_COUNT, v + 1)
    ))
    // Record the correct click. The unlock-detector useEffect above
    // fires onUnlock the moment secret === PATTERN.
    const nextSecret = secret.slice()
    nextSecret[rodIdx] = nextSecret[rodIdx] + 1
    setSecret(nextSecret)

    // Arm the idle reset. If the operator stops mid-sequence we want
    // the state machine to clean itself up.
    armIdleReset()
  }

  return (
    <button
      type="button"
      className={
        'login-abacus-frame' +
        (unlocking ? ' login-abacus-frame-unlock' : '') +
        (shake     ? ' login-abacus-frame-shake'  : '')
      }
      onClick={() => {}}
      aria-label="Abacus"
    >
      <div className="login-abacus-glow" aria-hidden="true" />
      <div className="login-abacus-shine" aria-hidden="true" />
      <div className="login-abacus-inner">
        {counts.map((activeCount, rodIdx) => (
          <div key={rodIdx} className="login-abacus-rod-wrap">
            <div className="login-abacus-rod-line" />
            {Array.from({ length: BEAD_COUNT }).map((_, beadIdx) => {
              const slot     = beadSlot(beadIdx, activeCount)
              const isActive = beadIdx >= BEAD_COUNT - activeCount
              return (
                <button
                  key={beadIdx}
                  type="button"
                  tabIndex={-1}
                  className={`login-abacus-bead${isActive ? ' login-abacus-bead-active' : ''}`}
                  style={{
                    transform:       `translate(${slot * SLOT_WIDTH_PX}px, -50%)`,
                    transitionDelay: `${beadIdx * 22}ms`,
                  }}
                  onClick={(e) => onBeadClick(e, rodIdx)}
                  aria-label={`Bead ${beadIdx + 1} on row ${rodIdx + 1}`}
                />
              )
            })}
          </div>
        ))}
      </div>
    </button>
  )
}

// ---------- Recovery-key reset modal -------------------------------------
function ResetModal({ open, onClose, onSuccess }) {
  // Steps: 'verify' (User ID + Recovery Key) | 'password' | 'done'
  const [step, setStep] = useState('verify')

  const [userId, setUserId]         = useState(getFixedUserId())
  const [rkey, setRkey]             = useState('')
  const [pw1, setPw1]               = useState('')
  const [pw2, setPw2]               = useState('')
  const [showPw, setShowPw]         = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState(null)

  useEffect(() => {
    if (open) return
    setStep('verify')
    setUserId(getFixedUserId())
    setRkey(''); setPw1(''); setPw2('')
    setError(null); setSubmitting(false); setShowPw(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function describeReason(reason, retryAfterMin) {
    if (reason === 'rate_limit') {
      return `Too many attempts. Try again in ${retryAfterMin || '60'} minutes.`
    }
    if (reason === 'backend_offline') {
      return 'Authentication service offline. Please try again shortly.'
    }
    if (reason === 'network')       return 'Network error. Could not reach the server.'
    if (reason === 'invalid_token') return 'Verification session expired. Start over.'
    if (reason === 'weak')          return 'Password does not meet the security requirements.'
    return 'Invalid User ID or Recovery Key.'
  }

  async function submitVerify(e) {
    e.preventDefault()
    setError(null)
    if (!userId || !rkey) {
      setError('Enter your User ID and Recovery Key.')
      return
    }
    setSubmitting(true)
    const res = await verifyRecoveryKey(userId, rkey)
    setSubmitting(false)
    if (!res.ok) {
      setError(describeReason(res.reason, res.retryAfterMin))
      return
    }
    setStep('password')
  }

  async function submitPassword(e) {
    e.preventDefault()
    setError(null)
    if (!passwordMeetsRules(pw1)) {
      setError('Password must be at least 8 characters and include uppercase, lowercase, number, and special character.')
      return
    }
    if (pw1 !== pw2) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    const res = await completePasswordReset(pw1)
    setSubmitting(false)
    if (!res.ok) {
      setError(describeReason(res.reason))
      return
    }
    setStep('done')
    setTimeout(() => {
      onSuccess?.()
      onClose?.()
    }, 1800)
  }

  if (!open) return null

  const strength = passwordStrength(pw1)
  const rules    = passwordRuleChecks(pw1)
  const LABELS   = ['Too short', 'Weak', 'Fair', 'Good', 'Strong']
  const CLASSES  = ['', 'weak', 'fair', 'good', 'strong']

  return createPortal(
    <div className="reset-overlay" role="dialog" aria-modal="true"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="reset-modal">
        <button type="button" className="reset-close" onClick={onClose} aria-label="Close">×</button>

        <div className="reset-progress" aria-hidden="true">
          <span className={`reset-dot${step === 'verify' ? ' reset-dot-active' : ' reset-dot-done'}`} />
          <span className={`reset-dot${step === 'password' ? ' reset-dot-active' : (step === 'done' ? ' reset-dot-done' : '')}`} />
        </div>

        {step === 'verify' && (
          <form onSubmit={submitVerify} className="reset-step" noValidate>
            <div className="reset-icon-wrap"><span className="reset-icon"><IconShield /></span></div>
            <h2 className="reset-title">Reset Workspace Access</h2>
            <p className="reset-sub">Verify your identity using your secure recovery credentials.</p>

            <label className="reset-label">User ID</label>
            <div className="login-control">
              <span className="login-control-icon"><IconUser /></span>
              <input
                type="text"
                autoComplete="username"
                className="login-input"
                placeholder="mastermind_abc"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                autoFocus
              />
            </div>

            <label className="reset-label">Workspace Recovery Key</label>
            <div className="login-control">
              <span className="login-control-icon"><IconKey /></span>
              <input
                type="text"
                autoComplete="off"
                spellCheck="false"
                className="login-input reset-recovery-input"
                placeholder="MA-XXXX-XXXX-XXXX"
                value={rkey}
                onChange={(e) => setRkey(formatRecoveryKey(e.target.value))}
                maxLength={17}
              />
            </div>

            {error && <div className="login-error" role="alert">{error}</div>}

            <button type="submit" className="login-submit reset-submit" disabled={submitting}>
              <span>{submitting ? 'Verifying…' : 'Continue'}</span>
              <span className="login-submit-arrow" aria-hidden="true">→</span>
            </button>
            <p className="reset-foot">
              Recovery keys are stored offline by the workspace owner. Never share yours.
            </p>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={submitPassword} className="reset-step" noValidate>
            <div className="reset-icon-wrap"><span className="reset-icon"><IconLock /></span></div>
            <h2 className="reset-title">Create New Password</h2>
            <p className="reset-sub">Choose a strong password to secure your workspace.</p>

            <label className="reset-label">New password</label>
            <div className="login-control">
              <span className="login-control-icon"><IconLock /></span>
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                className="login-input login-input-with-suffix"
                placeholder="At least 8 characters"
                value={pw1}
                onChange={(e) => setPw1(e.target.value)}
                autoFocus
              />
              <button type="button" className="login-control-suffix"
                onClick={() => setShowPw((v) => !v)} tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}>
                <IconEye open={showPw} />
              </button>
            </div>

            <div className="reset-strength">
              <div className="reset-strength-bars" aria-hidden="true">
                {[1,2,3,4].map((n) => (
                  <span key={n} className={`reset-strength-bar${strength >= n ? ' reset-strength-bar-' + CLASSES[strength] : ''}`} />
                ))}
              </div>
              <span className={`reset-strength-label reset-strength-label-${CLASSES[strength]}`}>
                {pw1 ? LABELS[strength] : ''}
              </span>
            </div>

            <ul className="reset-rules" aria-hidden="true">
              <li className={rules.length  ? 'reset-rule-ok' : ''}><IconCheck /> 8+ characters</li>
              <li className={rules.upper   ? 'reset-rule-ok' : ''}><IconCheck /> Uppercase letter</li>
              <li className={rules.lower   ? 'reset-rule-ok' : ''}><IconCheck /> Lowercase letter</li>
              <li className={rules.digit   ? 'reset-rule-ok' : ''}><IconCheck /> Number</li>
              <li className={rules.special ? 'reset-rule-ok' : ''}><IconCheck /> Special character</li>
            </ul>

            <label className="reset-label">Confirm password</label>
            <div className="login-control">
              <span className="login-control-icon"><IconLock /></span>
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                className="login-input"
                placeholder="Re-enter the password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
            </div>

            {error && <div className="login-error" role="alert">{error}</div>}
            <button type="submit" className="login-submit reset-submit"
              disabled={submitting || !passwordMeetsRules(pw1) || pw1 !== pw2}>
              <span>{submitting ? 'Updating…' : 'Update Workspace Access'}</span>
              <span className="login-submit-arrow" aria-hidden="true">→</span>
            </button>
          </form>
        )}

        {step === 'done' && (
          <div className="reset-step reset-step-done" role="status">
            <div className="reset-success-icon">
              <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5"/>
              </svg>
            </div>
            <h2 className="reset-title">Password updated</h2>
            <p className="reset-sub">Workspace password updated successfully.<br/>All previous sessions have been signed out.</p>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// ---------- Login page ---------------------------------------------------
export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const returnTo = location.state?.from || '/'

  useEffect(() => {
    if (isAuthenticated()) navigate(returnTo, { replace: true })
  }, [navigate, returnTo])

  const [userId, setUserId]         = useState(getFixedUserId())
  const [password, setPassword]     = useState('')
  const [showPw, setShowPw]         = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState(null)
  const [modalOpen, setModalOpen]   = useState(false)
  const [toast, setToast]           = useState(null)
  // Track whether this browser has a per-device quick-unlock token enrolled.
  // Drives the subtle hint shown below the abacus. Initialised lazily so
  // we don't hit localStorage during module init (SSR-safe).
  const [hasDevice, setHasDevice] = useState(false)
  useEffect(() => { setHasDevice(hasDeviceToken()) }, [])

  // Manual login. `submitting` guards against duplicate submissions when
  // the operator double-clicks the button.
  async function doLogin() {
    if (submitting) return
    setError(null)
    if (!BACKEND_CONFIGURED) {
      setError('Backend not connected. Configure VITE_API_BASE / VITE_AUTH_API in Vercel and redeploy.')
      return
    }
    if (!userId || !password) {
      setError('Invalid User ID or Password')
      return
    }
    setSubmitting(true)
    const res = await signIn(userId, password)
    setSubmitting(false)
    if (!res.ok) {
      if (res.reason === 'rate_limit') {
        setError(`Too many attempts. Try again in ${res.retryAfterMin || '60'} minutes.`)
      } else if (res.reason === 'backend_offline') {
        setError('Authentication service offline. Please try again shortly.')
      } else if (res.reason === 'network') {
        setError('Network error. Could not reach the server.')
      } else {
        setError('Invalid User ID or Password')
      }
      return
    }
    // Successful manual login → enrol this browser for quick-unlock in
    // the background so the next visit can use the abacus shortcut. We
    // don't await this; if it fails the operator just won't get the
    // shortcut and the regular form keeps working.
    registerDevice().catch(() => {})
    scheduleWelcomeVoice()
    try { sessionStorage.setItem('mm_welcome_pending', '1') } catch (_) {}
    navigate(returnTo, { replace: true })
  }

  async function onSubmit(e) {
    e.preventDefault()
    await doLogin()
  }

  // Hidden abacus sequence completed → exchange the device token stored
  // at first manual login for a fresh session. No password ever ships in
  // the JS bundle: this path only works after the operator has enrolled
  // this browser via /auth/device-register, and the raw token lives only
  // in localStorage on the device that owns it.
  async function handleSecretUnlock() {
    if (submitting) return
    setError(null)
    if (!BACKEND_CONFIGURED) {
      setError('Backend not connected. Configure VITE_API_BASE / VITE_AUTH_API in Vercel and redeploy.')
      return
    }
    if (!hasDeviceToken()) {
      // No enrolment yet — surface the hint instead of pretending to log
      // in. The bead burst still played; the operator now knows why.
      setError('Complete one manual login to enable quick unlock.')
      return
    }
    setSubmitting(true)
    const res = await unlockWithDevice()
    setSubmitting(false)
    if (!res.ok) {
      if (res.reason === 'rate_limit') {
        setError(`Too many attempts. Try again in ${res.retryAfterMin || '60'} minutes.`)
      } else if (res.reason === 'invalid_device_token') {
        setError('Quick unlock expired. Please log in manually to re-enable it.')
      } else if (res.reason === 'backend_offline') {
        setError('Authentication service offline. Please try again shortly.')
      } else if (res.reason === 'network') {
        setError('Network error. Could not reach the server.')
      } else {
        setError('Quick unlock failed.')
      }
      return
    }
    scheduleWelcomeVoice()
    try { sessionStorage.setItem('mm_welcome_pending', '1') } catch (_) {}
    navigate(returnTo, { replace: true })
  }

  function onResetSuccess() {
    setPassword('')
    setToast('Workspace password updated successfully.')
    setTimeout(() => setToast(null), 3600)
  }

  return (
    <div className="login-page">
      <aside className="login-left">
        <div className="login-scene" aria-hidden="true">
          <div className="login-scene-light" />
          <div className="login-scene-blob login-scene-blob-a" />
          <div className="login-scene-blob login-scene-blob-b" />
          <div className="login-scene-grain" />
          <div className="login-particles">
            <span className="login-particle login-particle-1" />
            <span className="login-particle login-particle-2" />
            <span className="login-particle login-particle-3" />
          </div>
        </div>

        <header className="login-brand">
          <div className="login-brand-mark">
            <img src="/mastermind-logo.jpg" alt="" className="login-brand-img" />
          </div>
          <div className="login-brand-text">
            <div className="login-brand-name">Mastermind Abacus</div>
            <div className="login-brand-tag">Automation Studio</div>
          </div>
        </header>

        <div className="login-stage">
          <Abacus onUnlock={handleSecretUnlock} />
          {!hasDevice && (
            <p className="login-quick-unlock-hint" aria-live="polite">
              Complete one manual login to enable quick unlock.
            </p>
          )}
        </div>

        <div className="login-hero">
          <h1 className="login-headline">
            <span className="login-headline-top">Smarter Automation.</span><br/>
            <span className="login-headline-accent">Seamless Operations.</span>
          </h1>
          <p className="login-sub">
            Manage campaigns, personalise communication, and streamline
            internal workflows from one intelligent automation workspace.
          </p>
        </div>
      </aside>

      <main className="login-right">
        <div className="login-right-deco login-right-deco-tr" aria-hidden="true" />
        <div className="login-right-deco login-right-deco-br" aria-hidden="true" />

        <form className="login-card" onSubmit={onSubmit} noValidate>
          <h2 className="login-card-title">Automation Workspace</h2>
          <p className="login-card-sub">
            Secure access to the Mastermind Abacus automation platform.
          </p>

          <div className="login-form">
            <div className="login-field">
              <label className="login-label" htmlFor="login-userid">User ID</label>
              <div className="login-control">
                <span className="login-control-icon"><IconUser /></span>
                <input
                  id="login-userid"
                  type="text"
                  autoComplete="username"
                  className="login-input"
                  placeholder="Enter your User ID"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="login-field">
              <label className="login-label" htmlFor="login-pw">Password</label>
              <div className="login-control">
                <span className="login-control-icon"><IconLock /></span>
                <input
                  id="login-pw"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  className="login-input login-input-with-suffix"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="login-control-suffix"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  <IconEye open={showPw} />
                </button>
              </div>
            </div>

            <button
              type="button"
              className="login-forgot-link login-forgot-link-center"
              onClick={() => setModalOpen(true)}
            >Forgot password?</button>

            {error && <div className="login-error" role="alert">{error}</div>}

            <button type="submit" className="login-submit" disabled={submitting}>
              <span>{submitting ? 'Signing in…' : 'Access Workspace'}</span>
              <span className="login-submit-arrow" aria-hidden="true">→</span>
            </button>
          </div>

          <div className="login-card-foot">
            Trouble signing in? <span className="login-card-foot-strong">Contact your workspace admin</span>
          </div>
        </form>

        {toast && createPortal(
          <div className="reset-toast" role="status">
            <span className="reset-toast-dot" />
            {toast}
          </div>,
          document.body
        )}
      </main>

      <ResetModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSuccess={onResetSuccess}
      />
    </div>
  )
}
