// Terramechanics estimates for the explorer (phase 3, 2026-10-20): rover sinkage, rolling resistance, slip, climb limit
// and drive power (B6), and boot sinkage for footprints (A7). Screening and teaching estimates, not vehicle design.
//  - Pressure–sinkage and compaction resistance: Bekker (1969); rigid-wheel sinkage z = [3W / ((3-n)(kc + b kphi) sqrt D)]^(2/(2n+1)).
//  - Thrust: Mohr–Coulomb limit H = cA + W tan(phi); slip from the simplified Janosi–Hanamoto shear curve,
//    H/Hmax = 1 - exp(-iL/K)  ->  i = -(K/L) ln(1 - H/Hmax).
//  - Soil values (Wong 2008, Theory of Ground Vehicles; lunar values after Carrier et al. 1991, Lunar Sourcebook):
//    lunar regolith n 1, kc 1.4 kN/m^2, kphi 820 kN/m^3, c 0.17 kPa, phi 35 deg, K 1.8 cm; Mars uses the same pressure-
//    sinkage values with c 0.5 kPa and phi 33 deg (assumption); the Earth candidate uses a dry sandy loam (n 0.7,
//    kc 5.27, kphi 1515 kN, c 1.72 kPa, phi 29 deg) as a generic analogue-site soil (assumption, not measured there).
//  - Rover: 3,000 kg, 12 wheels 0.77 m x 0.30 m, drivetrain 80 %, 0.5 kW hotel load, 60 kWh battery, stability limit 30 deg
//    (design assumptions for the NASA Space Exploration Vehicle model).
const DEG = Math.PI / 180

export const SOILS = {
  moon: { key: 'moon', n: 1.0, kc: 1400, kphi: 820000, c: 170, phi: 35, K: 0.018 },
  mars: { key: 'mars', n: 1.0, kc: 1400, kphi: 820000, c: 500, phi: 33, K: 0.018 },
  earth: { key: 'earth', n: 0.7, kc: 5270, kphi: 1515040, c: 1720, phi: 29, K: 0.025 },
}
export const ROVER = { mass: 3000, wheels: 12, D: 0.766, b: 0.3, eta: 0.8, hotelW: 500, batteryWh: 60000, stabilityDeg: 30, cruise: 2.5 }

export function roverModel(body, gravity, r = ROVER) {
  const s = SOILS[body] || SOILS.moon, W = r.mass * gravity / r.wheels
  const z = Math.pow(3 * W / ((3 - s.n) * (s.kc + r.b * s.kphi) * Math.sqrt(r.D)), 2 / (2 * s.n + 1))
  const Rc = r.b * (s.kc / r.b + s.kphi) * Math.pow(z, s.n + 1) / (s.n + 1)
  const L = Math.sqrt(r.D * z), A = r.b * L * r.wheels, weight = r.mass * gravity
  const tractionRatio = (s.c * A + weight * Math.tan(s.phi * DEG)) / weight, crr = Rc * r.wheels / weight
  // steepest slope where the needed thrust stays below 97 % of the soil's limit, capped by the stability limit
  const tractionDeg = Math.asin(Math.max(-1, Math.min(1, 0.97 * tractionRatio - crr))) / DEG
  return { body, gravity, sinkage: z, crr, tractionRatio, KL: s.K / L, weight, rover: r, tractionDeg, limitDeg: Math.min(tractionDeg, r.stabilityDeg) }
}

// sinSlope > 0 uphill along the direction of travel
export function driveState(m, sinSlope) {
  const need = sinSlope + m.crr, ratio = need / m.tractionRatio
  const tooSteep = Math.asin(Math.min(1, Math.abs(sinSlope))) / DEG > m.rover.stabilityDeg
  if (ratio >= 0.97 || tooSteep) return { blocked: true, slip: 1, ratio, reason: tooSteep ? 'stability' : 'traction' }
  const slip = need <= 0 ? 0 : Math.min(0.95, -m.KL * Math.log(1 - ratio))
  return { blocked: false, slip, ratio }
}

// electrical power at wheel speed v (m/s); downhill runs on the hotel load only (no regeneration counted)
export function drivePower(m, sinSlope, v) {
  const st = driveState(m, sinSlope), F = m.weight * (m.crr + sinSlope)
  const traction = F > 0 && !st.blocked ? F * Math.abs(v) / m.rover.eta : 0
  return { ...st, power: traction + m.rover.hotelW }
}

// Drive along a polyline (window coordinates) at the cruise wheel speed: time, energy, slip and blocked length.
export function driveRoute(points, { height, body, gravity }) {
  const m = roverModel(body, gravity)
  let length = 0, time = 0, energyJ = 0, maxSlip = 0, blocked = 0, maxGrade = 0
  for (let i = 1; i < points.length; i++) {
    const [x0, z0] = points[i - 1], [x1, z1] = points[i], len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / 5))
    let hPrev = height(x0, z0)
    for (let k = 1; k <= n; k++) {
      const x = x0 + (x1 - x0) * k / n, z = z0 + (z1 - z0) * k / n, h = height(x, z), d = len / n
      if (!Number.isFinite(h) || !(d > 0)) continue
      const dh = h - hPrev, s = dh / Math.hypot(d, dh), p = drivePower(m, s, m.rover.cruise)
      hPrev = h; length += d
      maxGrade = Math.max(maxGrade, Math.abs(Math.atan2(dh, d)) / DEG)
      if (p.blocked) { blocked += d; continue }
      const v = m.rover.cruise * (1 - p.slip), dt = Math.hypot(d, dh) / Math.max(0.05, v)
      time += dt; energyJ += p.power * dt; maxSlip = Math.max(maxSlip, p.slip)
    }
  }
  const wh = energyJ / 3600
  return { length, time, energyWh: wh, whPerKm: length > 0 ? wh / (length / 1000) : 0, batteryPct: wh / m.rover.batteryWh * 100, maxSlip, blocked, maxGrade,
    limitDeg: m.limitDeg, sinkage: m.sinkage, crr: m.crr }
}

// Boot sinkage (A7): 165 kg astronaut and suit on one boot (0.12 m x 0.29 m), 1.5x body weight at heel strike, more
// on slopes where the stride pushes downhill; z = (p / (kc/b + kphi))^(1/n).
export function bootSinkage(body, gravity, slopeDeg = 0) {
  const s = SOILS[body] || SOILS.moon, b = 0.12, area = 0.12 * 0.29
  const p = 165 * gravity * 1.5 / area
  return Math.pow(p / (s.kc / b + s.kphi), 1 / s.n) * (1 + Math.min(1.5, slopeDeg / 20))
}
