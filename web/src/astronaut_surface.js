// Illustrative sub-DEM surface for the astronaut explorer. The window DEM (hundreds of metres
// per cell) carries the measured shape; this module adds deterministic, body-typed micro-relief
// (small craters, aeolian ripples, regolith roughness) in tiles around the astronaut. None of it
// is measured, and the HUD scan reads the DEM only.
import * as THREE from 'three'

const imul = Math.imul
const hash = (x, z, s) => {
  let h = (imul(x | 0, 374761393) + imul(z | 0, 668265263) + imul(s | 0, 2147483647)) | 0
  h = imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}
const hf = (x, z, s) => (hash(x, z, s) & 0xffffff) / 0x1000000

function vnoise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z)
  let fx = x - ix, fz = z - iz
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz)
  const a = hf(ix, iz, s), b = hf(ix + 1, iz, s), c = hf(ix, iz + 1, s), d = hf(ix + 1, iz + 1, s)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
export function fbm(x, z, s, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1, norm = 0
  for (let i = 0; i < octaves; i++) { sum += amp * (vnoise(x * f, z * f, s + i * 31) - 0.5); norm += amp; amp *= 0.5; f *= 2.03 }
  return sum / norm
}

const craterCache = new Map()
function cellCraters(cx, cz, seed, cell, prob, degraded) {
  const key = ((cx + 32768) * 65536 + (cz + 32768)) * 64 + seed
  let list = craterCache.get(key)
  if (list) return list
  list = []
  let state = hash(cx, cz, seed)
  const rng = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = imul(t ^ (t >>> 15), t | 1); t ^= t + imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const n = rng() < prob ? (rng() < 0.25 ? 2 : 1) : 0
  for (let i = 0; i < n; i++) {
    const r = cell * (0.08 + Math.pow(rng(), 1.6) * 0.37)
    const fresh = degraded ? rng() * 0.35 : Math.pow(rng(), 2.2)
    // Simple craters: depth/diameter from ~0.03 (degraded) to ~0.18 (fresh); raised rim on fresh ones.
    const depth = 2 * r * (0.03 + 0.15 * fresh)
    list.push({ x: (cx + rng()) * cell, z: (cz + rng()) * cell, r, depth, rim: depth * (0.12 + 0.3 * fresh) })
  }
  if (craterCache.size > 250000) craterCache.clear()
  craterCache.set(key, list)
  return list
}
function craterField(x, z, seed, cell, prob, degraded = false) {
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell)
  let h = 0
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const c of cellCraters(cx + dx, cz + dz, seed, cell, prob, degraded)) {
      const ex = x - c.x, ez = z - c.z, d2 = (ex * ex + ez * ez) / (c.r * c.r)
      if (d2 > 5.3) continue
      const d = Math.sqrt(d2), rimTerm = c.rim * Math.exp(-(((d - 1) / 0.32) ** 2))
      h += (d < 1 ? -c.depth * (1 - d2) : 0) + rimTerm
    }
  }
  return h
}

// A5 (2026-10-20): lunar craters below the DEM resolution follow the empirical equilibrium size-frequency distribution
// of mare surfaces, N(>=D) = 10^-1.1 D^-2 per m^2 (D in m; Gault 1970, Shoemaker et al. 1970), drawn as a Poisson count
// per cell for each diameter band. Most craters in equilibrium are degraded: 15 % fresh (depth/diameter up to ~0.15, walls near the ~35 deg angle of repose, raised
// rim), the rest shallow (down to ~0.04). Positions are deterministic and illustrative, not mapped craters.
const EQ_DENSITY = Math.pow(10, -1.1)
export const LUNAR_BANDS = [
  { seed: 41, cell: 6, d1: 1.5, d2: 4 },
  { seed: 42, cell: 18, d1: 4, d2: 12 },
  { seed: 43, cell: 55, d1: 12, d2: 40 },
  { seed: 44, cell: 160, d1: 40, d2: 120 },
]
const sfdCache = new Map()
function sfdCraters(cx, cz, band) {
  const key = ((cx + 32768) * 65536 + (cz + 32768)) * 64 + band.seed
  let list = sfdCache.get(key)
  if (list) return list
  list = []
  let state = hash(cx, cz, band.seed)
  const rng = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = imul(t ^ (t >>> 15), t | 1); t ^= t + imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const a = band.d1 ** -2, b = band.d2 ** -2, lambda = EQ_DENSITY * (a - b) * band.cell * band.cell
  let n = 0, prob = 1
  const L = Math.exp(-lambda)
  for (;;) { prob *= rng(); if (prob <= L || n > 12) break; n++ }
  for (let i = 0; i < n; i++) {
    const D = Math.pow(a - rng() * (a - b), -0.5), fresh = rng() < 0.15 ? 0.6 + 0.4 * rng() : 0.35 * Math.pow(rng(), 1.5)
    const depth = D * (0.04 + 0.11 * fresh)
    list.push({ x: (cx + rng()) * band.cell, z: (cz + rng()) * band.cell, r: D / 2, D, fresh, depth, rim: depth * (0.1 + 0.3 * fresh) })
  }
  if (sfdCache.size > 250000) sfdCache.clear()
  sfdCache.set(key, list)
  return list
}
function sfdField(x, z, band) {
  const cx = Math.floor(x / band.cell), cz = Math.floor(z / band.cell)
  let h = 0
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const c of sfdCraters(cx + dx, cz + dz, band)) {
      const ex = x - c.x, ez = z - c.z, d2 = (ex * ex + ez * ez) / (c.r * c.r)
      if (d2 > 5.3) continue
      const d = Math.sqrt(d2), rimTerm = c.rim * Math.exp(-(((d - 1) / 0.32) ** 2))
      h += (d < 1 ? -c.depth * (1 - d2) : 0) + rimTerm
    }
  }
  return h
}
// Fresh craters wide enough to dig through a ~5 m mare regolith (D >= 20 m) throw out blocks; the explorer scatters
// boulders on their rims (largest block ~0.29 D^0.7, Bart & Melosh 2007). Craters whose centre lies in the rectangle.
export function blockCraters(x0, z0, x1, z1) {
  const out = []
  for (const band of LUNAR_BANDS.slice(2)) {
    for (let cx = Math.floor(x0 / band.cell); cx <= Math.floor(x1 / band.cell); cx++) for (let cz = Math.floor(z0 / band.cell); cz <= Math.floor(z1 / band.cell); cz++) {
      for (const c of sfdCraters(cx, cz, band)) if (c.D >= 20 && c.fresh >= 0.6 && c.x >= x0 && c.x < x1 && c.z >= z0 && c.z < z1) out.push(c)
    }
  }
  return out
}

// Aeolian ripples: asymmetric crests (gentle stoss, steep lee), patchy and slowly turning.
function ripples(x, z) {
  const theta = 0.7 + (vnoise(x / 90, z / 90, 71) - 0.5) * 0.9
  const c = Math.cos(theta), s = Math.sin(theta)
  const along = x * c + z * s
  const warp = fbm(x / 9, z / 9, 73, 3) * 1.6
  const p = ((along / 3.1 + warp) % 1 + 1) % 1
  const profile = p < 0.72 ? p / 0.72 : (1 - p) / 0.28
  const patch = Math.min(1, Math.max(0, (vnoise(x / 55, z / 55, 77) - 0.32) / 0.3))
  return (profile - 0.5) * 0.11 * patch
}

export function microRelief(body) {
  if (body === 'moon') return (x, z) =>
    sfdField(x, z, LUNAR_BANDS[0]) + sfdField(x, z, LUNAR_BANDS[1]) + sfdField(x, z, LUNAR_BANDS[2]) + sfdField(x, z, LUNAR_BANDS[3])
    + fbm(x / 1.4, z / 1.4, 15, 3) * 0.05 + fbm(x / 13, z / 13, 16, 4) * 0.32
  if (body === 'mars') return (x, z) =>
    ripples(x, z) + craterField(x, z, 21, 24, 0.16, true) + craterField(x, z, 22, 80, 0.2, true)
    + fbm(x / 1.6, z / 1.6, 23, 3) * 0.05 + fbm(x / 15, z / 15, 24, 4) * 0.42
  return (x, z) => fbm(x / 1.5, z / 1.5, 31, 3) * 0.07 + fbm(x / 5, z / 5, 32, 3) * 0.18 + fbm(x / 18, z / 18, 33, 4) * 0.5
}

export class NearField {
  constructor({ scene, field, micro, makeMaterial, tint, textured, mobile }) {
    this.scene = scene; this.field = field; this.micro = micro; this.tint = tint; this.textured = textured
    this.tileSize = 40; this.res = mobile ? 41 : 65; this.radius = mobile ? 1 : 2
    this.tiles = new Map(); this.material = makeMaterial(); this.center = null
    // x, z of the astronaut; fade from z to w metres (outer tile edges are always beyond w).
    this.focus = new THREE.Vector4(0, 0, mobile ? 22 : 40, mobile ? 36 : 76)
    this.farNormals = null
    this.bounds = new THREE.Vector4(1, 1, -1, -1)
    this.edgeW = mobile ? 14 : 28
  }
  height(x, z) { const k = this.fade(x, z); return this.field.height(x, z) + (k > 0 ? this.micro(x, z) * k : 0) }
  // Height as drawn: the tiles blend onto the far mesh over their outer edgeW metres; outside them the far mesh shows.
  renderHeight(x, z) {
    const b = this.bounds, f = this.field
    if (!f.farHeight) return this.height(x, z)
    if (!(b.z > b.x) || x <= b.x || x >= b.z || z <= b.y || z >= b.w) return f.farHeight(x, z)
    const d = Math.min(x - b.x, b.z - x, z - b.y, b.w - z), t = Math.min(1, d / this.edgeW), k = 1 - t * t * (3 - 2 * t)
    return this.height(x, z) + (f.farHeight(x, z) - f.height(x, z)) * k
  }
  inside(ix, iz) {
    const T = this.tileSize, half = this.field.half, x0 = ix * T, z0 = iz * T
    return !(x0 < -half - 1e-6 || z0 < -half - 1e-6 || x0 + T > half + 1e-6 || z0 + T > half + 1e-6)
  }
  // Visible ring R around the astronaut; ring R+1 is prebuilt one tile per frame so walking
  // into a new tile rarely has to build anything synchronously.
  update(px, pz) {
    const T = this.tileSize, tcx = Math.floor(px / T), tcz = Math.floor(pz / T)
    const key = tcx + ':' + tcz
    if (key === this.center) { this.prefetch(tcx, tcz); return false }
    this.center = key
    const R = this.radius, want = new Set()
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
      const ix = tcx + i, iz = tcz + j, x0 = ix * T, z0 = iz * T
      if (!this.inside(ix, iz)) continue
      const k = ix + ':' + iz
      want.add(k)
      if (!this.tiles.has(k)) this.tiles.set(k, this.build(x0, z0))
      this.tiles.get(k).visible = true
      minX = Math.min(minX, x0); minZ = Math.min(minZ, z0); maxX = Math.max(maxX, x0 + T); maxZ = Math.max(maxZ, z0 + T)
    }
    for (const [k, mesh] of this.tiles) {
      const [ix, iz] = k.split(':').map(Number)
      if (want.has(k)) continue
      if (Math.abs(ix - tcx) <= R + 1 && Math.abs(iz - tcz) <= R + 1) { mesh.visible = false; continue }
      this.scene.remove(mesh); mesh.geometry.dispose(); this.tiles.delete(k)
    }
    // The far mesh hides itself inside this rectangle so the detailed tiles show through.
    if (want.size) this.bounds.set(minX, minZ, maxX, maxZ)
    else this.bounds.set(1, 1, -1, -1)
    return true
  }
  prefetch(tcx, tcz) {
    const R = this.radius + 1
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
      const ix = tcx + i, iz = tcz + j, k = ix + ':' + iz
      if (this.tiles.has(k) || !this.inside(ix, iz)) continue
      const mesh = this.build(ix * this.tileSize, iz * this.tileSize)
      mesh.visible = false
      this.tiles.set(k, mesh)
      return
    }
  }
  // Micro-relief, its normal tilt and cavity shading fade to zero with distance from the astronaut
  // (in the vertex shader), so the outer edge of the detailed tiles meets the far DEM mesh exactly.
  fade(x, z) {
    const d = Math.hypot(x - this.focus.x, z - this.focus.y)
    const t = Math.min(1, Math.max(0, (d - this.focus.z) / (this.focus.w - this.focus.z)))
    return 1 - t * t * (3 - 2 * t)
  }
  setFocus(x, z) { this.focus.x = x; this.focus.y = z }
  // Smooth DEM normal as the far mesh shades it (bilinear in its vertex normals).
  farNormal(x, z, out) {
    const f = this.field, M = f.M, n = this.farNormals
    if (!n) { const [gx, gz] = f.gradient(x, z); const l = Math.hypot(gx, 1, gz); out[0] = -gx / l; out[1] = 1 / l; out[2] = -gz / l; return out }
    const fx = Math.min(M - 1.001, Math.max(0, (x + f.half) / f.step)), fz = Math.min(M - 1.001, Math.max(0, (z + f.half) / f.step))
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r, i = (r * M + c) * 3
    for (let k = 0; k < 3; k++) out[k] = (n[i + k] * (1 - u) + n[i + 3 + k] * u) * (1 - v) + (n[i + M * 3 + k] * (1 - u) + n[i + M * 3 + 3 + k] * u) * v
    const l = Math.hypot(out[0], out[1], out[2]) || 1
    out[0] /= l; out[1] /= l; out[2] /= l
    return out
  }
  build(x0, z0) {
    const n = this.res, T = this.tileSize, s = T / (n - 1), f = this.field, N = n + 2
    // Micro heights on a grid with a one-vertex border so slopes match across tile seams.
    const M = new Float32Array(N * N)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) M[j * N + i] = this.micro(x0 + (i - 1) * s, z0 + (j - 1) * s)
    const count = n * n
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), baseNor = new Float32Array(count * 3)
    const uv = new Float32Array(count * 2), col = new Float32Array(count * 3), micro = new Float32Array(count), ao = new Float32Array(count), farDelta = new Float32Array(count)
    const base = new THREE.Color(), tint = this.tint, bn = [0, 1, 0]
    const span = Math.max(1, f.maxH - f.minH)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const g = (j + 1) * N + (i + 1), v = j * n + i
      const x = x0 + i * s, z = z0 + j * s, hb = f.height(x, z)
      const mx = (M[g + 1] - M[g - 1]) / (2 * s), mz = (M[g + N] - M[g - N]) / (2 * s)
      this.farNormal(x, z, bn)
      // Tilt the smooth DEM normal by the micro-relief slope.
      const nx = bn[0] - mx * bn[1], ny = bn[1], nz = bn[2] - mz * bn[1], len = Math.hypot(nx, ny, nz)
      pos.set([x, hb + M[g], z], v * 3); nor.set([nx / len, ny / len, nz / len], v * 3); baseNor.set(bn, v * 3)
      micro[v] = M[g]
      farDelta[v] = f.farHeight ? f.farHeight(x, z) - hb : 0
      uv.set([(x + f.half) / f.sizeM, 1 - (z + f.half) / f.sizeM], v * 2)
      // Cavity term from the micro-relief Laplacian darkens bowls and lightens rims.
      const lap = (M[g + 1] + M[g - 1] + M[g + N] + M[g - N] - 4 * M[g]) / (s * s)
      ao[v] = Math.min(1.12, Math.max(0.62, 1 - lap * 0.9))
      if (this.textured) base.setRGB(1, 1, 1)
      else tint(base, (hb - f.minH) / span, f.slopeDeg(x, z))
      col.set([base.r, base.g, base.b], v * 3)
    }
    // No skirts: tiles share identical edge vertices and the far mesh overlaps the outer edge, so there is nothing to
    // hide; skirts showed through the seams as a dotted line.
    const index = []
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = (j + 1) * n + i, c = (j + 1) * n + i + 1, d = j * n + i + 1
      index.push(a, b, d, b, c, d)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    geometry.setAttribute('baseNormal', new THREE.BufferAttribute(baseNor, 3))
    geometry.setAttribute('micro', new THREE.BufferAttribute(micro, 1))
    geometry.setAttribute('cavity', new THREE.BufferAttribute(ao, 1))
    geometry.setAttribute('farDelta', new THREE.BufferAttribute(farDelta, 1))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const sunA = new Float32Array(count), skyA = new Float32Array(count)
    this.fillLight(pos, sunA, skyA, count)
    geometry.setAttribute('sunVis', new THREE.BufferAttribute(sunA, 1))
    geometry.setAttribute('skyVis', new THREE.BufferAttribute(skyA, 1))
    geometry.setIndex(index)
    geometry.computeBoundingSphere()
    const mesh = new THREE.Mesh(geometry, this.material)
    mesh.receiveShadow = true; mesh.castShadow = true
    this.scene.add(mesh)
    return mesh
  }
  fillLight(pos, sunA, skyA, count) {
    const light = this.light
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3], z = pos[i * 3 + 2]
      sunA[i] = light ? light.sample(light.sunVis, x, z) : 1
      skyA[i] = light ? light.sample(light.skyVis, x, z) : 1
    }
  }
  // Re-sample the terrain light fields into every tile after a new sun pass is published.
  refreshLight() {
    for (const mesh of this.tiles.values()) {
      const g = mesh.geometry, pos = g.attributes.position.array
      this.fillLight(pos, g.attributes.sunVis.array, g.attributes.skyVis.array, g.attributes.position.count)
      g.attributes.sunVis.needsUpdate = true; g.attributes.skyVis.needsUpdate = true
    }
  }
  setTexture(texture) { this.textured = !!texture; this.material.map = texture || null; this.material.needsUpdate = true; this.rebuild() }
  rebuild() { for (const [k, mesh] of this.tiles) { this.scene.remove(mesh); mesh.geometry.dispose() } this.tiles.clear(); const c = this.center; this.center = null; if (c) { const [x, z] = c.split(':').map(Number); this.update(x * this.tileSize + 1, z * this.tileSize + 1) } }
  dispose() { for (const mesh of this.tiles.values()) { this.scene.remove(mesh); mesh.geometry.dispose() } this.tiles.clear(); this.material.dispose() }
}
