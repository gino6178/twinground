// EVA route metrics for the explorer's route planner and the two-site comparison. Estimates, not mission planning:
//  - walking speed from Tobler's hiking function (1993), scaled by the body's level walking speed in the explorer
//    (Moon 0.9, Mars 1.1, Earth 1.4 m/s; suits and low gravity slow the pace);
//  - metabolic power from the Pandolf et al. (1977) load-carriage equation, with gravity scaling: the load and
//    uphill (lifting) terms scale with g/g0, the level-walking term falls only by about a third at 0.25 g
//    (Farley & McMahon 1992, J Appl Physiol 73:2709), modelled as 0.56 + 0.44 g/g0; downhill savings are ignored;
//  - O2 shown as a share of a reference supply of 8 h at 300 W (design assumption), at 20.1 kJ per litre of O2.
export const EVA = { bodyMass: 80, refPowerW: 300, refHours: 8, kJPerLitreO2: 20.1, g0: 9.81, terrain: 1.2 }

export function metabolicPower(v, grade, g, load = 30) {
  const W = EVA.bodyMass, L = load, r = g / EVA.g0
  const G = Math.max(0, grade) * 100
  const walk = 0.56 + 0.44 * r
  return 1.5 * W + 2.0 * (W + L) * (L / W) ** 2 * r + EVA.terrain * (W + L) * (1.5 * v * v * walk + 0.35 * v * G * r)
}

// Tobler: 6 exp(-3.5 |S + 0.05|) km/h, S = dh/dx.
export const toblerSpeed = grade => 6 * Math.exp(-3.5 * Math.abs(grade + 0.05)) / 3.6

export const o2Percent = joules => joules / (EVA.refPowerW * EVA.refHours * 3600) * 100

// Points along a polyline at most `step` metres apart (the step grows on very long routes).
export function sampleRoute(points, step = 2) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  const s = Math.max(step, total / 6000), out = []
  for (let i = 0; i < points.length; i++) {
    if (i === 0) { out.push([points[0][0], points[0][1], 0, 0]); continue }
    const [x0, z0] = points[i - 1], [x1, z1] = points[i], len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / s))
    for (let k = 1; k <= n; k++) out.push([x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n, i, k === n ? 1 : 0])
  }
  return out
}

// Walk a polyline over a height function; returns energy, time and slope statistics.
function walk(points, height, gravity, load, speedScale = 1) {
  const S = sampleRoute(points)
  let dist = 0, up = 0, down = 0, time = 0, energy = 0, prevH = height(S[0][0], S[0][1])
  const segs = []
  for (let i = 1; i < S.length; i++) {
    const h = height(S[i][0], S[i][1]), dd = Math.hypot(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1])
    if (!(dd > 0) || !Number.isFinite(h)) { prevH = Number.isFinite(h) ? h : prevH; continue }
    const dh = h - prevH, grade = dh / dd, v = toblerSpeed(grade) * speedScale, dt = Math.hypot(dd, dh) / v
    energy += metabolicPower(v, grade, gravity, load) * dt; time += dt; dist += dd
    if (dh > 0) up += dh; else down -= dh
    segs.push({ d: dist, len: dd, grade, h, x: S[i][0], z: S[i][1], energy, waypoint: S[i][3] })
    prevH = h
  }
  return { dist, up, down, time, energy, segs, h0: height(S[0][0], S[0][1]) }
}

function weightedQuantile(values, weights, q) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b])
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  for (const i of idx) { acc += weights[i]; if (acc >= q * total) return values[i] }
  return values[idx.at(-1)] ?? 0
}

export function routeMetrics(points, { height, gravity, load = 30, sun = null, o2Start = 100, speedScale = 1 }) {
  const out = walk(points, height, gravity, load, speedScale)
  const deg = out.segs.map(s => Math.atan(Math.abs(s.grade)) * 180 / Math.PI), w = out.segs.map(s => s.len), total = out.dist || 1
  const mean = deg.reduce((a, d, i) => a + d * w[i], 0) / total
  const sd = Math.sqrt(deg.reduce((a, d, i) => a + (d - mean) ** 2 * w[i], 0) / total)
  const share = lim => deg.reduce((a, d, i) => a + (d > lim ? w[i] : 0), 0) / total
  // Walk-back: at each waypoint and every ~5 % of the route, the O2 left after the outbound leg minus the O2 needed to
  // walk straight back to the start over the same terrain.
  const start = points[0], checks = out.segs.filter((s, i) => s.waypoint || i % Math.max(1, Math.round(out.segs.length / 20)) === 0)
  let minMargin = Infinity, marginAt = 0
  for (const s of checks) {
    const back = walk([[s.x, s.z], start], height, gravity, load, speedScale)
    const margin = o2Start - o2Percent(s.energy) - o2Percent(back.energy)
    if (margin < minMargin) { minMargin = margin; marginAt = s.d }
  }
  let sunLit = null
  if (sun) { let lit = 0; for (const s of out.segs) lit += (sun(s.x, s.z) > 0.5 ? s.len : 0); sunLit = lit / total }
  const step = Math.max(1, Math.floor(out.segs.length / 160))
  const profile = [[0, 0]].concat(out.segs.filter((s, i) => i % step === 0 || i === out.segs.length - 1).map(s => [s.d, s.h - out.h0]))
  return {
    length: out.dist, ascent: out.up, descent: out.down, time: out.time, energy: out.energy, avgPower: out.time ? out.energy / out.time : 0,
    o2: o2Percent(out.energy), o2End: o2Start - o2Percent(out.energy), walkbackMargin: Number.isFinite(minMargin) ? minMargin : null, walkbackAt: marginAt,
    meanGradeDeg: mean, p90GradeDeg: deg.length ? weightedQuantile(deg, w, 0.9) : 0, maxGradeDeg: deg.length ? Math.max(...deg) : 0, sdGradeDeg: sd,
    share15: share(15), share20: share(20), ascentPerKm: out.dist ? out.up / out.dist * 1000 : 0, sunLit, profile, gravity, load,
  }
}

// Terrain similarity of the same route on two sites (0-100), from the shape of the walk only. Effort and time differ
// mainly through gravity, so they are reported as ratios, not scored.
const ITEMS = [['meanGradeDeg', 2], ['p90GradeDeg', 4], ['ascentPerKm', 30], ['share15', 0.1], ['sdGradeDeg', 2]]
export function compareRoutes(a, b) {
  const items = ITEMS.map(([key, scale]) => ({ key, a: a[key], b: b[key], sim: Math.exp(-Math.abs(a[key] - b[key]) / scale) }))
  return {
    score: Math.round(100 * items.reduce((s, it) => s + it.sim, 0) / items.length), items,
    effortRatio: a.energy ? b.energy / a.energy : null, timeRatio: a.time ? b.time / a.time : null,
  }
}
