// Mission Start (2026-11-15): the first screen of the home page. A black tactical HUD with green code rain, and one
// START MISSION button that opens Game mode. The rest of the landing (the normal entry buttons) sits below it.
//
// Rendering: one <canvas> for the rain and hex blips, one small <canvas> hugging the button for the electric arcs.
// Both run on a single requestAnimationFrame loop capped at 30 fps, which stops when the tab is hidden or the screen
// is scrolled out of view. With prefers-reduced-motion the rain is drawn once as a still frame and nothing flickers.
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown } from 'lucide-react'
import './mission_start.css'

const GLYPHS = '0123456789ABCDEF<>/=+*#'
const hex = n => Math.floor(Math.random() * 16 ** n).toString(16).toUpperCase().padStart(n, '0')
const pick = s => s[Math.floor(Math.random() * s.length)]
const GREEN = '#00ff41'
const FLASH_MS = 520

function runScreen({ section, rain, arc, wrap, state, readouts }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const rctx = rain.getContext('2d'), actx = arc.getContext('2d')
  let w = 0, h = 0, dpr = 1, mobile = false, colW = 18, rowH = 18, cols = [], blips = []
  let aw = 0, ah = 0, M = 22
  const crawl = [0, 0.5]

  const resize = () => {
    const r = section.getBoundingClientRect()
    w = Math.max(1, r.width); h = Math.max(1, r.height)
    mobile = w <= 640 || matchMedia('(pointer: coarse)').matches
    dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2)
    rain.width = Math.round(w * dpr); rain.height = Math.round(h * dpr)
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    colW = mobile ? 22 : 18; rowH = mobile ? 20 : 18
    const n = Math.ceil(w / colW), density = mobile ? 0.5 : 0.72
    cols = Array.from({ length: n }, () => ({
      on: Math.random() < density, y: Math.random() * (h / rowH), v: 0.25 + Math.random() * 0.55, row: -1,
    }))
    rctx.fillStyle = '#000'; rctx.fillRect(0, 0, w, h)
    rctx.font = `500 ${mobile ? 16 : 15}px 'DM Mono', ui-monospace, monospace`
    rctx.textAlign = 'center'; rctx.textBaseline = 'top'
    const b = wrap.getBoundingClientRect()
    M = 22; aw = b.width + 2 * M; ah = b.height + 2 * M
    arc.width = Math.round(aw * dpr); arc.height = Math.round(ah * dpr)
    arc.style.width = `${aw}px`; arc.style.height = `${ah}px`
    actx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (reduced) still()
  }

  // A still frame for reduced motion: scattered dim glyphs, no movement.
  const still = () => {
    rctx.fillStyle = '#000'; rctx.fillRect(0, 0, w, h)
    for (let x = 0; x < w; x += colW) for (let y = 0; y < h; y += rowH) {
      if (Math.random() < 0.18) { rctx.globalAlpha = 0.08 + Math.random() * 0.25; rctx.fillStyle = GREEN; rctx.fillText(pick(GLYPHS), x + colW / 2, y) }
    }
    rctx.globalAlpha = 1
  }

  const drawRain = () => {
    rctx.globalAlpha = 1
    rctx.fillStyle = 'rgba(0,0,0,0.075)'; rctx.fillRect(0, 0, w, h)
    rctx.fillStyle = GREEN
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]
      if (!c.on) continue
      c.y += c.v
      const row = Math.floor(c.y)
      if (row !== c.row) {
        c.row = row
        rctx.globalAlpha = 0.35 + Math.random() * 0.45
        rctx.fillText(pick(GLYPHS), i * colW + colW / 2, row * rowH)
      }
      if (row * rowH > h && Math.random() > 0.96) { c.y = -Math.random() * 8; c.row = -1; c.v = 0.25 + Math.random() * 0.55 }
    }
    // Flickering hex blips scattered over the field.
    if (Math.random() < (mobile ? 0.05 : 0.09)) blips.push({ x: Math.random() * w, y: Math.random() * h, t: Math.random() < 0.5 ? `0x${hex(4)}` : `${hex(2)} ${hex(2)} ${hex(2)}`, life: 6 + Math.floor(Math.random() * 16) })
    for (const b of blips) {
      b.life--
      if (Math.random() < 0.6) { rctx.globalAlpha = 0.25 + Math.random() * 0.5; rctx.fillText(b.t, b.x, b.y) }
    }
    blips = blips.filter(b => b.life > 0)
    rctx.globalAlpha = 1
  }

  // Electric arcs along the button's border. Idle: sparse, irregular sparks. Hover: two bolts crawl around the edge.
  // Launch: the whole border overloads.
  const perim = () => 2 * (aw - 2 * M) + 2 * (ah - 2 * M)
  const at = t => {
    const bw = aw - 2 * M, bh = ah - 2 * M, P = perim()
    t = ((t % P) + P) % P
    if (t < bw) return [M + t, M, 0, -1]
    t -= bw; if (t < bh) return [M + bw, M + t, 1, 0]
    t -= bh; if (t < bw) return [M + bw - t, M + bh, 0, 1]
    t -= bw; return [M, M + bh - t, -1, 0]
  }
  const bolt = (t0, len, amp, width) => {
    actx.beginPath()
    for (let s = 0; s <= len; s += 6) {
      const [x, y, nx, ny] = at(t0 + s)
      const o = (s === 0 || s >= len - 5) ? 0 : (Math.random() * 2 - 1) * amp
      s === 0 ? actx.moveTo(x + nx * o, y + ny * o) : actx.lineTo(x + nx * o, y + ny * o)
    }
    actx.strokeStyle = GREEN; actx.lineWidth = width; actx.shadowColor = GREEN; actx.shadowBlur = 10; actx.stroke()
    actx.strokeStyle = '#eaffef'; actx.lineWidth = Math.max(0.6, width / 2.5); actx.shadowBlur = 0; actx.stroke()
    // An occasional branch jumping off the border.
    if (Math.random() < 0.35) {
      const [x, y, nx, ny] = at(t0 + Math.random() * len), reach = 6 + Math.random() * (amp * 3)
      actx.beginPath(); actx.moveTo(x, y)
      actx.lineTo(x + nx * reach * 0.5 + (Math.random() - 0.5) * 8, y + ny * reach * 0.5 + (Math.random() - 0.5) * 8)
      actx.lineTo(x + nx * reach + (Math.random() - 0.5) * 10, y + ny * reach + (Math.random() - 0.5) * 10)
      actx.strokeStyle = GREEN; actx.lineWidth = 1; actx.shadowBlur = 8; actx.stroke(); actx.shadowBlur = 0
    }
  }
  const drawArcs = dt => {
    actx.clearRect(0, 0, aw, ah)
    const { hover, launch } = state.current, P = perim()
    if (launch) { for (let i = 0; i < 6; i++) bolt(Math.random() * P, 80 + Math.random() * 200, 9, 2.4); return }
    if (hover) {
      for (let i = 0; i < crawl.length; i++) {
        crawl[i] = (crawl[i] + dt / 1300) % 1
        bolt(crawl[i] * P - 90, 90, 4.5, 2)
      }
      if (Math.random() < 0.5) bolt(Math.random() * P, 30 + Math.random() * 90, 5, 1.4)
      return
    }
    if (Math.random() < 0.3) bolt(Math.random() * P, 24 + Math.random() * 70, 3.5, 1.4)
    if (Math.random() < 0.06) bolt(Math.random() * P, 80 + Math.random() * 120, 5, 1.8)
  }

  let frame = 0, tick = 0
  const updateReadouts = () => {
    const r = readouts.current
    if (r.sig) r.sig.textContent = `${(92 + Math.random() * 7).toFixed(1)}%`
    if (r.pkt) r.pkt.textContent = `0x${hex(4)}`
    if (r.rate) r.rate.textContent = `${(2.1 + Math.random() * 0.4).toFixed(2)} MB/s`
    if (r.clock) r.clock.textContent = new Date().toISOString().slice(11, 19)
  }

  let raf = 0, last = 0, running = false, inView = true
  const loop = now => {
    raf = requestAnimationFrame(loop)
    const dt = now - last
    if (dt < 1000 / 30) return
    last = now
    drawRain(); drawArcs(Math.min(dt, 100))
    if (++frame % 15 === 0) updateReadouts()
  }
  const sync = () => {
    const want = !reduced && inView && !document.hidden
    if (want && !running) { running = true; last = 0; raf = requestAnimationFrame(loop) }
    if (!want && running) { running = false; cancelAnimationFrame(raf) }
  }

  resize(); updateReadouts()
  const ro = new ResizeObserver(() => resize())
  ro.observe(section); ro.observe(wrap)
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync() }) : null
  io?.observe(section)
  document.addEventListener('visibilitychange', sync)
  // Reduced motion still gets a live clock, once a second, with no visual motion.
  if (reduced) tick = setInterval(updateReadouts, 1000)
  sync()
  return () => { cancelAnimationFrame(raf); ro.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', sync); clearInterval(tick) }
}

export function MissionStart({ onStart, skipTo = 'landing-hero' }) {
  const section = useRef(null), rain = useRef(null), arc = useRef(null), wrap = useRef(null)
  const state = useRef({ hover: false, launch: false }), readouts = useRef({})
  const [phase, setPhase] = useState('idle') // idle -> launching -> gone

  useEffect(() => {
    if (phase === 'gone') return
    return runScreen({ section: section.current, rain: rain.current, arc: arc.current, wrap: wrap.current, state, readouts })
  }, [phase === 'gone'])

  const launch = () => {
    if (phase !== 'idle') return
    // Game mode starts inside the tap itself: phones only unlock audio from a direct user gesture.
    onStart?.()
    state.current.launch = true
    setPhase('launching')
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    setTimeout(() => { setPhase('gone'); window.scrollTo(0, 0) }, reduced ? 300 : FLASH_MS)
  }
  const skip = () => {
    const el = document.getElementById(skipTo)
    el?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }
  const hover = on => () => { state.current.hover = on }
  const ref = key => el => { readouts.current[key] = el }

  if (phase === 'gone') return null
  return <section ref={section} id="mission-start" className={`ms ${phase === 'launching' ? 'is-overload' : ''}`} aria-label="Mission start">
    <canvas ref={rain} className="ms-rain" aria-hidden="true" />
    <div className="ms-grid" aria-hidden="true" />
    <div className="ms-frame" aria-hidden="true">
      <i className="ms-corner is-tl" /><i className="ms-corner is-tr" /><i className="ms-corner is-bl" /><i className="ms-corner is-br" />
      <i className="ms-ruler is-top" /><i className="ms-ruler is-bottom" /><i className="ms-ruler is-left" /><i className="ms-ruler is-right" />
      <i className="ms-cross is-h" /><i className="ms-cross is-v" />
    </div>

    <div className="ms-readout is-tl" aria-hidden="true">
      <b>TWINGROUND</b>
      <span>UPLINK · CH-07</span>
      <span className="ms-wide">PKT <em ref={ref('pkt')}>0x0000</em></span>
    </div>
    <div className="ms-readout is-tr" aria-hidden="true">
      <span>SIG <em ref={ref('sig')}>--.-%</em></span>
      <span>UTC <em ref={ref('clock')}>--:--:--</em></span>
      <span className="ms-wide">RX <em ref={ref('rate')}>-.-- MB/s</em></span>
    </div>
    <div className="ms-readout is-bl ms-wide" aria-hidden="true">
      <span>TARGET · LUNAR LAVA TUBE</span>
      <span>SEARCH AREA · EARTH</span>
    </div>
    <div className="ms-readout is-br ms-wide" aria-hidden="true">
      <span>NASA SPACE APPS 2026</span>
      <span>STATUS · <em className="ms-blink">AWAITING GO</em></span>
    </div>

    <div className="ms-center">
      <p className="ms-kicker"><span className="ms-dot" aria-hidden="true" /><span>Incoming transmission<span className="ms-k-wide"> · priority one</span></span></p>
      <p className="ms-title">TwinGround</p>
      <p className="ms-brief">Objective: find the Moon’s lava tube on Earth.</p>
      <div className="ms-button-wrap" ref={wrap}>
        <span className="ms-ring" aria-hidden="true" />
        <canvas ref={arc} className="ms-arc" aria-hidden="true" />
        <i className="ms-tick is-tl" aria-hidden="true" /><i className="ms-tick is-tr" aria-hidden="true" /><i className="ms-tick is-bl" aria-hidden="true" /><i className="ms-tick is-br" aria-hidden="true" />
        <button type="button" className="ms-button" onClick={launch} disabled={phase !== 'idle'}
          onPointerEnter={hover(true)} onPointerLeave={hover(false)} onFocus={hover(true)} onBlur={hover(false)}>
          <span className="ms-label" data-text="START MISSION">START MISSION</span>
        </button>
      </div>
      <p className="ms-caption">Game mode · voice briefing · sound on</p>
    </div>

    <button type="button" className="ms-skip" onClick={skip}>
      <span>Skip<span className="ms-k-wide"> the mission</span> · enter the site</span><ArrowDown size={18} aria-hidden="true" />
    </button>

    {phase === 'launching' && createPortal(<div className="ms-flash" aria-hidden="true"><i /></div>, document.body)}
  </section>
}
