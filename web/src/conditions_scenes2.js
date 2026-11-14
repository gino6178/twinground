// Canvas 2D scenes for the five dimension cards (temperature, dust, biology, surface processes, sunlight), drawn in the
// same 88 x 88 unit box as conditions_scenes.js. `st.p` holds the candidate's values and `st.t` the running time.
// Decorative only: the card text carries the data, but every intensity follows the candidate's values.
const R = (a, b) => a + Math.random() * (b - a)
const C01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
const TAU = Math.PI * 2
const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k))
const rgb = c => `rgb(${c})`

function sky(ctx, top, bottom, y0 = 0, y1 = 88) {
  const g = ctx.createLinearGradient(0, y0, 0, y1)
  g.addColorStop(0, top); g.addColorStop(1, bottom)
  ctx.fillStyle = g; ctx.fillRect(0, y0, 88, y1 - y0)
}
function glow(ctx, x, y, r, color, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = alpha; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.globalAlpha = 1
}
function puff(ctx, x, y, r, c, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(0.6, `rgba(${c},${a * 0.45})`); g.addColorStop(1, `rgba(${c},0)`)
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill()
}
function step(list, dt, fn) { for (let i = list.length - 1; i >= 0; i--) { const q = list[i]; q.life += dt; if (fn(q) === false || q.life > q.max) list.splice(i, 1) } }
function label(ctx, text, x, y, align = 'left') {
  if (!text) return
  ctx.font = '700 7px system-ui, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(text, x + 0.5, y + 0.5)
  ctx.fillStyle = '#f2f2f2'; ctx.fillText(text, x, y)
}
function stars(ctx, list, t, a = 1) {
  if (a <= 0.02) return
  list.forEach(s => { ctx.globalAlpha = a * (0.45 + 0.55 * Math.abs(Math.sin(t * s.w + s.ph))); ctx.fillStyle = '#ffffff'; ctx.fillRect(s.x, s.y, s.r, s.r) })
  ctx.globalAlpha = 1
}
const starField = (n, y1) => Array.from({ length: n }, () => ({ x: R(0, 88), y: R(0, y1), r: R(0.5, 1.1), w: R(0.8, 2.4), ph: R(0, TAU) }))

// ------------------------------------------------------------------ temperature: day-night cycle and a thermometer
// The fluid swings between the recorded minimum and maximum; frost forms below 0 °C and the air shimmers above 30 °C.
export const TEMPERATURE = {
  init(st) {
    st.stars = starField(22, 50)
    st.frost = Array.from({ length: 22 }, () => ({ x: R(2, 62), y: R(66, 86), ph: R(0, TAU) }))
    st.ridge = Array.from({ length: 9 }, (_, i) => [i * 8, R(50, 58)])
  },
  draw(ctx, st) {
    const t = st.t, p = st.p
    const lo = Number.isFinite(p.lo) ? p.lo : -10, hi = Number.isFinite(p.hi) ? p.hi : 30
    const s = Math.sin(t * TAU / 9), day = C01(0.5 + s * 0.9)
    const T = (lo + hi) / 2 + (hi - lo) / 2 * s
    sky(ctx, rgb(lerp([6, 8, 16], [40, 92, 140], day)), rgb(lerp([20, 24, 36], [160, 196, 214], day)), 0, 64)
    stars(ctx, st.stars, t, 1 - day * 1.4)
    // the Sun rises on the left and sets on the right; the Moon-like glow marks night
    const ang = (t * TAU / 9) - Math.PI / 2, sx = 32 - 30 * Math.cos(ang + Math.PI / 2), sy = 60 - 46 * Math.max(0, s)
    if (s > -0.15) { glow(ctx, sx, sy, 22, 'rgba(255,236,190,0.7)', C01(s + 0.15)); ctx.fillStyle = `rgba(255,248,226,${C01((s + 0.15) * 3)})`; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, TAU); ctx.fill() }
    ctx.fillStyle = rgb(lerp([18, 18, 20], [70, 66, 62], day)); ctx.beginPath(); ctx.moveTo(0, 88); st.ridge.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(66, 56); ctx.lineTo(66, 88); ctx.fill()
    const g = ctx.createLinearGradient(0, 64, 0, 88); g.addColorStop(0, rgb(lerp([36, 34, 32], [128, 118, 104], day))); g.addColorStop(1, rgb(lerp([14, 13, 12], [70, 62, 54], day)))
    ctx.fillStyle = g; ctx.fillRect(0, 64, 66, 24)
    if (T < 0) {
      const k = C01(-T / 20)
      ctx.fillStyle = `rgba(230,240,248,${0.25 + 0.35 * k})`; ctx.fillRect(0, 64, 66, 1.4)
      st.frost.forEach(f => { const a = k * Math.pow(Math.max(0, Math.sin(t * 2.4 + f.ph)), 6); glow(ctx, f.x, f.y, 2.6, 'rgba(255,255,255,0.95)', a) })
    }
    if (T > 30) {
      const k = C01((T - 30) / 15)
      ctx.strokeStyle = `rgba(255,240,220,${0.18 * k})`; ctx.lineWidth = 0.6
      for (let i = 0; i < 4; i++) { const y = 60 - i * 4; ctx.beginPath(); for (let x = 0; x <= 66; x += 3) ctx.lineTo(x, y + Math.sin(x * 0.35 + t * 6 + i) * 1.2); ctx.stroke() }
    }
    // thermometer, scale -60 .. +60 °C
    const yOf = v => 74 - (C01((v + 60) / 120)) * 58
    ctx.fillStyle = 'rgba(14,14,14,0.75)'; ctx.fillRect(68, 6, 18, 80)
    ctx.fillStyle = '#d8d8d8'; ctx.beginPath(); ctx.roundRect(74.5, 12, 5, 66, 2.5); ctx.fill()
    const fluid = T < 0 ? [120, 178, 236] : T > 30 ? [236, 112, 84] : [228, 228, 228]
    ctx.fillStyle = rgb(fluid); ctx.fillRect(75.7, yOf(T), 2.6, 78 - yOf(T)); ctx.beginPath(); ctx.arc(77, 79, 4.2, 0, TAU); ctx.fill()
    ctx.strokeStyle = 'rgba(40,40,40,0.8)'; ctx.lineWidth = 0.5
    for (let v = -60; v <= 60; v += 20) { ctx.beginPath(); ctx.moveTo(73, yOf(v)); ctx.lineTo(74.4, yOf(v)); ctx.stroke() }
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.moveTo(72, yOf(0)); ctx.lineTo(74.4, yOf(0)); ctx.stroke()
    // dashed marks at the recorded extremes
    ctx.setLineDash([1.2, 1]); ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    for (const v of [lo, hi]) { ctx.beginPath(); ctx.moveTo(80, yOf(v)); ctx.lineTo(84, yOf(v)); ctx.stroke() }
    ctx.setLineDash([])
    label(ctx, `${Math.round(T)}°C`, 4, 10)
  },
}

// ------------------------------------------------------------------ dust: haze from aerosol optical depth, drift from wind
export const DUST = {
  init(st) {
    const haze = C01(st.p.aod / 0.6), wind = Number.isFinite(st.p.wind) ? st.p.wind : 2
    st.haze = haze; st.wind = wind
    st.grains = Array.from({ length: 14 + Math.round(90 * haze) }, () => ({ x: R(0, 88), y: R(20, 86), z: R(0.3, 1), ph: R(0, TAU) }))
    st.veils = Array.from({ length: 4 }, (_, i) => ({ x: i * 30, y: R(40, 70), r: R(18, 26) }))
    st.devil = wind >= 4 && haze >= 0.25 ? { x: -10, ph: 0 } : null
    st.spin = []
  },
  draw(ctx, st, dt) {
    const t = st.t, h = st.haze, v = 6 + 7 * st.wind
    const top = lerp([34, 70, 112], [120, 104, 86], h), bot = lerp([170, 196, 210], [210, 182, 140], h)
    sky(ctx, rgb(top), rgb(bot), 0, 66)
    glow(ctx, 64, 18, 24 - 8 * h, `rgba(255,240,210,${0.8 - 0.5 * h})`)
    ctx.fillStyle = `rgba(255,250,236,${0.95 - 0.6 * h})`; ctx.beginPath(); ctx.arc(64, 18, 4.2, 0, TAU); ctx.fill()
    // far hills fade with optical depth
    ctx.fillStyle = `rgba(${lerp([96, 92, 88], bot, 0.4 + 0.5 * h)},1)`
    ctx.beginPath(); ctx.moveTo(0, 60); ctx.quadraticCurveTo(20, 48, 40, 56); ctx.quadraticCurveTo(62, 62, 88, 50); ctx.lineTo(88, 66); ctx.lineTo(0, 66); ctx.fill()
    const g = ctx.createLinearGradient(0, 64, 0, 88); g.addColorStop(0, '#9a8466'); g.addColorStop(1, '#5a4a38')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 66); ctx.quadraticCurveTo(44, 62, 88, 66); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
    st.veils.forEach(q => { q.x = (q.x + v * 0.35 * dt) % 130; puff(ctx, q.x - 22, q.y, q.r, '220,196,156', 0.08 + 0.32 * h) })
    st.grains.forEach(q => {
      q.x += v * q.z * dt; q.y += Math.sin(t * 2 + q.ph) * 2 * dt
      if (q.x > 92) { q.x = -4; q.y = R(20, 86) }
      ctx.fillStyle = `rgba(232,210,170,${0.25 + 0.55 * q.z})`; ctx.fillRect(q.x, q.y, 0.6 + 2.6 * q.z * C01(st.wind / 8), 0.6 * q.z + 0.3)
    })
    if (st.devil) {
      const d = st.devil; d.x += 9 * dt; if (d.x > 100) d.x = -12
      for (let i = 0; i < 3; i++) st.spin.push({ a: R(0, TAU), y: 84, life: 0, max: R(1.4, 2.2) })
      step(st.spin, dt, q => {
        q.a += dt * 7; q.y -= 26 * dt
        const r = 1.5 + (84 - q.y) * 0.22, x = d.x + Math.sin(q.y * 0.15 + t) * 2 + Math.cos(q.a) * r
        ctx.fillStyle = `rgba(214,186,146,${0.55 * (1 - q.life / q.max)})`; ctx.fillRect(x, q.y, 1.3, 1)
      })
    }
  },
}

// ------------------------------------------------------------------ biology: the niche where microbes live at this kind of site
// hypolith: green film under a translucent stone; endolith: a green band just inside rock; crust: biological soil
// crust that greens after rain; veg: plants on the surface.
export const LIFE = {
  init(st) {
    st.cells = Array.from({ length: 26 }, () => ({ x: R(28, 60), y: R(53, 57), ph: R(0, TAU), r: R(0.5, 1.1) }))
    st.rays = Array.from({ length: 5 }, (_, i) => ({ x: 34 + i * 5, ph: R(0, TAU) }))
    st.grains = Array.from({ length: 40 }, () => ({ x: R(0, 88), y: R(50, 88), r: R(0.4, 1.3), c: R(0.7, 1.1) }))
    st.drops = []; st.wet = 0; st.acc = 0
    st.tufts = Array.from({ length: 9 }, (_, i) => ({ x: 4 + i * 10 + R(-2, 2), h: R(8, 16), ph: R(0, TAU) }))
    st.flakes = Array.from({ length: 18 }, () => ({ x: R(0, 88), y: R(0, 44), z: R(0.3, 1) }))
  },
  draw(ctx, st, dt) {
    const t = st.t, n = st.p.niche || 'crust', pulse = 0.5 + 0.5 * Math.sin(t * 1.6)
    const cold = n === 'endolith'
    sky(ctx, cold ? '#1d3343' : '#2a4a66', cold ? '#9fb8c6' : '#d8c7a4', 0, 48)
    glow(ctx, 70, 14, 20, 'rgba(255,240,200,0.8)'); ctx.fillStyle = '#fff6dc'; ctx.beginPath(); ctx.arc(70, 14, 3.6, 0, TAU); ctx.fill()
    const soil = ctx.createLinearGradient(0, 48, 0, 88)
    soil.addColorStop(0, cold ? '#6d6a66' : '#a48a66'); soil.addColorStop(1, cold ? '#2c2a28' : '#4a3a2a')
    ctx.fillStyle = soil; ctx.fillRect(0, 48, 88, 40)
    st.grains.forEach(g => { ctx.fillStyle = `rgba(${cold ? '150,146,140' : '196,170,130'},${0.35 * g.c})`; ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, TAU); ctx.fill() })
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 48, 88, 0.8)
    if (n === 'hypolith') {
      // light passes through a quartz stone and feeds a green film on its underside
      ctx.globalCompositeOperation = 'lighter'
      st.rays.forEach(r => { const a = 0.08 + 0.08 * Math.sin(t * 2 + r.ph); ctx.strokeStyle = `rgba(255,244,210,${a})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r.x + 18, 4); ctx.lineTo(r.x, 52); ctx.stroke() })
      ctx.globalCompositeOperation = 'source-over'
      const sg = ctx.createLinearGradient(26, 40, 62, 56); sg.addColorStop(0, 'rgba(236,236,230,0.85)'); sg.addColorStop(1, 'rgba(176,180,176,0.75)')
      ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(26, 52); ctx.quadraticCurveTo(30, 38, 46, 39); ctx.quadraticCurveTo(62, 40, 62, 52); ctx.quadraticCurveTo(44, 56, 26, 52); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(32, 45); ctx.quadraticCurveTo(40, 41, 50, 42); ctx.stroke()
      st.cells.forEach(c => { glow(ctx, c.x, c.y, 2.2, 'rgba(110,200,90,0.9)', 0.4 + 0.5 * Math.abs(Math.sin(t * 1.3 + c.ph))); ctx.fillStyle = '#5fae4a'; ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, TAU); ctx.fill() })
    } else if (cold) {
      // a sandstone block; a green band a few millimetres inside it, snow drifting past
      const rg = ctx.createLinearGradient(0, 26, 0, 74); rg.addColorStop(0, '#c9bba4'); rg.addColorStop(1, '#8e8170')
      ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(14, 74); ctx.lineTo(18, 30); ctx.quadraticCurveTo(44, 24, 72, 30); ctx.lineTo(76, 74); ctx.fill()
      ctx.fillStyle = '#eef3f6'; ctx.beginPath(); ctx.moveTo(18, 31); ctx.quadraticCurveTo(44, 24, 72, 31); ctx.quadraticCurveTo(44, 28, 18, 33); ctx.fill()
      ctx.fillStyle = `rgba(90,170,80,${0.55 + 0.35 * pulse})`; ctx.beginPath(); ctx.moveTo(18.4, 36); ctx.quadraticCurveTo(44, 30, 71.6, 36); ctx.lineTo(71.8, 38.4); ctx.quadraticCurveTo(44, 32.6, 18.2, 38.4); ctx.fill()
      ctx.fillStyle = 'rgba(40,40,40,0.35)'; ctx.beginPath(); ctx.moveTo(18.2, 39.6); ctx.quadraticCurveTo(44, 34, 71.8, 39.6); ctx.lineTo(71.9, 40.6); ctx.quadraticCurveTo(44, 35, 18.1, 40.6); ctx.fill()
      st.flakes.forEach(f => { f.y += (6 + 10 * f.z) * dt; f.x += 5 * f.z * dt; if (f.y > 48) { f.y = -2; f.x = R(-4, 88) } if (f.x > 90) f.x = -2; ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.6 * f.z})`; ctx.beginPath(); ctx.arc(f.x, f.y, 0.4 + 0.8 * f.z, 0, TAU); ctx.fill() })
    } else if (n === 'crust') {
      // a short shower now and then; the dark crust greens while it is wet, then dries again
      const cycle = t % 9
      if (cycle < 2) { st.acc += dt * 50; while (st.acc > 1) { st.acc--; st.drops.push({ x: R(0, 88), y: R(-6, 10), life: 0, max: 2 }) } }
      st.wet = Math.max(0, Math.min(1, st.wet + (cycle < 2.4 ? dt * 1.2 : -dt * 0.22)))
      step(st.drops, dt, q => { q.y += 90 * dt; if (q.y > 48) return false; ctx.strokeStyle = 'rgba(200,220,240,0.6)'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - 0.8, q.y - 5); ctx.stroke() })
      for (let i = 0; i < 9; i++) {
        const x = 4 + i * 9.6, w = 7 + (i % 3)
        ctx.fillStyle = rgb(lerp([58, 50, 40], [70, 120, 56], st.wet)); ctx.beginPath(); ctx.ellipse(x + 3, 49.2, w / 2, 1.8, 0, 0, TAU); ctx.fill()
        if (i % 2) { ctx.fillStyle = rgb(lerp([150, 140, 110], [170, 200, 120], st.wet)); ctx.beginPath(); ctx.arc(x + 2, 47.6, 1.1, 0, TAU); ctx.fill() }
      }
    } else {
      st.tufts.forEach(f => {
        for (let b = -2; b <= 2; b++) {
          const lean = Math.sin(t * 1.6 + f.ph + b * 0.3) * 2.2 + 1.2
          ctx.strokeStyle = b % 2 ? '#6f9a52' : '#8db866'; ctx.lineWidth = 0.9; ctx.lineCap = 'round'
          ctx.beginPath(); ctx.moveTo(f.x + b, 49); ctx.quadraticCurveTo(f.x + b + lean * 0.4, 49 - f.h * 0.6, f.x + b * 1.6 + lean, 49 - f.h + Math.abs(b)); ctx.stroke()
        }
      })
    }
    label(ctx, st.p.label, 4, 84)
  },
}

// ------------------------------------------------------------------ surface processes: the detected processes in turn
function procAeolian(ctx, st, t) {
  sky(ctx, '#2c4250', '#c99a64', 0, 60)
  const y = x => 66 - 4 * Math.sin(x * 0.12 + 1) - 2 * Math.sin(x * 0.33)
  ctx.fillStyle = '#c9965e'; ctx.beginPath(); ctx.moveTo(0, y(0)); for (let x = 0; x <= 88; x += 2) ctx.lineTo(x, y(x)); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
  ctx.strokeStyle = 'rgba(120,80,40,0.5)'; ctx.lineWidth = 0.5
  for (let r = 0; r < 6; r++) { const yy = 72 + r * 2.6; ctx.beginPath(); for (let x = 0; x <= 88; x += 2) ctx.lineTo(x, yy + Math.sin(x * 0.6 + t * 1.5 + r) * 0.6); ctx.stroke() }
  st.salt.forEach(q => { q.x = (q.x + q.v * 0.016) % 92; q.ph += 0.15; ctx.fillStyle = 'rgba(250,226,180,0.9)'; ctx.fillRect(q.x, y(q.x) - Math.abs(Math.sin(q.ph)) * q.hop, 0.9, 0.9) })
}
function procThermal(ctx, st, t) {
  const s = Math.sin(t * TAU / 4), day = C01(0.5 + s)
  sky(ctx, rgb(lerp([10, 12, 20], [70, 120, 160], day)), rgb(lerp([30, 34, 44], [180, 200, 206], day)), 0, 62)
  ctx.fillStyle = '#6a5c4c'; ctx.fillRect(0, 62, 88, 26)
  const rg = ctx.createLinearGradient(0, 34, 0, 70); rg.addColorStop(0, rgb(lerp([96, 100, 116], [176, 150, 120], day))); rg.addColorStop(1, '#4a4038')
  ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(18, 70); ctx.quadraticCurveTo(14, 40, 40, 36); ctx.quadraticCurveTo(70, 34, 72, 70); ctx.fill()
  // the crack opens a little each cycle
  const open = 0.6 + 0.5 * (1 - day)
  ctx.strokeStyle = 'rgba(20,16,14,0.9)'; ctx.lineWidth = open; ctx.beginPath(); ctx.moveTo(44, 36); ctx.lineTo(41, 46); ctx.lineTo(46, 54); ctx.lineTo(42, 70); ctx.stroke()
  ctx.lineWidth = open * 0.6; ctx.beginPath(); ctx.moveTo(41, 46); ctx.lineTo(32, 52); ctx.stroke()
  st.chips.forEach(c => { c.y = Math.min(c.max, c.y + c.v * 0.016); if (c.y >= c.max && Math.random() < 0.01) c.y = 56; ctx.fillStyle = '#5a4c40'; ctx.fillRect(c.x, c.y, 1.4, 1) })
}
function procFreeze(ctx, st, t) {
  sky(ctx, '#203646', '#a8bcc6', 0, 46)
  const g = ctx.createLinearGradient(0, 46, 0, 88); g.addColorStop(0, '#7e7a70'); g.addColorStop(1, '#4c4842')
  ctx.fillStyle = g; ctx.fillRect(0, 46, 88, 42)
  // patterned-ground polygons with ice wedges that swell in winter
  const k = 0.5 + 0.5 * Math.sin(t * TAU / 5)
  ctx.strokeStyle = `rgba(226,238,246,${0.55 + 0.4 * k})`; ctx.lineWidth = 0.8 + 1.4 * k
  const pts = [[0, 52], [20, 50], [38, 54], [58, 50], [88, 53]]
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke()
  ;[[20, 50, 16, 66], [38, 54, 44, 70], [58, 50, 66, 66], [16, 66, 6, 88], [44, 70, 40, 88], [66, 66, 76, 88], [16, 66, 44, 70], [44, 70, 66, 66]].forEach(([a, b, c, d]) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke() })
  st.sparks.forEach(f => { glow(ctx, f.x, f.y, 2.4, 'rgba(255,255,255,0.9)', k * Math.pow(Math.max(0, Math.sin(t * 2 + f.ph)), 6)) })
}
function procGlacier(ctx, st, t) {
  sky(ctx, '#1e3e52', '#b4d0de', 0, 50)
  ctx.fillStyle = '#4c4a48'; ctx.beginPath(); ctx.moveTo(0, 88); ctx.lineTo(0, 30); ctx.lineTo(22, 20); ctx.lineTo(34, 46); ctx.lineTo(54, 44); ctx.lineTo(66, 18); ctx.lineTo(88, 30); ctx.lineTo(88, 88); ctx.fill()
  const g = ctx.createLinearGradient(0, 24, 0, 88); g.addColorStop(0, '#f2f7fa'); g.addColorStop(1, '#a8cce0')
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(26, 24); ctx.quadraticCurveTo(44, 30, 62, 24); ctx.lineTo(80, 88); ctx.lineTo(8, 88); ctx.fill()
  ctx.strokeStyle = 'rgba(110,150,176,0.55)'; ctx.lineWidth = 0.6
  for (let i = 0; i < 7; i++) { const y = 30 + ((i * 9 + t * 4) % 60), w = 10 + (y - 24) * 0.55; ctx.beginPath(); ctx.moveTo(44 - w, y); ctx.quadraticCurveTo(44, y + 4, 44 + w, y); ctx.stroke() }
}
function procVolcanic(ctx, st, t) {
  sky(ctx, '#1e3440', '#6f8892', 0, 56)
  ctx.fillStyle = '#3c3836'; ctx.beginPath(); ctx.moveTo(10, 70); ctx.lineTo(36, 34); ctx.quadraticCurveTo(44, 31, 52, 34); ctx.lineTo(78, 70); ctx.fill()
  const g = ctx.createLinearGradient(0, 64, 0, 88); g.addColorStop(0, '#2c2826'); g.addColorStop(1, '#151312')
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 70); ctx.quadraticCurveTo(44, 64, 88, 70); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
  ctx.strokeStyle = 'rgba(80,72,68,0.9)'; ctx.lineWidth = 0.6
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(4 + i * 18, 74 + (i % 2) * 4); ctx.quadraticCurveTo(12 + i * 18, 72, 18 + i * 18, 78); ctx.stroke() }
  st.steam.forEach(q => { q.y -= 5 * 0.016; q.r += 0.03; if (q.y < 8) { q.y = 33; q.r = 2 } puff(ctx, 44 + Math.sin(q.y * 0.2 + t) * 2, q.y, q.r, '220,224,226', 0.35 * C01((q.y - 8) / 20)) })
}
function procWater(ctx, st, t) {
  sky(ctx, '#2a4a62', '#a8bec8', 0, 44)
  ctx.fillStyle = '#6c7a52'; ctx.fillRect(0, 44, 88, 44)
  const cx = y => 44 + Math.sin(y * 0.09) * 16
  ctx.fillStyle = '#c2ad86'; ctx.beginPath(); for (let y = 44; y <= 88; y += 2) ctx.lineTo(cx(y) - 6 - (y - 44) * 0.12, y); for (let y = 88; y >= 44; y -= 2) ctx.lineTo(cx(y) + 6 + (y - 44) * 0.12, y); ctx.fill()
  ctx.fillStyle = '#4c7a98'; ctx.beginPath(); for (let y = 44; y <= 88; y += 2) ctx.lineTo(cx(y) - 3 - (y - 44) * 0.06, y); for (let y = 88; y >= 44; y -= 2) ctx.lineTo(cx(y) + 3 + (y - 44) * 0.06, y); ctx.fill()
  st.flow.forEach(q => { q.y += q.v * 0.016; if (q.y > 88) q.y = 44; ctx.fillStyle = 'rgba(220,236,246,0.8)'; ctx.fillRect(cx(q.y) + q.o * (2 + (q.y - 44) * 0.05), q.y, 1.2, 0.5) })
}
function procNone(ctx, st, t) {
  sky(ctx, '#29475c', '#a2b8c2', 0, 60)
  st.clouds.forEach(c => { c.x = (c.x + 0.05) % 120; puff(ctx, c.x - 16, c.y, 10, '230,236,240', 0.6) })
  ctx.fillStyle = '#7c8a62'; ctx.beginPath(); ctx.moveTo(0, 62); ctx.quadraticCurveTo(44, 56, 88, 62); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
}
const PROC = { aeolian: procAeolian, thermal: procThermal, freeze: procFreeze, glacier: procGlacier, volcanic: procVolcanic, water: procWater, none: procNone }
export const PROCESSES = {
  init(st) {
    st.salt = Array.from({ length: 40 }, () => ({ x: R(0, 88), v: R(16, 30), ph: R(0, TAU), hop: R(1.5, 5) }))
    st.chips = Array.from({ length: 6 }, (_, i) => ({ x: 36 + i * 3, y: 56, v: R(4, 10), max: 70 + R(-1, 1) }))
    st.sparks = Array.from({ length: 10 }, () => ({ x: R(4, 84), y: R(50, 86), ph: R(0, TAU) }))
    st.steam = Array.from({ length: 6 }, (_, i) => ({ y: 33 - i * 4, r: 2 + i * 0.6 }))
    st.flow = Array.from({ length: 22 }, () => ({ y: R(44, 88), v: R(14, 24), o: R(-1, 1) }))
    st.clouds = [{ x: 10, y: 16 }, { x: 64, y: 24 }]
  },
  draw(ctx, st) {
    const keys = st.p.keys?.length ? st.p.keys : ['none'], names = st.p.names || []
    const span = 4.2, i = Math.floor(st.t / span) % keys.length, f = (st.t % span) / span
    const draw = PROC[keys[i]] || procNone
    draw(ctx, st, st.t)
    if (keys.length > 1 && f > 0.86) {
      // cross-fade into the next process
      ctx.globalAlpha = (f - 0.86) / 0.14; (PROC[keys[(i + 1) % keys.length]] || procNone)(ctx, st, st.t); ctx.globalAlpha = 1
    }
    label(ctx, names[i], 4, 84)
    if (keys.length > 1) keys.forEach((_, j) => { ctx.fillStyle = j === i ? '#ffffff' : 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(84 - (keys.length - 1 - j) * 4, 6, 1.1, 0, TAU); ctx.fill() })
  },
}

// ------------------------------------------------------------------ sunlight: noon Sun height at the site and on the target
// Two horizons: the Earth candidate on top, the Moon or Mars below. Each Sun climbs to its mean noon elevation and
// a mast casts its shadow, so the difference in light angle is visible at a glance.
export const SUNPATH = {
  init(st) { st.stars = starField(16, 40).map(s => ({ ...s, y: s.y + 46 })) },
  draw(ctx, st) {
    const t = st.t, p = st.p, mars = !!p.mars
    const eE = Math.max(2, 90 - Math.abs(Number.isFinite(p.earth) ? p.earth : 45)), eT = Math.max(2, 90 - Math.abs(Number.isFinite(p.target) ? p.target : 45))
    const ph = (t % 8) / 8, arc = Math.sin(ph * Math.PI)
    const pane = (y0, y1, elev, top, bottom, ground, name, star) => {
      ctx.save(); ctx.beginPath(); ctx.rect(0, y0, 88, y1 - y0); ctx.clip()
      sky(ctx, top, bottom, y0, y1 - 8)
      if (star) stars(ctx, st.stars, t)
      const hy = y1 - 8, e = elev * arc, sx = 8 + 72 * ph, sy = hy - (e / 90) * (hy - y0 - 6)
      if (arc > 0.02) { glow(ctx, sx, sy, 14, 'rgba(255,240,200,0.7)', C01(arc * 3)); ctx.fillStyle = '#fff6dc'; ctx.beginPath(); ctx.arc(sx, sy, 2.8, 0, TAU); ctx.fill() }
      ctx.setLineDash([1, 1.6]); ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 0.5; ctx.beginPath()
      for (let k = 0; k <= 20; k++) { const q = k / 20; ctx.lineTo(8 + 72 * q, hy - (elev * Math.sin(q * Math.PI) / 90) * (hy - y0 - 6)) }
      ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = ground; ctx.fillRect(0, hy, 88, 8)
      // mast and its shadow; length = height / tan(elevation)
      const mx = 44, mh = 9, len = arc > 0.02 ? Math.min(40, mh / Math.tan(Math.max(1, e) * Math.PI / 180)) : 0, dir = sx > mx ? -1 : 1
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.moveTo(mx - 0.6, hy + 1); ctx.lineTo(mx + dir * len, hy + 2.4); ctx.lineTo(mx + 0.6, hy + 1); ctx.fill()
      ctx.strokeStyle = '#ededed'; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.moveTo(mx, hy + 1); ctx.lineTo(mx, hy + 1 - mh); ctx.stroke()
      label(ctx, `${name} ${Math.round(elev)}°`, 3, y0 + 8)
      ctx.restore()
    }
    pane(0, 44, eE, '#2c5c86', '#a6c8da', '#7a6a54', p.earthName || '', false)
    if (mars) pane(44, 88, eT, '#5a4636', '#c49a72', '#8a5a3c', p.targetName || '', false)
    else pane(44, 88, eT, '#000000', '#0a0a0a', '#8c8c8c', p.targetName || '', true)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(0, 43.6, 88, 0.8)
  },
}
