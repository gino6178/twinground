// Mission tutorial (2026-11-15). One worked case from start to finish, game-style: each step points at the real control,
// says what it does, and waits for the visitor to use it (no "Next" button). Chapters: 1 choose the search settings,
// 2 read and compare the Earth matches, 3 field training in 3D, 4 a small final challenge that ends by leaving 3D.
// Case: the Marius Hills skylight on the Moon, searched as a lava-tube analog. The explorer reports what the astronaut
// does through 'twinground:eva' window events (astronaut_explorer.jsx).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, Rocket, Volume2, VolumeX, X } from 'lucide-react'
import './mission_tutorial.css'

const SEEN_KEY = 'twinground:mission-seen:v1'
const MARIUS = { lat: 14.0917, lon: -56.7701 }

// ---- Commander's radio ------------------------------------------------------------------------------------------
// One shared <audio> for the lines and one for the static bed. Phones only let an element play sound later if it was
// first played from a tap, so unlockVoice() runs inside the Game mode tap. The unlock clip must be a real, decodable
// file: a failed source leaves the element with paused === false forever, which used to park every line in the queue.
// The player keeps its own busy flag instead of trusting paused/ended, moves on after errors, and retries a line the
// browser refused (NotAllowedError) on the visitor's next tap or key press.
const SILENT_MP3 = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMgAAAAAAAAAAAAAA//OEwAAAAAAAAAAAAEluZm8AAAAPAAAABwAAA2AAVVVVVVVVVVVVVVVVVVVxcXFxcXFxcXFxcXFxcY6Ojo6Ojo6Ojo6Ojo6Oqqqqqqqqqqqqqqqqqqqqx8fHx8fHx8fHx8fHx8fj4+Pj4+Pj4+Pj4+Pj4///////////////////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQEIAAAAAAAAANgmVDIXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NExAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu//NExFMAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu//NExKYAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu//NExKwAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMu//NExKwAAANIAAAAADEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NExKwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NExKwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV'
// Lines recorded later carry a higher version so a stale cached copy is never served.
const VO_VERSION = { methods: 3, found: 3, foundlist: 3, agent: 3, agentread: 3, purpose: 3, scale: 3, card: 3, compare: 3, explore: 3, readscan: 3, map: 3, exit: 3 }
const voUrl = key => `/game/vo/${key}.mp3?v=${VO_VERSION[key] || 2}`
const radio = { voice: null, bed: null, queue: [], current: null, muted: false, bedOn: false, watchdog: 0, retryArmed: false }

function audioEls() {
  if (!radio.voice && typeof Audio !== 'undefined') {
    radio.voice = new Audio(); radio.voice.preload = 'auto'
    radio.bed = new Audio('/game/vo/static.mp3?v=2'); radio.bed.loop = true; radio.bed.preload = 'auto'
    const finished = () => { if (radio.current) lineOver() }
    radio.voice.addEventListener('ended', finished)
    radio.voice.addEventListener('error', finished)
  }
  return radio
}
function bedSync() {
  const { bed } = radio
  if (!bed || radio.unlocking) return  // pausing before the unlock play settles would abort it (and the unlock)
  // The lines carry their own static, so the bed pauses under them: one sound at a time also suits iOS.
  if (radio.bedOn && !radio.muted && !radio.current) bed.play().catch(() => {}); else bed.pause()
}
function lineOver() {
  window.clearTimeout(radio.watchdog)
  radio.current = null
  bedSync()
  pump()
}
function armRetry() {
  if (radio.retryArmed) return
  radio.retryArmed = true
  const again = () => {
    radio.retryArmed = false
    window.removeEventListener('pointerdown', again, true); window.removeEventListener('keydown', again, true)
    pump()  // inside the gesture, so the browser allows it
    bedSync()
  }
  window.addEventListener('pointerdown', again, true); window.addEventListener('keydown', again, true)
}
function pump() {
  const { voice } = audioEls()
  if (!voice || radio.current || radio.muted || !radio.queue.length) return
  const now = Date.now()
  radio.queue = radio.queue.filter(q => now - q.t < 4000)  // a line that waited too long is stale
  if (!radio.queue.length) return
  const key = radio.queue.shift().key
  radio.current = key
  bedSync()
  voice.src = voUrl(key)
  window.clearTimeout(radio.watchdog)
  radio.watchdog = window.setTimeout(() => { if (radio.current === key) { voice.pause(); lineOver() } }, 15000)
  voice.play().catch(err => {
    if (radio.current !== key) return  // muted or replaced meanwhile
    window.clearTimeout(radio.watchdog)
    radio.current = null
    if (err?.name === 'NotAllowedError') { radio.queue.unshift({ key, t: Date.now() }); armRetry(); bedSync(); return }
    lineOver()  // unplayable file: skip it
  })
}
function say(key) {
  if (radio.muted) return
  radio.queue = [...radio.queue, { key, t: Date.now() }].slice(-2)  // at most two waiting; stale ones drop in pump()
  pump()
}
function setRadioMuted(m) {
  radio.muted = m
  if (m) { radio.queue = []; if (radio.current) { radio.current = null; window.clearTimeout(radio.watchdog); radio.voice?.pause() } }
  bedSync()
}
function setBed(on) { radio.bedOn = on; bedSync() }
function silenceRadio() { radio.queue = []; radio.current = null; window.clearTimeout(radio.watchdog); radio.voice?.pause(); setBed(false) }

// ---- One sound switch for all of Game mode -------------------------------------------------------------------------
// The Mission Start screen, the briefing/debrief video bar and the mission cards share it; the choice is remembered.
const SOUND_KEY = 'twinground:game-sound:v1'
let soundOn = true
try { soundOn = window.localStorage.getItem(SOUND_KEY) !== 'off' } catch { /* default on */ }
radio.muted = !soundOn
const soundSubs = new Set()
export function setGameSound(on) {
  soundOn = on
  try { window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off') } catch { /* still works for this visit */ }
  setRadioMuted(!on)
  if (on) unlockVoice()  // called from the tap on the toggle, so phones allow the sound that follows
  soundSubs.forEach(f => f(on))
}
export function useGameSound() {
  const [on, set] = useState(soundOn)
  useEffect(() => { soundSubs.add(set); set(soundOn); return () => { soundSubs.delete(set) } }, [])
  return [on, setGameSound]
}
export function SoundToggle({ className = 'mt-quit' }) {
  const [on, toggle] = useGameSound()
  return <button type="button" className={className} onClick={() => toggle(!on)} aria-pressed={on} aria-label={on ? 'Sound on' : 'Sound off'} title={on ? 'Sound on' : 'Sound off'}>
    {on ? <Volume2 size={20} aria-hidden="true" /> : <VolumeX size={20} aria-hidden="true" />}</button>
}

export function unlockVoice() {
  const { voice, bed } = audioEls()
  if (!voice) return
  if (!radio.current) { voice.src = SILENT_MP3; voice.play().catch(() => {}) }
  radio.unlocking = true
  bed.muted = radio.muted  // sound off: unlock without a burst of static; turning it on later unlocks again in that tap
  const settle = () => { radio.unlocking = false; bed.muted = false; bedSync() }
  bed.play().then(settle, settle)
}

// ---- The mission ---------------------------------------------------------------------------------------------------
const CHAPTERS = { 1: 'Choose', 2: 'Compare', 3: 'Field training', 4: 'Final challenge' }
const in3D = s => s.ch === 3 || s.ch === 4
const touch = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches
const phone = () => window.innerWidth <= 640
// The words for this device: touch help instead of keys, and a one-line version on phones.
const textOf = s => (touch() && s.touchText) || (phone() && s.short) || s.text
// The comparison panels stack on narrow screens: then the words say top and bottom, not left and right.
const stacked = () => {
  const [a, b] = document.querySelectorAll('.terrain-pair .terrain-panel')
  return !!(a && b && b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom - 4)
}
// kind: page = spotlight on the page; drill = 3D task in the side card; point = spotlight on a 3D control.
// click: a click inside this completes the step. Other steps complete on explorer events (see onEva below).
const STEPS = [
  { id: 'purpose', ch: 1, kind: 'page', target: '.purpose-tiles .sel-tile:nth-child(7)', click: '.purpose-tiles .sel-tile:nth-child(7)', act: 'choose Lava tubes',
    title: 'What is the analog for?', text: 'The search purpose decides how Earth is ranked. A shelter needs a lava tube, so tap Lava tubes.' },
  { id: 'scale', ch: 1, kind: 'page', target: '.scale-picker button.active', click: '.scale-picker button', act: 'keep this size',
    title: 'Set the window size', text: 'This is the side of the square you compare, in kilometres. Large windows match whole landscapes, small ones local shapes. Tap a size; the lit one fits the skylight.' },
  { id: 'search', ch: 1, kind: 'page', target: '.search-button', act: 'search Earth',
    title: 'Search Earth', text: 'Search Earth for places shaped like the Marius Hills skylight.' },
  // Search Candidates is a separate page (public/offcatalogue): the mission shows it in a frame so the mission goes on.
  { id: 'found', ch: 2, kind: 'card', act: 'open Search Candidates',
    title: 'Already found', text: 'Look: the system has already scanned all of Earth for places like the Moon and Mars. They live under Search Candidates in the top menu. Let’s take a look.' },
  { id: 'foundlist', ch: 2, kind: 'page', target: { frame: '.mt-frame iframe', sel: 'section.cand', text: 'Marius Hills', child: 'dl > div' }, act: 'back to our search',
    title: 'One for our skylight', text: '“Found for” names the Moon or Mars site, its rank and score. Tags show what matches and, struck through, what does not. Explore in 3D walks it; we will walk our own match next.', short: '“Found for” names the Moon site, rank and score; the tags show what matches.',
    scrollTo: { frame: '.mt-frame iframe', sel: 'section.cand', text: 'Marius Hills' },
    avoid: ['h3', 'dl > div:nth-child(2)', 'dl > div:nth-child(3)', 'a.go'].map(child => ({ frame: '.mt-frame iframe', sel: 'section.cand', text: 'Marius Hills', child })) },
  { id: 'methods', ch: 2, kind: 'card', act: 'got it',
    title: 'How does it find them?', text: 'Methods, in the top menu, explains it: Moon, Mars and Earth windows are put in the same physical units, Earth places are ranked by measured terrain and properties, and it shows what Earth cannot reproduce.' },
  { id: 'card', ch: 2, kind: 'page', target: '.glance-cards .glance-card:first-child .glance-card-actions .outline-button', click: '.glance-card-actions .outline-button', act: 'open 3D compare',
    scrollTo: '.glance-cards .glance-card:first-child', avoid: ['.glance-cards .glance-card:first-child'],
    title: 'Read the top match', text: 'Card #1 is the Earth place most like the skylight. The Terrain bar is its match score out of 100, and the lines below say what agrees. Tap 3D compare.' },
  // The agent (assistant_widget.jsx): the mission opens it with a question typed in; the reply completes the step.
  { id: 'agent', ch: 2, kind: 'page', target: '.aw-panel', inPanel: true, act: 'ask the agent',
    title: 'Ask the Agent', text: 'Our agent is a small language model that answers from our paper and the site’s data, with sources. It reads the candidate you are viewing, explains why it ranked here and compares sites. Send this question, or type your own.', short: 'A small language model that answers from our paper and this site’s data, with sources. Send the question.' },
  { id: 'agentread', ch: 2, kind: 'page', target: '.aw-log > .aw-turn.is-bot:not(.is-busy):last-child', inPanel: true, gone: true, act: 'close the agent',
    title: 'Check its sources', text: 'Tags in brackets show where each claim comes from: this candidate’s data on the page, or a passage from our paper. The list under the answer shows what it read. Close the panel when you are done.', short: 'Tags in brackets show the source of each claim; the list under the answer shows what it read.' },
  { id: 'compare', ch: 2, kind: 'page', target: '.comparison-switch button:not(.active)', click: '.comparison-switch button', act: 'switch the view',
    avoid: ['.terrain-pair'],
    title: 'Moon and Earth side by side', text: 'Left: the skylight. Right: the Earth match, at the same vertical scale; drag either to turn it. This switch flips between bare terrain and real imagery.',
    stackedText: 'Top: the skylight. Below it: the Earth match, at the same vertical scale; drag either to turn it. This switch flips between bare terrain and real imagery.' },
  { id: 'explore', ch: 2, kind: 'page', target: ['.terrain-pair .terrain-panel:last-child .terrain-explore-button', '.glance-explore'], act: 'explore on foot',
    title: 'Walk it', text: 'Step onto the Earth match as an astronaut.' },
  { id: 'walk', ch: 3, kind: 'drill', keys: 'W A S D', task: 'Walk 20 metres', text: 'Hold W to walk forward; A and D turn, S steps back. On a phone, use the joystick.', touchText: 'Push the joystick to walk. Give me 20 metres.' },
  { id: 'run', ch: 3, kind: 'drill', keys: 'Shift', task: 'Run', text: 'Hold Shift while you walk, or tap Run. On the Moon and Mars this becomes a low-gravity lope.', touchText: 'Tap Run, then push the joystick.' },
  { id: 'jump', ch: 3, kind: 'drill', keys: 'Space', task: 'Jump', text: 'Press Space, or tap Jump. Gravity here decides how high you go.', touchText: 'Tap Jump. Gravity here decides how high you go.' },
  { id: 'scan', ch: 3, kind: 'drill', keys: 'C', task: 'Scan the ground', text: 'Press C, or tap Scan. The scan reads this spot and the same spot in the other world.', touchText: 'Tap Scan. It reads this spot and the same spot in the other world.' },
  { id: 'readscan', ch: 3, kind: 'point', target: '.eva-scan', gone: true, task: 'Read the scan', act: 'close the scan',
    title: 'Read the scan', text: 'Each row puts this spot next to the same spot on the Moon: elevation, slope, roughness, even bootprint depth. Close it when you are done.', short: 'Each row compares this spot with the same spot on the Moon. Close it when done.' },
  { id: 'flag', ch: 3, kind: 'drill', keys: 'F', task: 'Plant a flag', text: 'Press F, or tap Flag, to mark where you stand.', touchText: 'Tap Flag to mark where you stand.' },
  { id: 'map', ch: 3, kind: 'point', target: '.eva-map canvas', task: 'Travel with the minimap', act: 'travel there',
    title: 'Use the minimap', text: 'North is up and the dot is you. Tap anywhere on the map to travel there at once.', short: 'North is up, the dot is you. Tap the map to travel there.' },
  { id: 'switch', ch: 4, kind: 'point', target: '.eva-switch', keys: 'T', task: 'Cross to the other world', act: 'cross over',
    title: 'Cross to the other world', text: 'Press T or this button. You arrive at the same position in the other window.', touchText: 'Tap this button. You arrive at the same position in the other window.' },
  { id: 'flag2', ch: 4, kind: 'drill', keys: 'F', task: 'Plant a flag there', text: 'Mark the matching spot. You know the key.', touchText: 'Mark the matching spot: tap Flag.' },
  { id: 'scan2', ch: 4, kind: 'drill', keys: 'C', task: 'Scan it', text: 'Compare the ground in both worlds right here.', touchText: 'Tap Scan to compare the ground in both worlds here.' },
  { id: 'exit', ch: 4, kind: 'point', target: '.eva-back', keys: 'Esc', task: 'Leave the 3D view', act: 'exit 3D',
    title: 'Head home', text: 'Field test passed. Press Exit, top left, or Esc, to leave the 3D view.', touchText: 'Field test passed. Tap Exit, top left, to leave the 3D view.' },
]
const LEARNED = [
  ['Set the purpose and window size', ''], ['Search Earth and read the match cards', ''], ['Browse the sites already found', ''], ['Find the Methods behind it', ''], ['Ask the Agent and check its sources', ''],
  ['Compare Moon and Earth in 3D', ''],
  ['Walk, run and jump', 'W A S D · Shift · Space'], ['Scan the ground and read it', 'C'], ['Plant flags', 'F'],
  ['Travel with the minimap', ''], ['Cross worlds and exit', 'T · Esc'],
]
// A target is a selector, a list of selectors tried in order, or { frame, sel, text, child }: an element inside a
// same-origin iframe (the Search Candidates page), found by its text, measured on the outer page.
function locate(sel) {
  for (const s of [].concat(sel || [])) {
    if (typeof s === 'string') {
      const el = [...document.querySelectorAll(s)].find(e => e.getClientRects().length)
      if (el) { const r = el.getBoundingClientRect(); return { el, rect: { top: r.top, left: r.left, width: r.width, height: r.height } } }
      continue
    }
    const f = document.querySelector(s.frame)
    let doc = null
    try { doc = f?.contentDocument } catch { /* not same-origin */ }
    if (!doc) continue
    let el = [...doc.querySelectorAll(s.sel)].find(e => !s.text || e.textContent.includes(s.text))
    if (el && s.child) el = el.querySelector(s.child) || el
    if (!el) continue
    const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect()
    const top = Math.max(fr.top, fr.top + r.top), bottom = Math.min(fr.bottom, fr.top + r.bottom)
    return { el, framed: true, rect: bottom - top > 4 ? { top, left: fr.left + r.left, width: r.width, height: bottom - top } : null }
  }
  return null
}
const visibleEl = sel => locate(sel)?.el || null

// Follow the element to press: its box on screen, whether it is disabled, and scroll it into view once.
// The bottom of any bar stuck to the top of the window (site header, results bar), so a target is not scrolled under it.
function stickyBottom() {
  let b = 0
  for (const el of document.querySelectorAll('header, nav, [class*="nav"], [class*="bar"]')) {
    const cs = getComputedStyle(el)
    if (cs.position !== 'sticky' && cs.position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.top <= 2 && r.height > 0 && r.height < window.innerHeight / 3 && r.bottom > b) b = r.bottom
  }
  return b
}
function useTargetRect(selector, scrollSel) {
  const [rect, setRect] = useState(null)
  const key = selector ? JSON.stringify(selector) : ''
  useEffect(() => {
    if (!key) { setRect(null); return undefined }
    let frame, settle, tries = 0
    // Once, after the page change has settled (repeated scrolling fought the page's own scroll-to-top); a target in
    // an iframe is retried until the frame has loaded.
    const scrollOnce = () => {
      const hit = locate(scrollSel || selector)
      if (!hit) { if (++tries < 20) settle = window.setTimeout(scrollOnce, 300); return }
      if (hit.framed) { hit.el.scrollIntoView({ block: 'start' }); return }
      if (hit.el.closest('.eva, .aw-panel, .mt-frame')) return
      // The whole box below any sticky bar: centred in the space left, or top-aligned when it is taller than that.
      const r = hit.el.getBoundingClientRect(), top = stickyBottom() + 12, room = window.innerHeight - top - 10
      if (r.top < top || r.bottom > window.innerHeight - 10) window.scrollBy({ top: r.top - top - (r.height < room ? (room - r.height) / 2 : 0) })
    }
    settle = window.setTimeout(scrollOnce, 700)
    const tick = () => {
      const hit = locate(selector)
      const r = hit?.rect
      const disabled = !!hit?.el?.disabled
      setRect(prev => (!r ? null : prev && prev.disabled === disabled && Math.abs(prev.top - r.top) < 1 && Math.abs(prev.left - r.left) < 1 && Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1 ? prev
        : { ...r, disabled }))
    }
    // Animation frames keep the frame glued to the element while scrolling; the timer keeps state right when the
    // browser pauses frames (background tab, low-power mode), so the callout never sticks on "Loading…".
    const loop = () => { tick(); frame = requestAnimationFrame(loop) }
    loop()
    const timer = window.setInterval(tick, 250)
    return () => { cancelAnimationFrame(frame); window.clearInterval(timer); window.clearTimeout(settle) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return rect
}

function Head({ ch, muted, onMute, onQuit }) {
  return <header><span className="mt-kicker">Step {ch} of 4 · {CHAPTERS[ch]}</span>
    <span className="mt-head-tools">
      <button type="button" className="mt-quit" onClick={onMute} aria-pressed={!muted} aria-label={muted ? 'Turn the commander’s voice on' : 'Mute the commander’s voice'}>
        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
      <button type="button" className="mt-quit" onClick={onQuit} aria-label="Leave the mission"><X size={18} /></button></span></header>
}

// Callout placement: next to the target when that spot is free (with an arrow at it), otherwise the free spot nearest
// to it. "Free" means on screen and clear of the target and of every rect in avoid (the explorer's buttons, the scan
// result, the agent's header and input, the panels a step talks about). Measured on every render, nothing assumed.
function placeCallout(rect, avoid, w0, h0, coverTarget) {
  const W = window.innerWidth, H = window.innerHeight, gap = 22, pad = 12
  const boxes = coverTarget ? avoid : [rect, ...avoid]
  const hit = c => boxes.reduce((a, b) => a + Math.max(0, Math.min(c.x + c.w, b.left + b.width) - Math.max(c.x, b.left)) * Math.max(0, Math.min(c.y + c.h, b.top + b.height) - Math.max(c.y, b.top)), 0)
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
  const near = [], free = []
  for (const w of [...new Set([w0, Math.round(Math.min(w0, Math.max(220, W * 0.6)))])]) {
    const h = heightAt(h0, w0, w)
    const x = Math.max(pad, Math.min(W - w - pad, cx - w / 2))
    const yMid = Math.max(pad, Math.min(H - h - pad, cy - h / 2))
    near.push({ mode: 'below', x, y: rect.top + rect.height + gap, w, h }, { mode: 'above', x, y: rect.top - gap - h, w, h },
      { mode: 'side', x: rect.left + rect.width + gap, y: yMid, w, h }, { mode: 'side', x: rect.left - gap - w, y: yMid, w, h })
    for (const fx of [x, pad, W - w - pad]) for (let y = pad; y <= H - h - pad; y += 16) free.push({ mode: 'free', x: fx, y, w, h })
  }
  const fits = c => c.x >= pad - 1 && c.x + c.w <= W - pad + 1 && c.y >= pad - 1 && c.y + c.h <= H - pad + 1
  const dist = c => Math.hypot(c.x + c.w / 2 - cx, c.y + c.h / 2 - cy)
  const ok = [...near, ...free.sort((a, b) => dist(a) - dist(b))].filter(fits)
  return ok.find(c => hit(c) < 1)
    || ok.reduce((best, c) => (!best || hit(c) < hit(best) ? c : best), null)
    || { mode: 'free', x: pad, y: pad, w: w0, h: heightAt(h0, w0, w0) }
}
// Callout height at width w: measured at that width when known, else scaled from a known one (text reflows).
function heightAt(heights, w0, w) {
  if (heights[w]) return heights[w]
  const [kw, kh] = Object.entries(heights).map(([k, v]) => [Number(k), v])[0] || [w0, 240]
  return Math.round(kh * kw / w)
}
function Callout({ rect, avoid, coverTarget, ch, title, text, action, onAct, waiting, muted, onMute, onQuit }) {
  const ref = useRef(null)
  // Measured heights by width. A single height stored without its width looped: the narrow placement measured taller,
  // which was read as the wide height and scaled up again, so placement flipped wide/narrow on every layout and React
  // stopped it with error #185 (seen on iPhone Safari's short viewport, at the agent step).
  const [heights, setHeights] = useState({})
  const [, setTick] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current, n = el?.offsetHeight, w = Math.round(el?.offsetWidth || 0)
    if (n && w && !(Math.abs((heights[w] || 0) - n) <= 2)) setHeights(prev => ({ ...prev, [w]: n }))
  })
  // The text changes between steps: start measuring again.
  useEffect(() => { setHeights({}) }, [title, text])
  // Panels can open or move around the callout without the target moving (a scan result, the agent's answer).
  useEffect(() => { const id = window.setInterval(() => setTick(t => t + 1), 500); return () => window.clearInterval(id) }, [])
  const w0 = Math.min(400, window.innerWidth - 24)
  const at = placeCallout(rect, avoid(), w0, heights, coverTarget)
  const arrowX = Math.max(24, Math.min(at.w - 24, rect.left + rect.width / 2 - at.x))
  return <section ref={ref} className={`mt-callout is-${at.mode}`} style={{ top: at.y, left: at.x, width: at.w, '--arrow-x': `${arrowX}px` }} aria-live="polite" aria-label="Mission objective">
    <Head ch={ch} muted={muted} onMute={onMute} onQuit={onQuit} />
    <h2>{title}</h2>
    <p>{text}</p>
    {action && <NextButton waiting={rect.disabled || waiting} detail={action} onClick={onAct} />}
  </section>
}

// Every mission action reads as "Next", with what it does as a short second part.
function NextButton({ waiting, detail, onClick, label = 'Next' }) {
  return <button type="button" className="mt-act" disabled={waiting} onClick={onClick}>
    <span className="mt-act-main">{waiting ? 'Waiting…' : label}</span>
    {detail && !waiting && <span className="mt-act-sub">· {detail}</span>}
    <ArrowRight size={20} aria-hidden="true" />
  </button>
}

// The commander's briefing: full-screen video with sound, large captions, Skip. Autoplay with sound is allowed because
// it starts from the visitor's click; if the browser still blocks it, a Play button appears.
// Also the mission-complete debrief (outro): same player, its own files; a video that fails to load is skipped.
const VIDEOS = {
  intro: { src: '/game/intro.mp4?v=5', vtt: '/game/intro.en.vtt?v=5', name: 'briefing', label: 'Mission briefing video' },
  outro: { src: '/game/outro.mp4?v=3', vtt: '/game/outro.en.vtt?v=3', name: 'debrief', label: 'Mission debrief video' },
}
function IntroVideo({ onDone, onQuit, kind = 'intro' }) {
  const v = VIDEOS[kind]
  const [soundIsOn] = useGameSound()
  const muted = !soundIsOn
  useEffect(() => { if (video.current) video.current.muted = muted }, [muted])  // the attribute alone is not live in every browser
  const video = useRef(null)
  const track = useRef(null)
  const [blocked, setBlocked] = useState(false)
  // Captions are drawn by the page, not the browser: native cues do not wrap reliably on phones (iOS runs long lines
  // off the screen), so the track stays hidden and its active cues go into a wrapping box.
  const [caption, setCaption] = useState('')
  useEffect(() => {
    const t = track.current?.track
    if (!t) return undefined
    t.mode = 'hidden'
    const show = () => setCaption([...(t.activeCues || [])].map(c => c.text.replace(/<[^>]+>/g, '')).join('\n'))
    t.addEventListener('cuechange', show)
    return () => t.removeEventListener('cuechange', show)
  }, [])
  useEffect(() => {
    video.current?.play().catch(() => setBlocked(true))
    const esc = e => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(<div className="mt-intro" role="dialog" aria-modal="true" aria-label={v.label}>
    <video ref={video} src={v.src} playsInline preload="auto" muted={muted} onEnded={onDone} onError={onDone} crossOrigin="anonymous">
      <track ref={track} kind="captions" src={v.vtt} srcLang="en" label="English" />
    </video>
    {caption && <p className="mt-cap" aria-live="off">{caption}</p>}
    {blocked && <button type="button" className="mt-intro-play" onClick={() => { setBlocked(false); video.current?.play() }}>Play {v.name}</button>}
    <div className="mt-intro-bar">
      <SoundToggle className="mt-secondary mt-sound" />
      {onQuit && <button type="button" className="mt-secondary" onClick={onQuit}>Exit</button>}
      <button type="button" className="mt-primary" onClick={() => { unlockVoice(); onDone() }} autoFocus>Skip {v.name}</button>
    </div>
  </div>, document.body)
}

export function MissionTutorial({ stage, runId, autoStart, onBegin, onPurpose, onFinish }) {
  // phase: off | intro | brief | run | outro | done
  const [phase, setPhase] = useState('off')
  const [done, setDone] = useState({})
  const [inEva, setInEva] = useState(false)
  const [evaEl, setEvaEl] = useState(null)
  const [soundIsOn] = useGameSound()
  const muted = !soundIsOn
  const [frameUrl, setFrameUrl] = useState(null)  // Search Candidates, shown in a frame during chapter 5
  const [methodsOpen, setMethodsOpen] = useState(false)
  const [searching, setSearching] = useState(false)  // Search pressed: a disabled button now means "searching", not "loading"
  const [chosen, setChosen] = useState(null)       // a candidate picked there to explore after the mission
  const spoken = useRef(new Set())

  const finish = () => setPhase('off')
  const mark = (...ids) => setDone(d => (ids.every(id => d[id]) ? d : { ...d, ...Object.fromEntries(ids.map(id => [id, true])) }))
  const unmark = (...ids) => setDone(d => (ids.some(id => d[id]) ? { ...d, ...Object.fromEntries(ids.map(id => [id, false])) } : d))

  // Briefing on the first visit when autoStart is on; Game mode (landing button, Help > Mission) opens with the video.
  useEffect(() => {
    if (!autoStart) return
    let seen = false
    try { seen = !!window.localStorage.getItem(SEEN_KEY) } catch { /* show it */ }
    if (!seen) setPhase('brief')
  }, [autoStart])
  useEffect(() => { if (runId) { setDone({}); setPhase('intro') } }, [runId])
  const begin = () => { spoken.current = new Set(); setDone({}); setFrameUrl(null); setChosen(null); setPhase('run'); onBegin?.(MARIUS) }
  useEffect(() => { if (phase !== 'off') try { window.localStorage.setItem(SEEN_KEY, '1') } catch { /* fine */ } }, [phase])

  const cur = phase === 'run' ? STEPS.find(s => !done[s.id]) || null : null
  useEffect(() => { if (phase === 'run' && !cur) setPhase('outro') }, [phase, cur])
  const curRef = useRef(cur); curRef.current = cur
  useEffect(() => { if (cur?.id !== 'search') setSearching(false) }, [cur?.id])

  // Page progress follows the page: results arriving finish chapter 1; going back to the selection reopens the search.
  useEffect(() => {
    if (!cur || inEva) return
    if (cur.ch === 1 && stage === 2) mark('purpose', 'scale', 'search')
    if (cur.ch === 2 && stage !== 2) unmark('search')
  }, [cur?.id, stage, inEva]) // eslint-disable-line react-hooks/exhaustive-deps

  // A click on the control a step points at completes it.
  useEffect(() => {
    const onClick = e => {
      const s = curRef.current
      // The Search Candidates link would leave the app (and the mission): open it in the mission's frame instead.
      const link = s?.id === 'found' && e.target instanceof Element && e.target.closest('a[href*="offcatalogue"]')
      if (link) { e.preventDefault(); setFrameUrl(link.getAttribute('href')); mark('found'); return }
      if (s?.id === 'search' && e.target instanceof Element && e.target.closest('.search-button')) setSearching(true)
      if (s?.click && e.target instanceof Element && e.target.closest(s.click)) {
        mark(s.id)
        if (s.id === 'purpose') onPurpose?.('lavatube')
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The explorer's events drive the 3D steps. Each step is checked against the readout when it became current.
  const base = useRef({ id: null, s: null })
  useEffect(() => {
    const onEva = e => {
      const { type, stats: s, name } = e.detail || {}
      const c = curRef.current
      if (type === 'open') {
        setInEva(true); setEvaEl(document.querySelector('.eva'))
        if (c && c.ch <= 2) mark(...STEPS.filter(t => t.ch <= 2).map(t => t.id))
        return
      }
      if (type === 'close') {
        setInEva(false); setEvaEl(null)
        if (c?.id === 'exit') mark('exit')       // the last step: the done card follows
        else if (c && in3D(c)) unmark('explore')  // left early: point back at the way in, progress kept
        return
      }
      if (!c || !in3D(c)) return
      if (type === 'action') {
        if (name === 'scan' && (c.id === 'scan' || c.id === 'scan2')) mark(c.id)
        if (name === 'teleport' && c.id === 'map') mark('map')
        return
      }
      if (type !== 'stats' || !s?.ready) return
      if (base.current.id !== c.id) { base.current = { id: c.id, s }; return }
      const b = base.current.s
      if (c.id === 'walk' && s.distance - b.distance >= 20) mark('walk')
      // An Earth jump peaks near 0.25 m (JUMP_SPEED 2.2 m/s), so any clear lift-off counts.
      if (c.id === 'run' && s.run && s.speed > 1) mark('run')
      if (c.id === 'jump' && !s.grounded && s.altitude > 0.1) mark('jump')
      if ((c.id === 'flag' || c.id === 'flag2') && s.flags > b.flags) mark(c.id)
      if (c.id === 'switch' && s.world !== b.world && s.world !== 'rover') mark('switch')
    }
    window.addEventListener('twinground:eva', onEva)
    return () => window.removeEventListener('twinground:eva', onEva)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The explorer reads this to skip its controls card: the mission already says what to press.
  useEffect(() => {
    window.__twMission = phase !== 'off' && phase !== 'done'
    document.body.classList.toggle('tw-mission', window.__twMission)
  }, [phase])

  // What to spotlight now.
  const landing = cur?.ch === 1 && stage === 0
  const pointing = cur && !landing && (cur.kind === 'page' ? !inEva && (cur.ch === 1 ? stage === 1 : stage === 2) : cur.kind === 'point' && inEva)
  const target = landing ? '.landing-primary' : pointing ? cur.target : null
  const rect = useTargetRect(target, pointing ? cur.scrollTo : null)

  // The scan step completes when the panel it points at has been closed.
  const seen = useRef(null)
  useEffect(() => {
    if (!cur?.gone) return
    if (rect) seen.current = cur.id
    else if (seen.current === cur.id) mark(cur.id)
  }, [rect, cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // A target that never shows (a panel missing on this layout) must not stall the mission: offer Skip after a while.
  const [lost, setLost] = useState(false)
  useEffect(() => {
    setLost(false)
    if (!target || rect) return undefined
    const id = window.setTimeout(() => setLost(true), 3500)
    return () => window.clearTimeout(id)
  }, [target && String(target), !!rect]) // eslint-disable-line react-hooks/exhaustive-deps
  // Close a scan result left open once the mission has moved on, so it never covers the action buttons on a phone.
  useEffect(() => {
    if (!inEva || cur?.id !== 'flag') return undefined  // the final scan stays open while it is read
    const id = window.setTimeout(() => document.querySelector('.eva-scan header button')?.click(), 1500)
    return () => window.clearTimeout(id)
  }, [cur?.id, inEva])

  // In 3D the side card sits under the toolbar, which wraps to several rows on a phone: measure it rather than guess,
  // and tell the scan panel where the card ends so the two never overlap.
  useEffect(() => {
    if (!inEva) return undefined
    const root = document.documentElement
    const measure = () => {
      const bars = [...document.querySelectorAll('.eva-top .eva-lead, .eva-top .eva-tools')].map(e => e.getBoundingClientRect().bottom)
      const top = Math.round(Math.max(56, ...bars) + 10)
      const card = document.querySelector('.mt-objective.is-eva')?.getBoundingClientRect()
      root.style.setProperty('--mt-eva-top', `${top}px`)
      root.style.setProperty('--mt-card-bottom', `${Math.round(card ? card.bottom + 10 : top)}px`)
      // The scan panel stops above whatever sits under it (action bar, minimap, joystick), whichever layout is used.
      // On a phone a column of action buttons down the right edge narrows the scan panel; the floor then comes only from
      // what really sits under the panel (overlapping it by more than a few pixels), so it is not squeezed.
      const W = window.innerWidth, acts = document.querySelector('.eva-actions')?.getBoundingClientRect()
      const column = acts && acts.height > acts.width && acts.left > W / 2
      const right = W <= 640 ? (column ? Math.round(W - acts.left + 8) : 10) : 16
      root.style.setProperty('--mt-scan-right', `${right}px`)
      const x0 = W <= 640 ? 10 : (document.querySelector('.eva-scan')?.getBoundingClientRect().left ?? 0), x1 = W - right
      const floor = Math.min(window.innerHeight - 16, ...[...document.querySelectorAll('.eva-actions, .eva-map, .eva-joystick')]
        .map(e => e.getBoundingClientRect()).filter(r => r.height && Math.min(r.right, x1) - Math.max(r.left, x0) > 8).map(r => r.top - 10))
      root.style.setProperty('--mt-scan-floor', `${Math.round(floor)}px`)
    }
    measure()
    const timer = window.setInterval(measure, 300)
    window.addEventListener('resize', measure)
    return () => { window.clearInterval(timer); window.removeEventListener('resize', measure) }
  }, [inEva])

  // The agent step: open the chat with a question typed in, then follow the chat's own events. An answer (or an error)
  // completes it; after 25 s without one, the button turns into "Next · skip" so the mission never stalls.
  const AGENT_Q = 'Why is this site a good analog for the Marius Hills skylight?'
  const prefilled = useRef(false)
  const askAgent = () => window.dispatchEvent(new CustomEvent('twinground:assistant', { detail: { type: 'prefill', text: AGENT_Q } }))
  useEffect(() => { if (phase !== 'run') prefilled.current = false }, [phase])
  useEffect(() => {
    if (cur?.id !== 'agent' || !pointing || prefilled.current) return undefined
    const id = window.setTimeout(() => { prefilled.current = true; askAgent() }, 600)
    return () => window.clearTimeout(id)
  }, [cur?.id, pointing]) // eslint-disable-line react-hooks/exhaustive-deps
  const [agentWait, setAgentWait] = useState(null)  // null | 'busy' | 'slow'
  useEffect(() => { setAgentWait(null) }, [cur?.id])
  useEffect(() => {
    let slow = 0
    const onAssistant = e => {
      const { type, ok } = e.detail || {}
      if (curRef.current?.id !== 'agent') return
      if (type === 'sent') { setAgentWait('busy'); window.clearTimeout(slow); slow = window.setTimeout(() => setAgentWait(w => (w === 'busy' ? 'slow' : w)), 25000) }
      if (type === 'reply') { window.clearTimeout(slow); if (ok) mark('agent'); else mark('agent', 'agentread') }
    }
    window.addEventListener('twinground:assistant', onAssistant)
    return () => { window.removeEventListener('twinground:assistant', onAssistant); window.clearTimeout(slow) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The commander's lines, each once per mission.
  const voiceKey = phase === 'done' ? 'done'
    : !cur || landing ? null
    : cur.id === 'search' ? (pointing && rect && !searching ? (rect.disabled ? 'loading' : 'search') : null)
    : in3D(cur) !== inEva ? null
    : cur.id
  useEffect(() => {
    if (!voiceKey || muted || spoken.current.has(voiceKey)) return
    spoken.current.add(voiceKey)
    say(voiceKey)
  }, [voiceKey, muted]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRadioMuted(muted) }, [muted])
  useEffect(() => { if (phase === 'off' || phase === 'outro') silenceRadio() }, [phase])  // the debrief has its own sound
  // Quiet radio static under the whole tutorial (not during the intro video, which has its own sound).
  useEffect(() => { setBed(phase === 'run') }, [phase])
  useEffect(() => () => silenceRadio(), [])

  const act = () => {
    const el = visibleEl(target)
    if (cur?.id === 'agent') {
      if (agentWait === 'slow') mark('agent', 'agentread')
      else window.dispatchEvent(new CustomEvent('twinground:assistant', { detail: { type: 'send', text: el?.querySelector('textarea')?.value.trim() ? '' : AGENT_Q } }))
      return
    }
    if (cur?.id === 'found') { setFrameUrl(document.querySelector('a[href*="offcatalogue"]')?.getAttribute('href') || '/offcatalogue/en.html'); mark('found'); return }
    if (cur?.id === 'foundlist') { mark('foundlist'); return }
    if (cur?.id === 'methods') { setMethodsOpen(false); mark('methods'); return }
    if (cur?.id === 'agentread') { document.querySelector('.aw-panel header .aw-actions button:last-child')?.click(); return }
    if (!el || el.disabled) return
    if (cur?.id === 'readscan') { el.querySelector('header button')?.click(); return }
    if (cur?.id === 'map') {
      // A tap a third of the way in from the top-left corner: a real move away from where the astronaut stands.
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.3 }))
      return
    }
    el.click()
  }
  const onMute = () => setGameSound(muted)

  if (phase === 'off') return null
  if (phase === 'intro') return <IntroVideo onDone={begin} onQuit={finish} />
  if (phase === 'outro') return <IntroVideo kind="outro" onDone={() => setPhase('done')} />

  if (phase === 'brief' || phase === 'done') {
    const brief = phase === 'brief'
    const close = () => {
      finish()
      if (brief) return
      onFinish?.()
      // The selection page mounts with an animation that can interrupt a smooth scroll: land at the top for sure.
      const top = () => window.scrollTo({ top: 0, behavior: 'auto' })
      top(); window.setTimeout(top, 120); window.setTimeout(top, 500)
    }
    return createPortal(<div className="mt-backdrop">
      <section className="mt-brief" role="dialog" aria-modal="true" aria-labelledby="mt-brief-title">
        <span className="mt-kicker"><Rocket size={18} aria-hidden="true" /> {brief ? 'Mission briefing' : 'Mission complete'}</span>
        <h2 id="mt-brief-title">{brief ? 'Find the Moon’s lava tube on Earth' : 'You are ready to explore'}</h2>
        {brief ? <>
          <p>Artemis astronauts may one day shelter inside lunar lava tubes. Before that, they need a place on Earth to rehearse.</p>
          <p>Your mission: start at the <b>Marius Hills skylight</b> on the Moon, find the Earth places whose terrain is most alike, then walk one of them in 3D.</p>
          <ol className="mt-route"><li>Set up the search</li><li>See what the system already found, compare the matches and ask the Agent</li><li>Walk one and pass a field test</li></ol>
        </> : <>
          <p>You searched Earth from a lunar skylight, saw the sites the system had already found, compared the matches, questioned the Agent and worked both worlds on foot. You learned to:</p>
          <ul className="mt-learned">{LEARNED.map(([t, k]) => <li key={t}><Check size={18} aria-hidden="true" /> <span>{t}</span>{k && <kbd>{k}</kbd>}</li>)}</ul>
          <p>Back on the search page, pick any spot on the Moon or Mars yourself. Help, at the bottom right, replays this mission.</p>
        </>}
        <div className="mt-buttons">
          {brief && <button type="button" className="mt-secondary" onClick={finish}>Not now</button>}
          {!brief && chosen && <button type="button" className="mt-secondary" onClick={() => { finish(); window.location.href = chosen }}>Explore it in 3D</button>}
          <button type="button" className="mt-primary" autoFocus onClick={() => { if (brief) { unlockVoice(); begin() } else close() }}>
            {brief ? 'Accept mission' : 'Back to search'}</button>
        </div>
      </section>
    </div>, document.body)
  }

  if (!cur) return null
  // Search Candidates and Methods are separate static pages: they open in a glass frame so the mission goes on.
  const methodsUrl = document.querySelector('.topnav a[href*="/technology/"]')?.getAttribute('href') || '/technology/paper-en.html'
  const frameSrc = cur.id === 'foundlist' ? frameUrl : cur.id === 'methods' && methodsOpen ? methodsUrl : null
  const frame = ['found', 'foundlist', 'methods'].includes(cur.id) && !inEva ? createPortal(<>
    {/* The page under these steps takes no clicks: the only ways on are Next and the frame itself. */}
    <div className="mt-block" aria-hidden="true" />
    {frameSrc && <div className="mt-frame" role="dialog" aria-label={cur.id === 'methods' ? 'Methods' : 'Search Candidates'}>
      <header><b>{cur.id === 'methods' ? 'Methods' : 'Search Candidates'}</b>
        <span>{cur.id === 'methods' ? 'How TwinGround finds similar places' : 'Earth places the system already found for Moon and Mars sites'}</span>
        <button type="button" className="mt-quit" onClick={() => (cur.id === 'methods' ? setMethodsOpen(false) : mark('foundlist'))} aria-label="Close"><X size={18} /></button></header>
      <iframe key={frameSrc} title={cur.id === 'methods' ? 'Methods' : 'Search Candidates'} src={frameSrc} onLoad={e => {
        if (cur.id !== 'foundlist') return  // the paper keeps its own links (contents, figures)
        // Keep the visitor inside the mission: "Explore in 3D" is remembered for the done card, other links do nothing.
        try {
          e.currentTarget.contentDocument?.addEventListener('click', ev => {
            const a = ev.target?.closest?.('a')
            if (!a) return
            ev.preventDefault()
            if (a.matches('a.go')) { setChosen(a.href); mark('foundlist') }
          }, true)
        } catch { /* not same-origin */ }
      }} />
    </div>}</>, document.body) : null
  // What a callout must leave visible: the explorer's controls and scan result in 3D, the agent's header, input and newest
  // answer, and whatever the step itself talks about.
  const avoidRects = () => [
    ...(inEva ? ['.eva-actions', '.eva-joystick', '.eva-map', '.eva-scan', '.eva-tools', '.eva-lead'] : []),
    ...(cur.inPanel ? ['.aw-panel header', '.aw-input', '.aw-log > .aw-turn.is-bot:last-child'] : []),
    ...(!inEva ? ['.gt-help'] : []),
    ...(cur.avoid || []),
  ].map(a => locate(a)?.rect).filter(Boolean)
  // Inside 3D the mission lives in the explorer's own dialog: the explorer makes everything else on the page inert.
  const host = inEva && evaEl?.isConnected ? evaEl : document.body

  if (rect && (pointing || landing)) {
    const step = landing ? { title: 'Press this button', text: 'Go to the Moon to start the search.', act: 'start on the Moon' }
      : cur.id === 'search' && rect.disabled && searching ? { title: 'Searching Earth…', text: 'Comparing the skylight with every Earth window. The results open on their own in a few seconds.', act: cur.act }
      : cur.id === 'search' && rect.disabled ? { title: 'Loading the skylight terrain…', text: 'Your window is on the Marius Hills skylight and the search is set to lava tubes. This button lights up in a moment.', act: cur.act }
      : cur.id === 'agent' && agentWait === 'busy' ? { ...cur, text: 'The agent is reading the paper and this candidate’s data. An answer takes a few seconds.' }
      : cur.id === 'agent' && agentWait === 'slow' ? { ...cur, text: 'The agent is taking long today. Its answer will still appear here; you can move on.', act: 'skip' }
      : { ...cur, text: cur.stackedText && stacked() ? cur.stackedText : textOf(cur) }
    return <>{frame}{createPortal(<>
      <div className={`mt-spot${rect.disabled ? ' is-waiting' : ''}`} aria-hidden="true" style={{ top: rect.top - 8, left: rect.left - 8, width: rect.width + 16, height: rect.height + 16 }} />
      <Callout rect={rect} avoid={avoidRects} coverTarget={!!cur.inPanel} ch={cur.ch} title={step.title} text={step.text} action={step.act} onAct={act} waiting={cur.id === 'agent' && agentWait === 'busy'} muted={muted} onMute={onMute} onQuit={finish} />
    </>, host)}</>
  }
  if ((pointing || landing) && !lost) return frame  // its control is about to appear

  // 3D drills (and any step whose control is not on screen): the see-through side card with the chapter's task list.
  const tasks = in3D(cur) ? STEPS.filter(s => s.ch === cur.ch) : null
  const count = tasks ? `${tasks.filter(t => done[t.id]).length}/${tasks.length}` : ''
  const title = !tasks ? cur.title : `${CHAPTERS[cur.ch]} · ${count}`
  const waiting = in3D(cur) !== inEva  // between pages and 3D (the explorer is loading or closing)
  const text = waiting ? (inEva ? 'Finish here first.' : 'Loading the 3D scene…') : textOf(cur)
  return <>{frame}{createPortal(
    <section className={`mt-objective${inEva ? ' is-eva' : ''}${cur.id === 'methods' && methodsOpen ? ' is-corner' : ''}`} aria-live="polite" aria-label="Mission objective">
      <Head ch={cur.ch} muted={muted} onMute={onMute} onQuit={finish} />
      <h2>{title}</h2>
      <p>{text}</p>
      {tasks && <ul className="mt-tasks">{tasks.map(t => <li key={t.id} className={done[t.id] ? 'is-done' : t === cur ? 'is-now' : ''}>
        <span className="mt-check" aria-hidden="true">{done[t.id] ? <Check size={16} /> : null}</span>{t.task}{t.keys && <kbd>{t.keys}</kbd>}
      </li>)}</ul>}
      {cur.kind === 'card' && <NextButton detail={cur.act} onClick={act} />}
      {cur.id === 'methods' && !methodsOpen && <button type="button" className="mt-secondary mt-open" onClick={() => setMethodsOpen(true)}>Open Methods</button>}
      {lost && pointing && !rect && (cur.id === 'agent'
        ? <><NextButton detail="open the agent" onClick={askAgent} /><NextButton label="Skip" onClick={() => mark('agent', 'agentread')} /></>
        : <NextButton detail="skip this step" onClick={() => mark(cur.id)} />)}
    </section>, host)}</>
}
