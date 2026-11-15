// Guided tour (2026-11-14): a step-by-step walkthrough of each page, English only. A launcher sits bottom-left on
// every page; each step spotlights one element and explains it. The landing and selection tours can carry on to the
// next page (open the Moon selection, run the search), and the tour resumes there. Steps whose element is not on the
// page (e.g. the region suggestions on Mars) are skipped. ?tour=1 in the URL starts it on load.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Compass, X, ArrowLeft, ArrowRight, HelpCircle, MessageCircle, Rocket } from 'lucide-react'
import './guided_tour.css'

const SEEN_KEY = 'twinground:tour-seen:v1'

const TOURS = {
  landing: [
    { title: 'Welcome to TwinGround', body: 'TwinGround finds places on Earth whose terrain resembles a patch of the Moon or Mars, compares them side by side in 3D and lets you walk them as an astronaut. This tour takes about a minute.' },
    { target: '.ms-button', title: 'Start the mission', body: 'Game mode: a guided mission with a voice briefing that walks you through finding the Moon’s lava tube on Earth. Skip it to use the site directly.' },
    { target: '.landing-cta', title: 'Pick a world', body: 'Start on the Moon or on Mars to choose a region yourself, or describe the place you need in plain words and let the site turn it into search conditions.' },
    { target: '.landing-ask', title: 'Ask the assistant', body: 'The assistant answers questions about the method, the data and the results. Every answer lists the passages it read, so you can check the source.' },
    { target: '.landing-candidates', title: 'Search Candidates', body: 'Browse and compare the candidate locations found outside the catalogue of known analog sites.' },
    { target: '.landing-pair', title: 'Or pick a spot directly', body: 'Click anywhere on either globe to open that exact location. Drag the large scene above to turn it; sizes are to scale, distances are compressed.' },
    { title: 'Next: choose a region', body: 'The search starts from a window on the Moon or Mars. Continue and the tour picks up on the selection page.', action: { label: 'Continue on the Moon', run: 'startMoon', resume: 'select' } },
  ],
  select: [
    { target: '.page-heading', title: 'Step 1 · Choose a region', body: 'This page sets the window on the Moon or Mars that you want an Earth twin for.' },
    { target: '.globe-panel', title: 'Set the window', body: 'Click the globe to move the window. Drag to rotate, scroll to zoom. The coordinates and window size show at the bottom; the map button opens a flat map for precise picking.' },
    { target: '.scale-picker', title: 'Window size', body: 'Pick how large the window is, in kilometres. Sizes marked "interp." are finer than the source elevation data and are interpolated.' },
    { target: '.purpose-tiles', title: 'What is the analog for?', body: 'The purpose decides how candidates are ranked: overall terrain shape, physical properties for a given use, material, or lava tubes and skylights.' },
    { target: '.condition-tiles', title: 'Surface and rock', body: 'Optionally require a surface type or rock type on Earth. Leave these on "any" to rank by terrain alone. Click the heading to show or hide them.' },
    { target: '.mini-preview', title: 'Terrain preview', body: 'A wireframe of the elevation inside the selected window, so you can see the shape you are matching before you search.' },
    { target: '.region-suggestions', title: 'Curated regions', body: 'Not sure where to start? Open this list for hand-picked Moon windows covering craters, mare plains and highlands.' },
    { target: '.topnav', last: true, title: 'Move between pages', body: 'Switch between the Moon and Mars, return to your results, search in plain words, browse off-catalogue candidates or read the methods paper.' },
    { target: '.search-button', title: 'Search Earth', body: 'When the terrain has loaded, run the search. The server compares this window against Earth and returns ranked candidates.', action: { label: 'Run the search', run: 'search', resume: 'results' } },
  ],
  results: [
    { target: '.match-list', title: 'Ranked candidates', body: 'Earth places ranked for your window. Click one to compare it; the scores show how close it is. "Show more" loads further candidates.' },
    { target: '.earth-locator', title: 'Where they are', body: 'Every candidate on an Earth map. Nearby ones are grouped; click a group to expand it, or a point to select that candidate.' },
    { target: '.comparison-switch', title: 'Imagery or pure terrain', body: 'Switch between draped imagery and a plain grey surface. Grey makes it easier to compare shape alone, without colour getting in the way.' },
    { target: '.terrain-pair', title: 'Side by side in 3D', body: 'Your window on the left, the Earth candidate on the right, at the same vertical scale. Drag to rotate, scroll to zoom. Use the walk button on either panel to explore it on foot as an astronaut.' },
    { target: '.source-detail', title: 'The evidence', body: 'Open these sections for the surface and rock data behind each candidate and the sources it comes from.' },
    // No step on the Help button itself: it is unmounted while the tour is open, so the assistant is described here.
    { title: 'That is the tour', body: 'Candidates are proposals of the same kind of setting, not validated analog sites. To ask why a candidate was chosen or what does not match, open Help → Ask: on this page the assistant reads the candidate you are viewing. Restart the tour any time from Help → Tour.' },
  ],
  chat: [
    { target: '.cs-input', title: 'Describe it in words', body: 'Type what you need, for example "flat basalt plain near the equator" or "steep crater wall with loose regolith". A language model turns the text into search conditions.' },
    { target: '.cs-results', title: 'Results with their numbers', body: 'Matching places appear here with the measured values behind each condition. Ranking follows fixed rules on the data, not the model’s judgement.' },
    { target: '.topnav', last: true, title: 'Back to the map', body: 'Use the Moon or Mars links to choose a region on the globe instead.' },
  ],
}

const STAGE_KEYS = ['landing', 'select', 'results', 'chat']
const find = selector => {
  if (!selector) return null
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? el : null
}

// Wait briefly for lazily rendered elements before deciding a step has no target.
function waitFor(selector, ms = 1500) {
  return new Promise(resolve => {
    const start = Date.now()
    const tick = () => {
      const el = find(selector)
      if (el || Date.now() - start > ms) return resolve(el)
      setTimeout(tick, 60)
    }
    tick()
  })
}

function placeCard(rect, card) {
  const vw = window.innerWidth, vh = window.innerHeight, gap = 14, pad = 16
  const w = card?.offsetWidth || 360, h = card?.offsetHeight || 200
  if (!rect || vw < 640) return null // centred, or a bottom sheet on phones (CSS)
  let top = rect.bottom + gap
  if (top + h > vh - pad) top = rect.top - gap - h
  if (top < pad) top = Math.min(vh - h - pad, Math.max(pad, rect.top + rect.height / 2 - h / 2))
  let left = rect.left + rect.width / 2 - w / 2
  // A target taller than the screen: put the card beside it if there is room.
  const overlaps = top < rect.bottom && top + h > rect.top
  if (overlaps || rect.height > vh * 0.6) {
    const middle = Math.max(pad, Math.min(vh - h - pad, vh / 2 - h / 2))
    if (rect.right + gap + w < vw - pad) { left = rect.right + gap; top = middle }
    else if (rect.left - gap - w > pad) { left = rect.left - gap - w; top = middle }
  }
  left = Math.max(pad, Math.min(vw - w - pad, left))
  return { top, left }
}

export function GuidedTour({ stage, onStartMoon, onAsk, onMission }) {
  // One Help button (bottom right) that expands into Tour and Ask.
  const [menu, setMenu] = useState(false)
  const helpRef = useRef(null)
  useEffect(() => {
    if (!menu) return
    const away = e => { if (!helpRef.current?.contains(e.target)) setMenu(false) }
    const esc = e => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [menu])
  const key = STAGE_KEYS[stage] || 'landing'
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState(null)
  const [pos, setPos] = useState(null)
  const [fresh, setFresh] = useState(() => { try { return !window.localStorage.getItem(SEEN_KEY) } catch { return false } })
  const resume = useRef(null)
  const card = useRef(null)
  const target = useRef(null)
  const lastRect = useRef(null)  // Steps run top to bottom as the page lays them out (re-sorted each time the tour opens). Steps with no element
  // (intro, outro) and steps that leave the page keep their place.
  const steps = useMemo(() => {
    const list = TOURS[key]
    const movable = list.map((s, i) => (s.target && !s.action ? i : -1)).filter(i => i >= 0)
    // Elements fixed to the screen (themselves or through an ancestor) have no place in the page's top-to-bottom
    // order: they go after every in-page step, in their own screen order. Site chrome such as the top navigation is
    // marked `last` so a page's own "Step 1" comes first.
    const fixed = el => { for (let e = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return true; return false }
    const top = s => { const el = find(s.target); if (!el) return Infinity; const r = el.getBoundingClientRect(); return s.last ? 2e9 : fixed(el) ? 1e9 + r.top : r.top + window.scrollY }
    const sorted = movable.map(i => ({ s: list[i], y: top(list[i]), i })).sort((a, b) => a.y - b.y || a.i - b.i)
    const out = [...list]
    movable.forEach((slot, n) => { out[slot] = sorted[n].s })
    return out
  }, [key, open])
  const step = open ? steps[index] : null

  const close = useCallback(() => { setOpen(false); setRect(null); target.current = null; resume.current = null }, [])
  const start = useCallback((at = 0) => {
    setIndex(at); setOpen(true); setFresh(false)
    try { window.localStorage.setItem(SEEN_KEY, '1') } catch { /* The tour still runs without storage. */ }
  }, [])

  // ?tour=1 starts the tour on load. First visits get the mission tutorial (mission_tutorial.jsx) instead.
  useEffect(() => { if (new URLSearchParams(window.location.search).get('tour') === '1') start(0) }, [start])

  // A page change ends the tour unless a step asked to continue on that page.
  useEffect(() => {
    if (resume.current === key) { resume.current = null; start(0) }
    else if (open) close()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Find the step's element (skipping missing ones in the direction of travel) and bring it into view.
  const direction = useRef(1)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const s = steps[index]
    if (!s) { close(); return }
    // Drop the previous step's spotlight at once, so it never sits on the wrong element while this one is found.
    // Fade the frame out where it is, move it while invisible, then fade it in on this step's element.
    const hadSpot = Boolean(target.current)
    target.current = null; setRect(null)
    if (!s.target) return
    const fadeOut = new Promise(resolve => window.setTimeout(resolve, hadSpot ? 340 : 0))
    fadeOut.then(() => waitFor(s.target)).then(el => {
      if (cancelled) return
      if (!el) {
        const next = index + direction.current
        if (next >= 0 && next < steps.length) setIndex(next)
        return
      }
      target.current = el
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const r = el.getBoundingClientRect()
      if (r.top < 70 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: r.height > window.innerHeight * 0.7 ? 'start' : 'center', behavior: reduce ? 'auto' : 'smooth' })
    })
    return () => { cancelled = true }
  }, [open, index, key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the element while the page scrolls, resizes or animates.
  useEffect(() => {
    if (!open) return
    let frame
    const loop = () => {
      const el = target.current
      if (el && el.isConnected) {
        const r = el.getBoundingClientRect()
        setRect(prev => prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5 && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5 ? prev : { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right })
      }
      frame = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(frame)
  }, [open])

  // While a step's element is still being found (the previous frame is fading out) the card stays where it is.
  useLayoutEffect(() => { if (open && (rect || !steps[index]?.target)) setPos(placeCard(rect, card.current)) }, [open, rect, index]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) card.current?.focus({ preventScroll: true }) }, [open, index])

  const go = delta => {
    direction.current = delta
    const next = index + delta
    if (next < 0) return
    if (next >= steps.length) close()
    else setIndex(next)
  }
  const runAction = action => {
    if (action.run === 'startMoon') { resume.current = action.resume; setOpen(false); onStartMoon?.(); return }
    if (action.run === 'search') {
      const button = document.querySelector('.search-button')
      if (!button || button.disabled) return
      resume.current = action.resume
      setOpen(false); setRect(null)
      button.click()
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      else if (event.key === 'ArrowRight') go(1)
      else if (event.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const searchReady = step?.action?.run !== 'search' || !document.querySelector('.search-button')?.disabled
  const pad = 8
  // With no element the frame is faded out where it last was (or at the centre of the screen on the first step).
  if (rect) lastRect.current = rect
  const spot = rect || lastRect.current || { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 }
  return <>
    {!open && <div className={`gt-help${menu ? ' is-open' : ''}`} ref={helpRef}>
      <div className="gt-help-menu" id="gt-help-menu" role="menu" aria-hidden={!menu}>
        {onMission && <button type="button" role="menuitem" tabIndex={menu ? 0 : -1} onClick={() => { setMenu(false); onMission() }}>
          <Rocket size={17} aria-hidden="true" /> Mission
        </button>}
        <button type="button" role="menuitem" tabIndex={menu ? 0 : -1} onClick={() => { setMenu(false); start(0) }}>
          <Compass size={17} aria-hidden="true" /> Tour
        </button>
        {onAsk && <button type="button" role="menuitem" tabIndex={menu ? 0 : -1} onClick={() => { setMenu(false); onAsk() }}>
          <MessageCircle size={17} aria-hidden="true" /> Ask
        </button>}
      </div>
      <button type="button" className={`gt-launch${fresh ? ' is-fresh' : ''}`} onClick={() => setMenu(m => !m)}
        aria-expanded={menu} aria-controls="gt-help-menu" aria-label={menu ? 'Close help' : 'Help: tour and assistant'}>
        {menu ? <X size={17} aria-hidden="true" /> : <HelpCircle size={17} aria-hidden="true" />} Help
      </button>
    </div>}
    {open && <div className="gt-layer" lang="en">
      <div className={`gt-spot${rect ? '' : ' is-none'}`} aria-hidden="true"
        style={{ top: spot.top - pad, left: spot.left - pad, width: spot.width + pad * 2, height: spot.height + pad * 2 }} />
      <div ref={card} className={`gt-card${pos ? '' : ' is-centred'}`} style={pos || undefined}
        role="dialog" aria-modal="false" aria-labelledby="gt-title" aria-describedby="gt-body" tabIndex={-1}>
        <div className="gt-head">
          <span className="gt-count">Guided tour · {index + 1} / {steps.length}</span>
          <button type="button" className="gt-close" onClick={close} aria-label="End the tour"><X size={16} /></button>
        </div>
        <h2 id="gt-title">{step.title}</h2>
        <p id="gt-body">{step.body}</p>
        <div className="gt-dots" aria-hidden="true">{steps.map((_, i) => <i key={i} className={i === index ? 'is-on' : i < index ? 'is-done' : ''} />)}</div>
        <div className="gt-actions">
          <button type="button" className="gt-ghost" onClick={close}>Skip tour</button>
          <span className="gt-spacer" />
          {index > 0 && <button type="button" className="gt-ghost" onClick={() => go(-1)} aria-label="Previous step"><ArrowLeft size={15} /></button>}
          {step.action
            ? <>
                {step.action.run === 'search' && <button type="button" className="gt-ghost" onClick={close}>Finish here</button>}
                <button type="button" className="gt-primary" disabled={!searchReady} onClick={() => runAction(step.action)}>
                  {searchReady ? step.action.label : 'Terrain loading…'} <ArrowRight size={15} />
                </button>
              </>
            : <button type="button" className="gt-primary" onClick={() => go(1)}>{index === steps.length - 1 ? 'Done' : 'Next'} {index < steps.length - 1 && <ArrowRight size={15} />}</button>}
        </div>
      </div>
    </div>}
  </>
}
