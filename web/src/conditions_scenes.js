// Canvas 2D particle scenes for the condition cards. Every scene draws in an 88 x 88 unit box; `st.p` holds the
// candidate's value, `st.t` the running time in seconds. Intensities follow the data (rain from aridity, snowflakes
// from the cold share, lava only when a basaltic volcano is within 60 km, and so on).
const R = (a, b) => a + Math.random() * (b - a)
const C01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
const TAU = Math.PI * 2

function sky(ctx, top, bottom, y1 = 88) {
  const g = ctx.createLinearGradient(0, 0, 0, y1)
  g.addColorStop(0, top); g.addColorStop(1, bottom)
  ctx.fillStyle = g; ctx.fillRect(0, 0, 88, y1)
}
function glow(ctx, x, y, r, color, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = alpha; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.globalAlpha = 1
}
function puff(ctx, x, y, r, rgb, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(0.6, `rgba(${rgb},${a * 0.45})`); g.addColorStop(1, `rgba(${rgb},0)`)
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill()
}
function step(list, dt, fn) { for (let i = list.length - 1; i >= 0; i--) { const q = list[i]; q.life += dt; if (fn(q) === false || q.life > q.max) list.splice(i, 1) } }

// ------------------------------------------------------------------ fire bed (under the WebGL flame)
export const FIRE_BED = {
  init(st) {
    st.sparks = []; st.acc = 0
    st.logs = [[18, 78, 62, 70, 4.2], [26, 70, 70, 79, 3.8], [36, 81, 54, 74, 3.2]]
    st.cracks = st.logs.map(() => Array.from({ length: 4 }, () => [R(0.15, 0.85), R(-1, 1)]))
  },
  draw(ctx, st, dt) {
    const t = st.t, f = 0.75 + 0.25 * Math.sin(t * 13) * Math.sin(t * 7.3 + 1)
    sky(ctx, '#0b1a1e', '#1c1410')
    glow(ctx, 44, 66, 46, 'rgba(255,120,40,0.55)', f)
    ctx.fillStyle = '#2a1d16'; ctx.fillRect(0, 80, 88, 8)
    glow(ctx, 44, 82, 26, 'rgba(255,140,50,0.5)', f)
    st.logs.forEach(([x1, y1, x2, y2, w], i) => {
      ctx.lineCap = 'round'; ctx.strokeStyle = '#2b1a12'; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
      ctx.strokeStyle = `rgba(255,${120 + 60 * f | 0},40,${0.55 + 0.4 * f})`; ctx.lineWidth = 0.8
      st.cracks[i].forEach(([k, o]) => { const x = x1 + (x2 - x1) * k, y = y1 + (y2 - y1) * k; ctx.beginPath(); ctx.moveTo(x - 1.5, y + o); ctx.lineTo(x + 1.5, y - o * 0.5); ctx.stroke() })
    })
    st.acc += dt * 14 * st.p.power
    while (st.acc > 1) { st.acc--; st.sparks.push({ x: R(34, 54), y: R(56, 66), vx: R(-6, 6), vy: R(-34, -18), life: 0, max: R(0.8, 1.8), ph: R(0, TAU) }) }
    ctx.globalCompositeOperation = 'lighter'
    step(st.sparks, dt, q => {
      q.vx += Math.sin(t * 6 + q.ph) * 30 * dt; q.vy += 6 * dt; q.x += q.vx * dt; q.y += q.vy * dt
      const a = 1 - q.life / q.max
      ctx.fillStyle = `rgba(255,${170 + 60 * a | 0},90,${a})`; ctx.fillRect(q.x, q.y, 0.9, 0.9)
      glow(ctx, q.x + 0.4, q.y + 0.4, 2.2, 'rgba(255,120,40,0.5)', a)
    })
    ctx.globalCompositeOperation = 'source-over'
  },
}

// 2D fallback flame when WebGL is unavailable: additive soft particles
export const FIRE_2D = {
  init(st) { FIRE_BED.init(st); st.parts = []; st.facc = 0 },
  draw(ctx, st, dt) {
    FIRE_BED.draw(ctx, st, dt)
    st.facc += dt * 90
    while (st.facc > 1) { st.facc--; st.parts.push({ x: 44 + R(-12, 12), y: 74, vx: R(-4, 4), vy: R(-38, -22), r: R(5, 8), life: 0, max: R(0.5, 0.9) }) }
    ctx.globalCompositeOperation = 'lighter'
    step(st.parts, dt, q => {
      q.vx += (44 - q.x) * 2.2 * dt; q.x += q.vx * dt; q.y += q.vy * dt
      const a = 1 - q.life / q.max, r = q.r * (0.4 + a * 0.6)
      puff(ctx, q.x, q.y, r, a > 0.6 ? '255,210,120' : a > 0.3 ? '255,120,40' : '200,50,20', 0.22 * a)
    })
    ctx.globalCompositeOperation = 'source-over'
  },
}

// ------------------------------------------------------------------ partly dry: puddle evaporating in the sun
export const STEAM = {
  init(st) {
    st.parts = []; st.acc = 0
    st.cracks = Array.from({ length: 14 }, () => { const x = R(0, 88), y = R(70, 88); return [x, y, x + R(-8, 8), y + R(-3, 3)] })
  },
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#1f3a40', '#5a4a34', 70)
    glow(ctx, 70, 14, 30, 'rgba(255,214,130,0.75)')
    ctx.fillStyle = '#fff1c4'; ctx.beginPath(); ctx.arc(70, 14, 5, 0, TAU); ctx.fill()
    const gg = ctx.createLinearGradient(0, 68, 0, 88); gg.addColorStop(0, '#8a6c4c'); gg.addColorStop(1, '#5b4632')
    ctx.fillStyle = gg; ctx.fillRect(0, 68, 88, 20)
    ctx.strokeStyle = '#4a3726'; ctx.lineWidth = 0.7
    st.cracks.forEach(([a, b, c, d]) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke() })
    const k = 0.5 + 0.5 * Math.cos(t * TAU / 8), rx = 9 + 11 * k
    const pg = ctx.createRadialGradient(42, 76, 1, 44, 76, rx)
    pg.addColorStop(0, '#9fd3f0'); pg.addColorStop(0.7, '#5d9bc4'); pg.addColorStop(1, '#3d6f8e')
    ctx.fillStyle = pg; ctx.beginPath(); ctx.ellipse(44, 76, rx, rx * 0.24, 0, 0, TAU); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.ellipse(40, 75, rx * 0.5, rx * 0.08, 0, Math.PI * 1.1, Math.PI * 1.8); ctx.stroke()
    st.acc += dt * (4 + 10 * k)
    while (st.acc > 1) { st.acc--; st.parts.push({ x: 44 + R(-rx, rx) * 0.8, y: 74, r: R(1.5, 3), life: 0, max: R(1.8, 3), ph: R(0, TAU) }) }
    step(st.parts, dt, q => {
      q.y -= 13 * dt; q.r += 4.5 * dt; q.x += Math.sin(t * 1.7 + q.ph) * 5 * dt + 2 * dt
      const a = Math.min(1, q.life * 2.5) * (1 - q.life / q.max)
      puff(ctx, q.x, q.y, q.r, '235,244,250', 0.32 * a)
    })
  },
}

// ------------------------------------------------------------------ wet: rain with splashes and ripples
export const RAIN = {
  init(st) {
    const n = 40 + Math.round(40 * C01((st.p.aridity - 0.5) / 1.0))
    st.drops = Array.from({ length: n }, () => ({ x: R(-14, 92), y: R(-20, 76), v: R(105, 150), l: R(5, 9), a: R(0.25, 0.6) }))
    st.bits = []; st.rings = []
    st.clouds = Array.from({ length: 5 }, (_, i) => ({ x: i * 24 - 6, y: R(6, 16), r: R(12, 18) }))
  },
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#2a3946', '#18262d')
    st.clouds.forEach(c => { const x = ((c.x + t * 3) % 120) - 16; puff(ctx, x, c.y, c.r, '120,138,154', 0.75); puff(ctx, x + 6, c.y + 4, c.r * 0.8, '92,108,122', 0.7) })
    const pg = ctx.createLinearGradient(0, 76, 0, 88); pg.addColorStop(0, '#26414f'); pg.addColorStop(1, '#14252d')
    ctx.fillStyle = pg; ctx.fillRect(0, 76, 88, 12)
    ctx.lineWidth = 0.7
    st.drops.forEach(d => {
      d.y += d.v * dt; d.x += d.v * 0.16 * dt
      if (d.y > 78 + R(0, 8)) {
        if (Math.random() < 0.7) { st.rings.push({ x: d.x, y: d.y, life: 0, max: 0.7 }); for (let i = 0; i < 2; i++) st.bits.push({ x: d.x, y: d.y, vx: R(-22, 22), vy: R(-40, -18), life: 0, max: 0.4 }) }
        d.y = R(-24, -4); d.x = R(-18, 84)
      }
      ctx.strokeStyle = `rgba(190,215,240,${d.a})`; ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.l * 0.16, d.y - d.l); ctx.stroke()
    })
    step(st.rings, dt, q => { const k = q.life / q.max; ctx.strokeStyle = `rgba(170,210,235,${0.7 * (1 - k)})`; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.ellipse(q.x, q.y, 1 + 7 * k, (1 + 7 * k) * 0.28, 0, 0, TAU); ctx.stroke() })
    step(st.bits, dt, q => { q.vy += 160 * dt; q.x += q.vx * dt; q.y += q.vy * dt; ctx.fillStyle = `rgba(200,225,245,${1 - q.life / q.max})`; ctx.fillRect(q.x, q.y, 0.8, 0.8) })
  },
}

// ------------------------------------------------------------------ bare ground: wind, dust and sparse grass (or ice)
export const BARE = {
  init(st) {
    st.pebbles = Array.from({ length: 26 }, () => ({ x: R(0, 88), y: R(68, 88), r: R(0.6, 2.6) })).sort((a, b) => a.y - b.y)
    st.tufts = Array.from({ length: Math.round((1 - C01(st.p.bare)) * 7) }, (_, i) => ({ x: 8 + i * 11 + R(-3, 3), h: R(7, 13), ph: R(0, TAU) }))
    st.dust = Array.from({ length: 16 }, () => ({ x: R(0, 88), y: R(46, 84), s: R(0.4, 1), v: R(0.6, 1.3) }))
    st.haze = Array.from({ length: 3 }, (_, i) => ({ x: i * 34, y: R(54, 70) }))
  },
  draw(ctx, st, dt) {
    const t = st.t, gust = 0.45 + 0.55 * Math.max(0, Math.sin(t * 0.8) * Math.sin(t * 0.33 + 1))
    if (st.p.ice) return ICE.draw(ctx, st, dt)
    sky(ctx, '#2c4248', '#8a7a5e', 68)
    st.haze.forEach(h => { h.x = (h.x + (8 + 26 * gust) * dt) % 130; puff(ctx, h.x - 20, h.y, 22, '214,192,150', 0.1 + 0.25 * gust) })
    const g = ctx.createLinearGradient(0, 66, 0, 88); g.addColorStop(0, '#8b7558'); g.addColorStop(1, '#5d4a36')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 68); ctx.quadraticCurveTo(30, 63, 56, 67); ctx.quadraticCurveTo(74, 70, 88, 66); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
    st.pebbles.forEach(p => { ctx.fillStyle = '#4b3c2c'; ctx.beginPath(); ctx.ellipse(p.x + 0.4, p.y + 0.4, p.r, p.r * 0.6, 0, 0, TAU); ctx.fill(); ctx.fillStyle = '#a99478'; ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r, p.r * 0.6, 0, 0, TAU); ctx.fill() })
    ctx.lineCap = 'round'
    st.tufts.forEach(f => {
      for (let b = -2; b <= 2; b++) {
        const lean = (0.25 + 0.6 * gust) * f.h + Math.sin(t * 3 + f.ph + b) * 1.2
        ctx.strokeStyle = b % 2 ? '#7fa760' : '#9cc074'; ctx.lineWidth = 0.9
        ctx.beginPath(); ctx.moveTo(f.x + b, 70); ctx.quadraticCurveTo(f.x + b + lean * 0.3, 70 - f.h * 0.6, f.x + b + lean * 0.6 + b, 70 - f.h + Math.abs(b)); ctx.stroke()
      }
    })
    st.dust.forEach(d => {
      d.x += (12 + 46 * gust) * d.v * dt; d.y += Math.sin(t * 2 + d.x * 0.2) * 3 * dt
      if (d.x > 92) { d.x = -4; d.y = R(30, 82) }
      ctx.fillStyle = `rgba(222,200,160,${0.15 + 0.4 * gust})`; ctx.fillRect(d.x, d.y, d.s * (1 + 3 * gust), d.s * 0.5)
    })
  },
}
const ICE = {
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#27475a', '#a9cbdc', 60)
    const g = ctx.createLinearGradient(0, 52, 0, 88); g.addColorStop(0, '#f1f8fc'); g.addColorStop(1, '#a9d4ea')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 60); ctx.lineTo(18, 52); ctx.lineTo(34, 57); ctx.lineTo(52, 50); ctx.lineTo(70, 56); ctx.lineTo(88, 52); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
    ctx.strokeStyle = '#7fb6d3'; ctx.lineWidth = 0.8; [[20, 66, 30, 80], [48, 62, 44, 78], [66, 64, 74, 82]].forEach(([a, b, c, d]) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke() })
    st.dust.forEach(d => { d.x += 50 * d.v * dt; if (d.x > 92) { d.x = -4; d.y = R(36, 84) } ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(d.x, d.y, 2.2 * d.s, 0.6) })
    for (let i = 0; i < 4; i++) { const a = Math.pow(Math.max(0, Math.sin(t * 2.2 + i * 1.9)), 8); glow(ctx, 14 + i * 20, 60 + (i % 2) * 8, 5, 'rgba(255,255,255,0.95)', a) }
  },
}

// ------------------------------------------------------------------ cold: layered snowfall
export const SNOW = {
  init(st) {
    const n = 18 + Math.round(70 * C01(st.p.cold))
    st.flakes = Array.from({ length: n }, () => ({ x: R(0, 88), y: R(-10, 88), z: R(0.25, 1), ph: R(0, TAU) })).sort((a, b) => a.z - b.z)
    st.ridge = Array.from({ length: 12 }, (_, i) => [i * 8, R(44, 58)])
  },
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#122b3b', '#2f5568')
    ctx.fillStyle = '#284c5e'; ctx.beginPath(); ctx.moveTo(0, 88); st.ridge.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(88, 50); ctx.lineTo(88, 88); ctx.fill()
    ctx.fillStyle = '#d7e9f1'; st.ridge.forEach(([x, y], i) => { if (i % 2 === 0) { ctx.beginPath(); ctx.moveTo(x - 3, y + 3); ctx.lineTo(x, y); ctx.lineTo(x + 3, y + 3); ctx.fill() } })
    const g = ctx.createLinearGradient(0, 74, 0, 88); g.addColorStop(0, '#e9f4f9'); g.addColorStop(1, '#b7d4e2')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 76); ctx.quadraticCurveTo(22, 72, 44, 75); ctx.quadraticCurveTo(66, 78, 88, 73); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
    const wind = 4 + 6 * Math.sin(t * 0.4)
    st.flakes.forEach(f => {
      f.y += (7 + 20 * f.z) * dt; f.x += (Math.sin(t * 1.4 + f.ph) * 4 * f.z + wind * f.z) * dt
      if (f.y > 90) { f.y = -4; f.x = R(-6, 88) } if (f.x > 92) f.x = -4
      const r = 0.45 + 1.3 * f.z
      ctx.globalAlpha = 0.35 + 0.65 * f.z
      if (f.z > 0.75) puff(ctx, f.x, f.y, r * 1.8, '255,255,255', 0.9); else { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, TAU); ctx.fill() }
      ctx.globalAlpha = 1
    })
  },
}

// ------------------------------------------------------------------ frozen ground: permafrost section with glinting ice lenses
export const PERMAFROST = {
  init(st) {
    const n = 2 + Math.round(6 * C01(st.p.ice))
    st.lenses = Array.from({ length: n }, (_, i) => ({ x: 10 + ((i * 29) % 68), y: 42 + ((i * 13) % 36), rx: R(6, 11), ry: R(1.8, 3), ph: R(0, 1) }))
    st.grains = Array.from({ length: 70 }, () => [R(0, 88), R(24, 88), R(0.3, 0.9)])
    st.fog = Array.from({ length: 3 }, (_, i) => ({ x: i * 32, y: R(14, 20) }))
  },
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#3a5f72', '#a8c7d4', 22)
    st.fog.forEach(f => { f.x = (f.x + 5 * dt) % 120; puff(ctx, f.x - 16, f.y, 14, '235,245,250', 0.35) })
    ctx.fillStyle = '#6a5642'; ctx.fillRect(0, 22, 88, 10)
    const g = ctx.createLinearGradient(0, 32, 0, 88); g.addColorStop(0, '#3e5560'); g.addColorStop(1, '#22343d')
    ctx.fillStyle = g; ctx.fillRect(0, 32, 88, 56)
    st.grains.forEach(([x, y, r]) => { ctx.fillStyle = y < 32 ? '#4c3d2e' : '#5b707a'; ctx.fillRect(x, y, r, r) })
    ctx.strokeStyle = '#d6eef8'; ctx.setLineDash([2, 2]); ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, 32); ctx.lineTo(88, 32); ctx.stroke(); ctx.setLineDash([])
    // ice wedge
    ctx.fillStyle = 'rgba(190,232,248,0.55)'; ctx.beginPath(); ctx.moveTo(60, 32); ctx.lineTo(70, 32); ctx.lineTo(65, 60); ctx.fill()
    st.lenses.forEach(l => {
      ctx.save(); ctx.beginPath(); ctx.ellipse(l.x, l.y, l.rx, l.ry, 0, 0, TAU); ctx.clip()
      const lg = ctx.createLinearGradient(0, l.y - l.ry, 0, l.y + l.ry); lg.addColorStop(0, '#e4f6fd'); lg.addColorStop(1, '#7fc3e2')
      ctx.fillStyle = lg; ctx.fillRect(l.x - l.rx, l.y - l.ry, 2 * l.rx, 2 * l.ry)
      const k = ((t * 0.35 + l.ph) % 1.6) / 1.6, gx = l.x - l.rx * 1.4 + k * l.rx * 2.8
      glow(ctx, gx, l.y - l.ry * 0.3, l.rx * 0.6, 'rgba(255,255,255,0.95)')
      ctx.restore()
    })
    for (let i = 0; i < 6; i++) { const a = Math.pow(Math.max(0, Math.sin(t * 2.6 + i * 2.1)), 10); glow(ctx, 6 + i * 15, 22, 3.2, 'rgba(255,255,255,1)', a) }
  },
}

// ------------------------------------------------------------------ low sun: sun sweeping a low arc, long moving shadow
export const LOW_SUN = {
  init(st) { st.rocks = [[16, 70, 3], [70, 72, 2.4]] },
  draw(ctx, st) {
    const t = st.t, E = Math.max(4, 90 - Math.abs(Number.isFinite(st.p.lat) ? st.p.lat : 45))
    const s = Math.sin(t * TAU / 14), e = Math.max(1.5, E * (1 - s * s)), hy = 64
    const sx = 44 + 36 * s, sy = hy - 52 * e / 90
    const warm = 1 - Math.min(1, e / 35)
    const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k))
    const top = lerp([22, 62, 104], [16, 30, 52], warm), hor = lerp([150, 196, 222], [244, 150, 84], warm)
    sky(ctx, `rgb(${top})`, `rgb(${hor})`, hy)
    glow(ctx, sx, sy, 30, `rgba(255,${200 - 40 * warm | 0},${140 - 60 * warm | 0},0.75)`)
    ctx.fillStyle = `rgb(${lerp([255, 250, 225], [255, 190, 120], warm)})`; ctx.beginPath(); ctx.arc(sx, sy, 4.6, 0, TAU); ctx.fill()
    const g = ctx.createLinearGradient(0, hy, 0, 88); g.addColorStop(0, `rgb(${lerp([120, 110, 92], [150, 104, 70], warm)})`); g.addColorStop(1, '#3a2f24')
    ctx.fillStyle = g; ctx.fillRect(0, hy, 88, 24)
    // shadows point away from the sun; length = height / tan(elevation)
    const dir = sx > 44 ? -1 : 1
    const sh = (x, y, h, w) => { const l = Math.min(60, h / Math.tan(e * Math.PI / 180)); ctx.fillStyle = 'rgba(20,14,10,0.55)'; ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x + w, y); ctx.lineTo(x + dir * l + w * 0.5, y + 3); ctx.lineTo(x + dir * l - w * 0.5, y + 3); ctx.fill() }
    st.rocks.forEach(([x, y, r]) => { sh(x, y, r * 2, r); ctx.fillStyle = '#5c4c3a'; ctx.beginPath(); ctx.ellipse(x, y - r * 0.5, r * 1.3, r, 0, 0, TAU); ctx.fill() })
    sh(44, 68, 12, 1.2)
    ctx.strokeStyle = '#e8eef0'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(44, 68); ctx.lineTo(44, 56); ctx.stroke()
    ctx.fillStyle = '#ff6b5a'; ctx.beginPath(); ctx.moveTo(44, 56); ctx.lineTo(51, 58); ctx.lineTo(44, 60.5); ctx.fill()
  },
}

// ------------------------------------------------------------------ volcano: erupting when a basaltic volcano is near
export const VOLCANO = {
  init(st) { st.smoke = []; st.bombs = []; st.acc = 0; st.bacc = 0; st.clouds = [{ x: 0, y: 18 }, { x: 50, y: 10 }] },
  draw(ctx, st, dt) {
    const t = st.t, km = st.p.km, near = km <= 60, mid = km <= 150
    const f = 0.7 + 0.3 * Math.sin(t * 9) * Math.sin(t * 5.1 + 2)
    if (near) sky(ctx, '#1a1214', '#4a2216'); else if (mid) sky(ctx, '#203440', '#5a4a40'); else sky(ctx, '#1f3a48', '#6d8a95')
    if (near) glow(ctx, 44, 36, 44, 'rgba(255,90,30,0.55)', f)
    if (!mid) st.clouds.forEach(c => { c.x = (c.x + 4 * dt) % 120; puff(ctx, c.x - 16, c.y, 11, '220,230,235', 0.55) })
    st.acc += dt * (near ? 7 : mid ? 4 : 0.8)
    while (st.acc > 1) { st.acc--; st.smoke.push({ x: 44 + R(-3, 3), y: 36, r: R(3, 5), vx: R(2, 7), vy: -R(9, 15), life: 0, max: R(2.6, 4.2) }) }
    step(st.smoke, dt, q => {
      q.x += q.vx * dt; q.y += q.vy * dt; q.r += (near ? 5 : 3.5) * dt; q.vy *= 1 - 0.25 * dt
      const a = Math.min(1, q.life * 3) * (1 - q.life / q.max)
      puff(ctx, q.x, q.y, q.r, near ? '74,64,62' : '205,212,214', (near ? 0.85 : 0.5) * a)
      if (near && q.life < 0.8) puff(ctx, q.x, q.y + q.r * 0.3, q.r * 0.8, '255,110,40', 0.35 * (1 - q.life / 0.8))
    })
    const cg = ctx.createLinearGradient(0, 36, 0, 88); cg.addColorStop(0, near ? '#3a2520' : '#4d4a46'); cg.addColorStop(1, near ? '#120b09' : '#2a2725')
    ctx.fillStyle = cg; ctx.beginPath(); ctx.moveTo(2, 88); ctx.lineTo(34, 38); ctx.quadraticCurveTo(44, 34, 54, 38); ctx.lineTo(86, 88); ctx.fill()
    if (near) {
      ctx.save(); ctx.shadowColor = 'rgba(255,120,40,0.9)'; ctx.shadowBlur = 6; ctx.lineCap = 'round'
      ctx.strokeStyle = `rgba(255,${130 + 50 * f | 0},50,0.95)`; ctx.lineWidth = 1.8; ctx.setLineDash([5, 3]); ctx.lineDashOffset = -t * 14
      ctx.beginPath(); ctx.moveTo(40, 38); ctx.bezierCurveTo(36, 52, 42, 60, 34, 86); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(48, 38); ctx.bezierCurveTo(52, 50, 50, 64, 58, 86); ctx.stroke()
      ctx.setLineDash([]); ctx.restore()
      glow(ctx, 44, 37, 12, 'rgba(255,200,90,0.95)', f)
      st.bacc += dt * 16
      while (st.bacc > 1) { st.bacc--; st.bombs.push({ x: 44 + R(-3, 3), y: 37, vx: R(-24, 24), vy: R(-64, -36), life: 0, max: R(1.1, 1.8), px: 44, py: 37 }) }
      ctx.globalCompositeOperation = 'lighter'
      step(st.bombs, dt, q => {
        q.px = q.x; q.py = q.y; q.vy += 70 * dt; q.x += q.vx * dt; q.y += q.vy * dt
        if (q.y > 88) return false
        const a = 1 - q.life / q.max
        ctx.strokeStyle = `rgba(255,${120 + 100 * a | 0},50,${a})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(q.px, q.py); ctx.lineTo(q.x, q.y); ctx.stroke()
        glow(ctx, q.x, q.y, 3.2, 'rgba(255,140,50,0.8)', a)
      })
      ctx.globalCompositeOperation = 'source-over'
    } else if (mid) glow(ctx, 44, 37, 8, 'rgba(255,140,60,0.6)', 0.5 + 0.3 * f)
    if (!mid && Number.isFinite(km)) { ctx.fillStyle = '#e2eeea'; ctx.font = '700 8px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${Math.round(km).toLocaleString()} km`, 44, 30) }
  },
}

// ------------------------------------------------------------------ dunes: saltating grains and sand blown off the crest
const duneY = x => 72 - 16 * Math.exp(-Math.pow((x - 50) / 17, 2)) - 3 * Math.sin(x * 0.07)
export const DUNES = {
  init(st) {
    const k = C01(st.p.dune / 0.2)
    st.grains = Array.from({ length: 8 + Math.round(60 * k) }, () => ({ x: R(-4, 88), ph: R(0, TAU), v: R(18, 34), hop: R(2, 6) }))
    st.plume = []; st.acc = 0; st.rate = 6 + 40 * k
  },
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#23394a', '#d49a5c', 66)
    glow(ctx, 18, 30, 26, 'rgba(255,200,130,0.35)')
    ctx.fillStyle = '#a86f40'; ctx.beginPath(); ctx.moveTo(0, 62); ctx.quadraticCurveTo(22, 52, 40, 60); ctx.quadraticCurveTo(64, 66, 88, 56); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
    const g = ctx.createLinearGradient(30, 0, 70, 0); g.addColorStop(0, '#e6b97c'); g.addColorStop(0.5, '#e0b073'); g.addColorStop(0.52, '#a8743f'); g.addColorStop(1, '#94653a')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, duneY(0)); for (let x = 0; x <= 88; x += 2) ctx.lineTo(x, duneY(x)); ctx.lineTo(88, 88); ctx.lineTo(0, 88); ctx.fill()
    ctx.strokeStyle = 'rgba(160,110,60,0.45)'; ctx.lineWidth = 0.5
    for (let i = 0; i < 7; i++) { const x0 = (i * 7 + t * 1.5) % 50; ctx.beginPath(); ctx.moveTo(x0, duneY(x0) + 4); ctx.quadraticCurveTo(x0 + 3, duneY(x0 + 3) + 2.5, x0 + 6, duneY(x0 + 6) + 4); ctx.stroke() }
    st.grains.forEach(q => {
      q.x += q.v * dt; q.ph += dt * 9
      if (q.x > 90) { q.x = -4; q.ph = R(0, TAU) }
      const y = duneY(q.x) - Math.abs(Math.sin(q.ph)) * q.hop
      ctx.fillStyle = 'rgba(250,228,180,0.9)'; ctx.fillRect(q.x, y, 0.8, 0.8)
    })
    st.acc += dt * st.rate
    while (st.acc > 1) { st.acc--; st.plume.push({ x: 50 + R(-2, 2), y: duneY(50) - R(0, 1), vx: R(16, 30), vy: R(-6, 2), life: 0, max: R(0.9, 1.6) }) }
    step(st.plume, dt, q => { q.vy += 8 * dt; q.x += q.vx * dt; q.y += q.vy * dt; const a = 1 - q.life / q.max; ctx.fillStyle = `rgba(240,214,170,${0.55 * a})`; ctx.fillRect(q.x, q.y, 1.6, 0.7) })
  },
}

// ------------------------------------------------------------------ hydrated minerals: water condensing and running off a crystal
export const HYDRATED = {
  init(st) {
    const n = 1 + Math.round(6 * C01(st.p.hyd / 0.2))
    st.drops = Array.from({ length: n }, (_, i) => ({ x: 34 + ((i * 7) % 20), y: R(22, 46), r: 0.2, vy: 0, ph: R(0, 2) }))
    st.rings = []
  },
  draw(ctx, st, dt) {
    const t = st.t
    sky(ctx, '#0f2a30', '#173a40')
    glow(ctx, 44, 44, 34, 'rgba(110,200,220,0.25)')
    const face = (pts, c) => { ctx.fillStyle = c; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill() }
    face([[44, 12], [58, 22], [44, 30], [30, 22]], '#b7eef6')
    face([[30, 22], [44, 30], [44, 70], [30, 62]], '#4a9fb3')
    face([[44, 30], [58, 22], [58, 62], [44, 70]], '#2f7f93')
    ctx.save(); ctx.beginPath(); ctx.moveTo(30, 22); ctx.lineTo(44, 12); ctx.lineTo(58, 22); ctx.lineTo(58, 62); ctx.lineTo(44, 70); ctx.lineTo(30, 62); ctx.closePath(); ctx.clip()
    const k = (t * 0.3) % 1.4, bx = 20 + k * 50
    const sg = ctx.createLinearGradient(bx - 6, 0, bx + 6, 0); sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,0.45)'); sg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = sg; ctx.fillRect(bx - 6, 0, 12, 88); ctx.restore()
    ctx.fillStyle = '#123036'; ctx.fillRect(0, 76, 88, 12)
    st.drops.forEach(d => {
      if (d.r < 1.8) d.r += dt * (0.5 + d.ph * 0.3); else { d.vy += 40 * dt; d.y += d.vy * dt }
      if (d.y > 78) { st.rings.push({ x: d.x, life: 0, max: 0.8 }); d.y = R(22, 46); d.r = 0.2; d.vy = 0 }
      ctx.fillStyle = 'rgba(190,235,255,0.9)'; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r, d.r * (1 + Math.min(0.6, d.vy / 60)), 0, 0, TAU); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(d.x - d.r * 0.4, d.y - d.r * 0.5, 0.5, 0.5)
    })
    step(st.rings, dt, q => { const k2 = q.life / q.max; ctx.strokeStyle = `rgba(160,220,240,${0.8 * (1 - k2)})`; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.ellipse(q.x, 78, 1 + 6 * k2, (1 + 6 * k2) * 0.3, 0, 0, TAU); ctx.stroke() })
  },
}
