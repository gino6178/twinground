// Astronaut exploration scene for the terrain comparison. The landscape shape comes from the
// window DEM (bicubic resampled, true horizontal scale). Sub-DEM micro-relief, rocks, footprints,
// dust and surface grain are illustrative and never feed the measurements shown in the HUD.
import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { makeAstronaut } from './astronaut_model.js'
import { NearField, microRelief, fbm, blockCraters } from './astronaut_surface.js'
import { makeZ2Astronaut } from './astronaut_z2.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { gravelGeometry, withStoneDetail } from './lunar_walk_port.js'
import { TilesRenderer } from '3d-tiles-renderer'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import { createGait } from './astronaut_gait.js'
import { buildRoverTemplate, buildLrvTemplate, createVehicle } from './astronaut_rover.js'
import { createTerrainLight, LIGHT_VERTEX, lightFragmentChunks, horizonAngle } from './astronaut_lighting.js'
import * as Wx from './astronaut_weather.js'
import { routeMetrics, compareRoutes, metabolicPower, o2Percent } from './eva_route.js'
import { roverModel, driveRoute, bootSinkage, ROVER } from './terramechanics.js'

// BVH-accelerated raycasts: ground queries on the rover mesh drop from milliseconds to microseconds.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const NOISE = `
vec3 hash3(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return -1.0 + 2.0*fract(sin(p)*43758.5453123); }
float noise3(vec3 p){ vec3 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i),f), dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x), mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x), mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z); }
#ifndef FBM_OCT
#define FBM_OCT 5
#endif
float fbm3(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < FBM_OCT; i++){ s += a*noise3(p); p *= 2.03; a *= 0.5; } return s; }
`

export const WORLD_PROFILES = {
  moon: {
    gravity: 1.62, radius: 1737.4e3, walk: 0.9, run: 1.9, hop: 0.12, stride: 0.95,
    skyTop: 0x000000, skyHorizon: 0x020203, sunHalo: 0, fog: 0, fogColor: 0x000000, stars: true,
    sunColor: 0xffffff, sun: 3.6, hemiSky: 0x2b313a, hemiGround: 0x727272, hemi: 0.3, exposure: 1.0,
    dust: [0.55, 0.54, 0.51], dustDrag: 0, palette: ['#3d3d3e', '#7a7873', '#b8b5ad'], rock: ['#4f4d49', '#8e8a82'],
    print: '#262524', floaters: false, rocksPerCell: 46, suitDust: 0x77746c,
  },
  mars: {
    gravity: 3.71, radius: 3389.5e3, walk: 1.1, run: 2.3, hop: 0.08, stride: 0.9,
    skyTop: 0x9c6f4b, skyHorizon: 0xe1bf96, sunHalo: 0x9fb8d6, fog: 1 / 15000, fogColor: 0xd2a983, stars: false,
    sunColor: 0xfff0d6, sun: 2.6, hemiSky: 0xe4b98f, hemiGround: 0x7a4428, hemi: 0.6, exposure: 1.05,
    dust: [0.72, 0.47, 0.3], dustDrag: 0.9, palette: ['#55291a', '#a0583a', '#d8995f'], rock: ['#3f2419', '#7d4a33'],
    print: '#3c1d12', floaters: true, rocksPerCell: 34, suitDust: 0xa8673f,
  },
  earth: {
    gravity: 9.81, radius: 6371e3, walk: 1.4, run: 3.3, hop: 0, stride: 0.78,
    skyTop: 0x3a78c2, skyHorizon: 0xcfe2f1, sunHalo: 0xffffff, fog: 1 / 30000, fogColor: 0xc5d9ea, stars: false,
    sunColor: 0xfff3df, sun: 3.0, hemiSky: 0xbcd7f2, hemiGround: 0x5a4d3a, hemi: 0.75, exposure: 1.0,
    dust: [0.64, 0.58, 0.48], dustDrag: 2.6, palette: ['#57503f', '#9b8a69', '#d8cba9'], rock: ['#58524a', '#8d8475'],
    print: '#3d352a', floaters: false, rocksPerCell: 18, suitDust: 0x9c8a6a,
  },
}
// NASA 3D Resources models placed near the start for scale and context (conceptual placement).
const PROPS = {
  moon: { path: '/assets/lunar-walk/lunar_module.glb', width: 9.4, at: [17, -26], yaw: 0.5, name: 'Apollo Lunar Module' },
  mars: { path: '/assets/nasa3d/perseverance_rover.glb', width: 3, at: [-6, -11], yaw: -0.8, name: 'Perseverance' },
  earth: { path: '/assets/nasa3d/habitat_demo_part1.glb', width: 5, at: [15, -18], yaw: 0.3, name: 'Habitat Demonstration Unit' },
}

// Real Mars ground: Curiosity Navcam/Mastcam stereo mesh of Dingo Gap (Gale crater, sol 528),
// streamed at runtime from the NASA-AMMOS 3DTilesSampleData repository (not redistributed).
const ROVER_BASE = 'https://raw.githubusercontent.com/NASA-AMMOS/3DTilesSampleData/master/msl-dingo-gap/0528_0260184_to_s64o256_colorize/'
const ROVER_TILES = {
  ground: ROVER_BASE + '0528_0260184_to_s64o256_colorize/0528_0260184_to_s64o256_colorize_tileset.json',
  sky: ROVER_BASE + '0528_0260184_to_s64o256_sky/0528_0260184_to_s64o256_sky_tileset.json',
}
const ROVER_PROFILE = { ...WORLD_PROFILES.mars, sun: 1.5, hemi: 0.55, fog: 1 / 700, fogColor: 0xd9c2a3, rocksPerCell: 0 }

const EYE_HEIGHT = 1.68
const JUMP_SPEED = 2.2
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const lerp = (a, b, t) => a + (b - a) * t

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash2 = (x, z, s) => (Math.imul(x | 0, 73856093) ^ Math.imul(z | 0, 19349663) ^ Math.imul(s | 0, 83492791)) >>> 0

// Resample the DEM with Catmull-Rom; the rendered far mesh and the physics share one triangulation.
// detail: { n, extent, h: Float32Array (metres, NaN = no data), source, cell } - a denser DEM of the central square that
// replaces the 64 x 64 search grid there (aligned to it by the mean offset, feathered over the outer 15 %).
export function decodeDetail(api) {
  if (!api?.available) return null
  const bin = atob(api.heights_dm_b64), n = api.n, raw = new Uint16Array(n * n)
  for (let i = 0; i < n * n; i++) raw[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
  const h = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) h[i] = raw[i] === api.nodata ? NaN : api.min_m + raw[i] / 10
  return { n, extent: api.extent_m, h, source: api.source, cell: api.cell_m, credit: api.credit }
}

export function buildField(terrain, sizeM, M, exaggeration = 1, detail = null) {
  const n = terrain.size, src = terrain.heights_m
  let minSrc = Infinity
  for (const v of src) if (v < minSrc) minSrc = v
  const cell = sizeM / (n - 1)
  const at = (i, j) => src[clamp(j, 0, n - 1) * n + clamp(i, 0, n - 1)]
  const cubic = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  const row = new Float64Array(4)
  const bicubic = (fx, fz) => {
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j
    for (let d = -1; d <= 2; d++) row[d + 1] = cubic(at(i - 1, j + d), at(i, j + d), at(i + 1, j + d), at(i + 2, j + d), tx)
    return cubic(row[0], row[1], row[2], row[3], tz)
  }
  const H = new Float32Array(M * M), step = sizeM / (M - 1)
  const baseAt = (x, z) => bicubic(clamp((x + sizeM / 2) / cell, 0, n - 1), clamp((z + sizeM / 2) / cell, 0, n - 1))
  // high-resolution square: bilinear sample (metres, unexaggerated) and blend weight
  let dAt = null, dWeight = () => 0
  if (detail && detail.n > 2) {
    const dn = detail.n, dh = detail.h, dHalf = detail.extent / 2, dStep = detail.extent / (dn - 1)
    let sum = 0, cnt = 0
    for (let r = 0; r < dn; r += 2) for (let c = 0; c < dn; c += 2) {
      const v = dh[r * dn + c]
      if (Number.isFinite(v)) { sum += baseAt(-dHalf + c * dStep, -dHalf + r * dStep) - v; cnt++ }
    }
    const offset = cnt ? sum / cnt : 0
    dAt = (x, z) => {
      const fx = (x + dHalf) / dStep, fz = (z + dHalf) / dStep
      if (fx < 0 || fz < 0 || fx > dn - 1 || fz > dn - 1) return NaN
      const c = Math.min(Math.floor(fx), dn - 2), r = Math.min(Math.floor(fz), dn - 2), u = fx - c, v = fz - r
      const a = dh[r * dn + c], b = dh[r * dn + c + 1], d = dh[(r + 1) * dn + c], e = dh[(r + 1) * dn + c + 1]
      return (a * (1 - u) + b * u) * (1 - v) + (d * (1 - u) + e * u) * v + offset
    }
    const feather = dHalf * 0.15
    dWeight = (x, z) => {
      const edge = dHalf - Math.max(Math.abs(x), Math.abs(z))
      if (edge <= 0) return 0
      const t = Math.min(1, edge / feather)
      return t * t * (3 - 2 * t)
    }
  }
  let minH = Infinity, maxH = -Infinity
  for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) {
    let v = bicubic(Math.min(c * step / cell, n - 1), Math.min(r * step / cell, n - 1))
    if (dAt) { const x = -sizeM / 2 + c * step, z = -sizeM / 2 + r * step, w = dWeight(x, z); if (w > 0) { const d = dAt(x, z); if (Number.isFinite(d)) v = v * (1 - w) + d * w } }
    v *= exaggeration
    H[r * M + c] = v
    if (v < minH) minH = v
    if (v > maxH) maxH = v
  }
  const half = sizeM / 2
  const coarse = (x, z) => {
    const fx = clamp((x + half) / step, 0, M - 1.000001), fz = clamp((z + half) / step, 0, M - 1.000001)
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r
    const ha = H[r * M + c], hb = H[(r + 1) * M + c], hc = H[(r + 1) * M + c + 1], hd = H[r * M + c + 1]
    return u + v <= 1 ? ha + u * (hd - ha) + v * (hb - ha) : hc + (1 - u) * (hb - hc) + (1 - v) * (hd - hc)
  }
  // walking, driving and the near-field tiles see the full-resolution DEM inside the detail square
  const height = !dAt ? coarse : (x, z) => {
    const w = dWeight(x, z)
    if (w <= 0) return coarse(x, z)
    const d = dAt(x, z)
    return Number.isFinite(d) ? coarse(x, z) * (1 - w) + d * exaggeration * w : coarse(x, z)
  }
  const gradient = (x, z, d = Math.max(2, step * 0.5)) => [(height(x + d, z) - height(x - d, z)) / (2 * d), (height(x, z + d) - height(x, z - d)) / (2 * d)]
  // True (unexaggerated) slope of the DEM surface.
  const slopeDeg = (x, z) => { const [gx, gz] = gradient(x, z); return Math.atan(Math.hypot(gx, gz) / exaggeration) * 180 / Math.PI }
  // Absolute elevation: the API heights are offsets of the measured surface; min_m anchors them.
  const absolute = (x, z) => (Number.isFinite(terrain.min_m) ? terrain.min_m - minSrc : 0) + height(x, z) / exaggeration
  return { M, H, step, sizeM, half, minH, maxH, nativeCell: detail ? detail.cell : cell, exaggeration, height, farHeight: coarse, gradient, slopeDeg, absolute,
    detail: detail ? { source: detail.source, cell: detail.cell, extent: detail.extent } : null }
}

function noiseCanvas(size, seed, octaves = 5) {
  const rand = mulberry32(seed)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(size, size)
  const acc = new Float32Array(size * size)
  let amp = 1, total = 0
  for (let o = 0; o < octaves; o++) {
    const g = 4 << o, lattice = new Float32Array(g * g).map(() => rand())
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * g, fy = y / size * g, ix = Math.floor(fx), iy = Math.floor(fy)
      const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
      const a = lattice[(iy % g) * g + ix % g], b = lattice[(iy % g) * g + (ix + 1) % g]
      const c = lattice[((iy + 1) % g) * g + ix % g], d = lattice[((iy + 1) % g) * g + (ix + 1) % g]
      acc[y * size + x] += lerp(lerp(a, b, sx), lerp(c, d, sx), sy) * amp
    }
    total += amp; amp *= 0.55
  }
  for (let i = 0; i < acc.length; i++) {
    const v = Math.round(clamp(acc[i] / total, 0, 1) * 255)
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = v
    data.data[i * 4 + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
  return canvas
}

function footprintCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 160
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(32, 80, 10, 32, 80, 70)
  g.addColorStop(0, '#fff'); g.addColorStop(1, '#bbb')
  ctx.fillStyle = g
  ctx.beginPath(); ctx.ellipse(32, 46, 25, 40, 0, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(32, 120, 20, 30, 0, 0, Math.PI * 2); ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = 'rgba(0,0,0,0.75)'
  for (let y = 14; y < 152; y += 10) { ctx.fillRect(8, y, 48, 4) }
  return canvas
}

function flagCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 160
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0f2f3a'; ctx.fillRect(0, 0, 256, 160)
  ctx.fillStyle = '#e65a54'; ctx.fillRect(0, 128, 256, 32)
  ctx.strokeStyle = '#f5f5f5'; ctx.lineWidth = 6
  ctx.beginPath(); ctx.arc(64, 64, 34, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.arc(64, 64, 12, 0, Math.PI * 2); ctx.fillStyle = '#f5f5f5'; ctx.fill()
  ctx.fillStyle = '#ffffff'; ctx.font = '700 26px Manrope, sans-serif'
  ctx.fillText('ANALOG', 116, 58); ctx.fillText('ATLAS', 116, 90)
  return canvas
}

function glowCanvas(inner, outer) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, inner); g.addColorStop(0.12, inner); g.addColorStop(0.3, outer); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
  return canvas
}

// Value noise in world metres for grain-scale ground detail (see curvedMaterial).
const GRAIN_GLSL = `
float grainHash(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.17))) * 15731.743); }
float grainNoise(vec2 p) { vec2 c = floor(p), t = fract(p); t = t * t * (3.0 - 2.0 * t);
  return mix(mix(grainHash(c), grainHash(c + vec2(1.0, 0.0)), t.x), mix(grainHash(c + vec2(0.0, 1.0)), grainHash(c + vec2(1.0, 1.0)), t.x), t.y); }
float grainHeight(vec2 p) { return grainNoise(p * 2.3) * 0.9 + grainNoise(p * 9.0) * 0.38 + grainNoise(p * 31.0) * 0.16; }
`

// Curvature drop relative to the camera (y -= d²/2R) gives each body its real horizon distance.
// The far mesh can also cut a hole where the detailed near-field tiles take over.
function curvedMaterial(material, radius, { detail = null, hole = null, light = false, shared = null, nearFocus = null, edge = null, edgeW = 28 } = {}) {
  const chunks = light ? lightFragmentChunks() : null
  material.onBeforeCompile = shader => {
    shader.uniforms.uCurv = { value: 1 / (2 * radius) }
    shader.uniforms.uDetail = { value: detail }
    shader.uniforms.uDetailOn = { value: detail ? 1 : 0 }
    shader.uniforms.uHole = { value: hole || new THREE.Vector4(1, 1, -1, -1) }
    shader.uniforms.uWet = shared?.uWet || { value: 0 }
    shader.uniforms.uSnow = shared?.uSnow || { value: 0 }
    shared && (shader.uniforms.uPlayerSunVis = shared.uPlayerSunVis)
    shader.uniforms.uOpp = shared?.uOpp || { value: new THREE.Vector2(0, 0.06) }
    shader.uniforms.uRego = shared?.uRego || { value: new THREE.Vector4(0, 0, 0, 1) }
    if (!shared) shader.uniforms.uPlayerSunVis = { value: 1 }
    if (nearFocus) shader.uniforms.uNearFocus = { value: nearFocus }
    if (edge) { shader.uniforms.uEdge = { value: edge }; shader.uniforms.uEdgeW = { value: edgeW } }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uCurv;\nvarying vec3 vWorldPos;\nvarying float vWorldUp;' + (light ? '\n' + LIGHT_VERTEX : '') + (nearFocus ? '\nattribute float micro;\nattribute float cavity;\nattribute vec3 baseNormal;\nuniform vec4 uNearFocus;\nvarying float vCavity;\nfloat nearK = 1.0;' : '')
        + (edge ? '\nattribute float farDelta;\nuniform vec4 uEdge;\nuniform float uEdgeW;\nfloat edgeK(vec2 p) { float d = min(min(p.x - uEdge.x, uEdge.z - p.x), min(p.y - uEdge.y, uEdge.w - p.y)); return 1.0 - smoothstep(0.0, uEdgeW, d); }' : ''))
      .replace('#include <beginnormal_vertex>', nearFocus ? `#include <beginnormal_vertex>
        nearK = 1.0 - smoothstep(uNearFocus.z, uNearFocus.w, distance(position.xz, uNearFocus.xy));
        objectNormal = normalize(mix(baseNormal, objectNormal, nearK));
        vCavity = mix(1.0, cavity, nearK);` : '#include <beginnormal_vertex>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + (nearFocus ? '\ntransformed.y -= micro * (1.0 - nearK);' : '') + (edge ? '\ntransformed.y += farDelta * edgeK(position.xz);' : ''))
      .replace('#include <project_vertex>', `vec4 curvedWorld = modelMatrix * vec4(transformed, 1.0);
        vec2 curvedDelta = curvedWorld.xz - cameraPosition.xz;
        transformed.y -= dot(curvedDelta, curvedDelta) * uCurv;
        vWorldPos = curvedWorld.xyz;
        vWorldUp = normalize(mat3(modelMatrix) * objectNormal).y;
        ${light ? 'vSunVis = sunVis; vSkyVis = skyVis;' : ''}
        #include <project_vertex>`)
    let frag = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nuniform float uDetailOn;\nuniform vec4 uHole;\nuniform float uWet;\nuniform float uSnow;\nuniform float uPlayerSunVis;\nuniform vec2 uOpp;\nuniform vec4 uRego;\nvarying vec3 vWorldPos;\nvarying float vWorldUp;' + GRAIN_GLSL + (light ? '\nvarying float vSunVis;\nvarying float vSkyVis;' : '') + (nearFocus ? '\nvarying float vCavity;' : ''))
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vWorldPos.x > uHole.x + 1.0 && vWorldPos.x < uHole.z - 1.0 && vWorldPos.z > uHole.y + 1.0 && vWorldPos.z < uHole.w - 1.0) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (uDetailOn > 0.5) {
          float camDist = distance(vWorldPos, cameraPosition);
          float fine = texture2D(uDetail, vWorldPos.xz / 3.3).r;
          float mid = texture2D(uDetail, vWorldPos.xz / 37.0 + 0.37).r;
          float broad = texture2D(uDetail, vWorldPos.xz / 610.0 + 0.71).r;
          float fineFade = 1.0 - smoothstep(18.0, 90.0, camDist);
          float midFade = 1.0 - smoothstep(300.0, 1800.0, camDist);
          diffuseColor.rgb *= mix(1.0, 0.8 + fine * 0.4, fineFade * 0.7);
          diffuseColor.rgb *= mix(1.0, 0.84 + mid * 0.32, midFade * 0.7);
          diffuseColor.rgb *= 0.9 + broad * 0.2;
        }
        {
          // Grain: single grains show only where a pixel covers less than about 3 cm of ground.
          float grainFoot = max(length(dFdx(vWorldPos.xz)), length(dFdy(vWorldPos.xz)));
          float grainVis = (1.0 - smoothstep(0.008, 0.035, grainFoot)) * uRego.x;
          diffuseColor.rgb *= 1.0 + (grainHash(floor(vWorldPos.xz * 140.0)) - 0.5) * 0.24 * grainVis;
        }
        // Weather on the ground: snow settles on level ground, rain darkens it.
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.95), uSnow * smoothstep(0.8, 0.97, vWorldUp));
        diffuseColor.rgb *= 1.0 - 0.3 * uWet;${nearFocus ? '\ndiffuseColor.rgb *= vCavity;' : ''}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, uWet * 0.85);')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), uRego.z) * uRego.w;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // Grain-scale relief: clods and pebble-sized bumps a few centimetres high, visible out to a few tens of metres.
          float reliefFoot = max(length(dFdx(vWorldPos.xz)), length(dFdy(vWorldPos.xz)));
          float reliefVis = (1.0 - smoothstep(0.03, 0.3, reliefFoot)) * uRego.x * (1.0 - uSnow * 0.8);
          if (reliefVis > 0.002) {
            float h0 = grainHeight(vWorldPos.xz), hx = grainHeight(vWorldPos.xz + vec2(0.03, 0.0)), hz = grainHeight(vWorldPos.xz + vec2(0.0, 0.03));
            vec3 slope = vec3(h0 - hx, 0.0, h0 - hz) * 1.6;
            normal = normalize(normal + mat3(viewMatrix) * slope * reliefVis);
          }
        }`)
    if (light) frag = frag.replace('#include <lights_fragment_begin>', chunks.begin).replace('#include <aomap_fragment>', chunks.ao).replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        {
          // A5 opposition surge: regolith brightens toward the antisolar point as its grains hide their own shadows
          // (Hapke 1986), B(g) = B0 / (1 + tan(g/2) / h), less its value at 90 degrees so side lighting is unchanged.
          float oppCos = clamp(dot(geometryViewDir, directionalLights[0].direction), -1.0, 1.0);
          float oppTan = tan(0.5 * acos(oppCos));
          // Powder surface: light scatters among the grains, so brightness depends less on the Sun's angle than on a
          // smooth Lambert surface (Lommel-Seeliger form), which keeps shaded slopes and crater walls readable.
          float powderIn = saturate(dot(geometryNormal, directionalLights[0].direction)), powderOut = saturate(dot(geometryNormal, geometryViewDir));
          reflectedLight.directDiffuse *= mix(1.0, 0.46 + 0.54 / max(0.32, powderIn + powderOut), uRego.y);
          reflectedLight.directDiffuse *= 1.0 + uOpp.x * max(0.0, 1.0 / (1.0 + oppTan / uOpp.y) - uOpp.y / (1.0 + uOpp.y));
        }
        #endif`)
    shader.fragmentShader = frag
  }
  material.customProgramCacheKey = () => 'curved-' + radius + '-' + (detail ? 1 : 0) + '-' + (hole ? 1 : 0) + '-' + (light ? 1 : 0) + '-' + (nearFocus ? 1 : 0) + '-' + (edge ? 1 : 0)
  return material
}

// Smooth irregular rock shapes from a displaced icosphere.
function rockGeometry(seed, detail) {
  let g = new THREE.IcosahedronGeometry(1, detail)
  g.deleteAttribute('normal'); g.deleteAttribute('uv')
  g = mergeVertices(g)
  const p = g.attributes.position, v = new THREE.Vector3(), uv = new Float32Array(p.count * 2)
  const squash = 0.55 + (seed % 3) * 0.12
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize()
    uv[i * 2] = Math.atan2(v.z, v.x) / (2 * Math.PI) + 0.5; uv[i * 2 + 1] = Math.asin(clamp(v.y, -1, 1)) / Math.PI + 0.5
    let r = 1 + fbm(v.x * 1.7 + seed, v.y * 1.7 + v.z * 1.3, seed, 4) * 0.7 + fbm(v.z * 4.1, v.x * 3.7 + v.y, seed + 9, 3) * 0.18
    // Facets: a few planar cuts make the boulders look fractured rather than blobby.
    for (let k = 0; k < 3; k++) {
      const a = (seed * 7 + k * 2.1), n = new THREE.Vector3(Math.cos(a), Math.sin(a * 1.3) * 0.6, Math.sin(a)).normalize()
      const d = v.dot(n)
      if (d > 0.55) r *= 1 - (d - 0.55) * 0.55
    }
    v.multiplyScalar(r)
    if (v.y < 0) v.y *= 0.55
    v.y *= squash
    p.setXYZ(i, v.x, v.y, v.z)
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

// assets: preloaded data from the explorer's loading screen, so the scene is complete when it first appears:
//   models: { suit, rover, prop } ArrayBuffers of the GLB files; images: { target, earth } decoded surface images.
export function createAstronautEngine({ container, minimap, worlds, initial = 'target', onStats, onToast, reducedMotion = false, mobile = false, assets = {} }) {
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' })
  // Shader error checks read the info logs, which forces every compile to finish synchronously.
  renderer.debug.checkShaderErrors = false
  const dpr = Math.min(window.devicePixelRatio, mobile ? 1.25 : 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)
  renderer.domElement.setAttribute('aria-hidden', 'true')

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.2, 60000)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const disposables = []
  const keep = x => { disposables.push(x); return x }

  // Post-processing: bloom on the sun and specular glints, then grain and vignette like a camera.
  let composer = null, bloom = null, grain = null
  if (!mobile) {
    const target = new THREE.WebGLRenderTarget(container.clientWidth * dpr, container.clientHeight * dpr, { type: THREE.HalfFloatType, samples: 4 })
    composer = new EffectComposer(renderer, target)
    composer.addPass(new RenderPass(scene, camera))
    bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.45, 0.55, 1.05)
    composer.addPass(bloom)
    composer.addPass(new OutputPass())
    grain = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.03 }, uVignette: { value: 0.32 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uGrain; uniform float uVignette; varying vec2 vUv;
        float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){ vec4 c = texture2D(tDiffuse, vUv);
          c.rgb += (rand(vUv * 1000.0 + uTime) - 0.5) * uGrain;
          float v = length((vUv - 0.5) * vec2(1.15, 1.0));
          c.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.85, v);
          gl_FragColor = c; }`,
    })
    composer.addPass(grain)
    composer.setSize(container.clientWidth, container.clientHeight)
  }
  // Phones start at 80 % resolution; the controller raises or lowers it from the measured frame rate.
  let postOn = !!composer, resScale = mobile ? 0.8 : 1, quality = 'auto', fps = 60, frameAcc = 0, frameCount = 0
  let framesShown = 0, revealed = false
  const draw = () => {
    cascadeAll()
    if (composer && postOn) composer.render(); else renderer.render(scene, camera)
    // the loading screen comes off only after real frames exist (shaders compiled, shadows drawn)
    if (framesShown < 3 && ++framesShown === 2) { revealed = true; loadStage = 'done'; emitStats() }
  }
  function applyScale() {
    renderer.setPixelRatio(dpr * resScale)
    renderer.setSize(container.clientWidth, container.clientHeight)
    if (composer) { composer.setPixelRatio(dpr * resScale); composer.setSize(container.clientWidth, container.clientHeight) }
  }
  // Dynamic resolution: drop render scale, then post effects, when the frame rate sags; recover when it is smooth.
  function tuneQuality(realDt) {
    frameAcc += realDt; frameCount++
    if (frameAcc < 1.5) return
    fps = frameCount / frameAcc; frameAcc = 0; frameCount = 0
    if (quality !== 'auto') return
    const floor = mobile ? 0.5 : 0.55
    if (fps < 40 && resScale > floor) { resScale = Math.max(floor, resScale - 0.15); applyScale() }
    else if (fps < 30 && postOn) postOn = false
    else if (fps > 57 && resScale < 1) { resScale = Math.min(1, resScale + 0.1); applyScale() }
  }
  function setQuality(mode) {
    quality = mode
    if (mode === 'high') { resScale = 1; postOn = !!composer }
    else if (mode === 'low') { resScale = 0.6; postOn = false }
    else { resScale = 1; postOn = !!composer }
    sun.shadow.mapSize.set(mode === 'low' || mobile ? 1024 : 2048, mode === 'low' || mobile ? 1024 : 2048)
    sun.shadow.map?.dispose(); sun.shadow.map = null
    if (sunFar) { const s2 = mode === 'low' ? 1024 : 2048; sunFar.shadow.mapSize.set(s2, s2); sunFar.shadow.map?.dispose(); sunFar.shadow.map = null }
    applyScale()
  }

  const detailTexture = keep(new THREE.CanvasTexture(noiseCanvas(256, 20261017)))
  detailTexture.wrapS = detailTexture.wrapT = THREE.RepeatWrapping
  detailTexture.colorSpace = THREE.NoColorSpace
  const bumpTexture = keep(new THREE.CanvasTexture(noiseCanvas(256, 917, 6)))
  bumpTexture.wrapS = bumpTexture.wrapT = THREE.RepeatWrapping
  bumpTexture.colorSpace = THREE.NoColorSpace
  bumpTexture.repeat.set(3, 2)

  // Lights
  const sun = new THREE.DirectionalLight(0xffffff, 3)
  sun.castShadow = true
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048)
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 400 })
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.03
  scene.add(sun, sun.target)

  // A3: a second, coarser sun shadow for about 28-160 m, so boulders, the rover and the lander keep their shadows in
  // the middle distance. Both lights carry the full sun; every lit material weights them by distance from the
  // astronaut (casW), so each surface is lit once. Phones keep one cascade.
  const sunFar = mobile ? null : new THREE.DirectionalLight(0xffffff, 3)
  const cascade = { center: { value: new THREE.Vector3() }, range: { value: new THREE.Vector2(mobile ? 1e9 : 24, mobile ? 1e9 : 30) } }
  if (sunFar) {
    sunFar.castShadow = true; sunFar.shadow.mapSize.set(2048, 2048)
    Object.assign(sunFar.shadow.camera, { left: -165, right: 165, top: 165, bottom: -165, near: 1, far: 1000 })
    // 0.16 m texels at a grazing sun: the normal offset (0.3 m, about 0.7 m along a 26° ray) and 0.3 m of depth keep the
    // ground from shadowing itself (moire); boulders keep their shadows, pebbles beyond 30 m lose them
    sunFar.shadow.bias = -0.0003; sunFar.shadow.normalBias = 0.3
    scene.add(sunFar, sunFar.target)
  }
  function withCascade(material) {
    if (!material?.isMaterial || material.userData.cascade || !(material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial)) return material
    material.userData.cascade = true
    const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey
    material.onBeforeCompile = (shader, r) => {
      prev?.call(material, shader, r)
      shader.uniforms.uCasCenter = cascade.center; shader.uniforms.uCasRange = cascade.range
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCasW;')
        .replace('#include <project_vertex>', `vec4 casW4 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          casW4 = instanceMatrix * casW4;
          #endif
          vCasW = (modelMatrix * casW4).xyz;
          #include <project_vertex>`)
      let f = shader.fragmentShader
      if (f.includes('#include <lights_fragment_begin>')) f = f.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin)
      shader.fragmentShader = f
        .replace('#include <common>', '#include <common>\nuniform vec3 uCasCenter;\nuniform vec2 uCasRange;\nvarying vec3 vCasW;\nfloat casW(int i) { float n = 1.0 - smoothstep(uCasRange.x, uCasRange.y, distance(vCasW.xz, uCasCenter.xz)); return i == 0 ? n : (i == 1 ? 1.0 - n : 1.0); }')
        .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= casW( UNROLLED_LOOP_INDEX );')
    }
    material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|cas'
    material.needsUpdate = true
    return material
  }
  // every frame (cheap: a flag check per material) so objects added later never see both suns at full strength
  const cascadeAll = () => { if (sunFar) scene.traverse(o => { const m = o.material; if (!m) return; if (Array.isArray(m)) m.forEach(withCascade); else if (!m.userData.cascade) withCascade(m) }) }
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5)
  scene.add(hemi)
  // One headlamp for the whole session, kept outside the suit: a light inside a hidden object (first person,
  // driving) is dropped, and any change in the light set recompiles every shader in the scene.
  const lamp = new THREE.SpotLight(0xf3fbff, 0, 60, 0.45, 0.5, 1.6)
  scene.add(lamp, lamp.target)
  const lampLocal = new THREE.Vector3(0, 0.28, 0.12), lampAim = new THREE.Vector3(0, -0.6, 4), lampDir = new THREE.Vector3()
  function adoptHeadlamp(a) {
    if (!a.headlamp || a.headlamp === lamp) return
    lampLocal.copy(a.headlamp.position); lampAim.copy(a.headlamp.target.position)
    a.headlamp.target.removeFromParent(); a.headlamp.removeFromParent(); a.headlamp.dispose?.()
    a.headlamp = lamp
  }

  // Sky dome with sun disc and halo
  const skyUniforms = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, halo: { value: new THREE.Color() }, haloOn: { value: 0 }, ground: { value: new THREE.Color() }, sunset: { value: new THREE.Color() }, sunsetAmt: { value: 0 }, cloud: { value: 0 }, cloudColor: { value: new THREE.Color(1, 1, 1) }, time: { value: 0 }, wind: { value: new THREE.Vector2(1, 0.3) }, sunDisc: { value: 1 } }
  const skyMaterial = keep(new THREE.ShaderMaterial({
    uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false, defines: { FBM_OCT: mobile ? 3 : 5 },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: NOISE + `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 halo; uniform float haloOn;
      uniform vec3 sunset; uniform float sunsetAmt; uniform float cloud; uniform vec3 cloudColor; uniform float time; uniform vec2 wind; uniform float sunDisc; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = d.y; vec3 sd = normalize(sunDir);
        vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, ground, clamp(-h*6.0,0.0,1.0));
        float s = max(dot(d, sd), 0.0);
        float toward = max(dot(normalize(d.xz + 1e-5), normalize(sd.xz + 1e-5)), 0.0);
        // Twilight glow sits low on the horizon toward the Sun.
        col += sunset * sunsetAmt * pow(toward, 3.0) * (1.0 - smoothstep(0.0, 0.45, abs(h)));
        col += halo * haloOn * (pow(s, 24.0) * 0.55 + pow(s, 4.0) * 0.12);
        col += sunColor * smoothstep(0.99985, 0.99995, s) * 14.0 * sunDisc;
        if (cloud > 0.01 && h > 0.0) {
          vec2 p = d.xz / (h + 0.12) * 1.3 + wind * time * 0.004;
          float n = fbm3(vec3(p * 1.4, time * 0.003)) * 0.5 + 0.5;
          float dens = smoothstep(1.0 - cloud * 0.9, 1.15 - cloud * 0.55, n) * smoothstep(0.0, 0.12, h);
          vec3 cc = cloudColor * (0.75 + 0.35 * pow(s, 3.0)) + sunset * sunsetAmt * 0.4 * pow(toward, 2.0);
          col = mix(col, cc, clamp(dens * (0.55 + 0.45 * cloud), 0.0, 1.0));
        }
        gl_FragColor = vec4(col, 1.0); }`,
  }))
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(1000, 48, 24)), skyMaterial)
  sky.frustumCulled = false; sky.renderOrder = -10
  scene.add(sky)
  const sunSprite = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: keep(new THREE.CanvasTexture(glowCanvas('rgba(255,252,240,1)', 'rgba(255,230,190,0.18)'))), depthWrite: false, fog: false, transparent: true, blending: THREE.AdditiveBlending })))
  sunSprite.scale.setScalar(1700); sunSprite.renderOrder = -9
  scene.add(sunSprite)

  // Stars
  const starGeometry = keep(new THREE.BufferGeometry())
  {
    const rand = mulberry32(42), N = 3200, p = new Float32Array(N * 3), c = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const u = rand() * 2 - 1, t = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u)
      p.set([s * Math.cos(t) * 900, Math.abs(u) * 900, s * Math.sin(t) * 900], i * 3)
      const b = Math.pow(rand(), 2.5) * 0.9 + 0.12, warm = rand()
      c.set([b * (warm > 0.8 ? 1 : 0.85), b * 0.9, b * (warm < 0.2 ? 1 : 0.85)], i * 3)
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(p, 3))
    starGeometry.setAttribute('color', new THREE.BufferAttribute(c, 3))
  }
  const stars = new THREE.Points(starGeometry, keep(new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, depthWrite: false, fog: false, transparent: true })))
  stars.frustumCulled = false; stars.renderOrder = -8
  scene.add(stars)

  // Earth in the lunar sky. From a nearside site Earth hangs near the sub-Earth point (0°, 0°)
  // (libration ignored); it sets below the horizon on the far side. Lit by the same sun, so its
  // phase follows the sun direction chosen in settings.
  const earthTexture = keep(new THREE.TextureLoader().load('/earth-color.jpg'))
  earthTexture.colorSpace = THREE.SRGBColorSpace
  const earthGlobe = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 64, 40)), keep(new THREE.MeshStandardMaterial({ map: earthTexture, roughness: 0.85, metalness: 0, fog: false })))
  earthGlobe.renderOrder = -7
  scene.add(earthGlobe)
  const earthDirection = new THREE.Vector3()
  {
    const w = worlds.target
    if (w.body === 'moon') {
      const phi = THREE.MathUtils.degToRad(w.lat), lam = THREE.MathUtils.degToRad(w.lon)
      earthDirection.set(-Math.sin(lam), Math.cos(phi) * Math.cos(lam), Math.sin(phi) * Math.cos(lam)).normalize()
    }
  }

  // Astronaut: the NASA Z-2 model. The procedural suit is only a fallback if Z-2 fails; the explorer keeps its loading
  // screen up until the models are settled, so the user never sees one model replaced by another.
  let astro = makeAstronaut()  // fallback only: added to the scene if the Z-2 model cannot be used
  adoptHeadlamp(astro)
  let suitModel = null
  function gaitReset() { if (!astro.animate) gait.reset(astro, gaitState()) }
  // Footprints and kicked dust for the clip-driven astronaut (the procedural gait reports its own plants).
  function clipPlant(side, x, z, landing) {
    if (player.driving) return
    if (player.speedMult === 1 || landing) addFootprintAt(x, z, player.facing)
    emitDust(x, z, landing ? 14 : player.run ? 6 : 3, landing ? 0.5 : player.run ? 0.4 : 0.22)
  }
  let suitSettled = false, roverSettled = false, propPending = false
  const startedAt = performance.now()
  const modelsReady = () => {
    const ok = (suitSettled && roverSettled && !propPending) || performance.now() - startedAt > 30000
    if (ok && !astro.root.parent && !suitModel) scene.add(astro.root)  // timed out: show the fallback suit
    return ok
  }
  let lastLoadingStats = 0, warmup = null, loadStage = 'models'
  const gait = createGait({
    onPlant: (side, x, z, facing, landing) => {
      if (player.driving) return
      if (player.speedMult === 1 || landing) addFootprintAt(x, z, facing)
      emitDust(x, z, landing ? 14 : player.run ? 6 : 3, landing ? 0.5 : player.run ? 0.4 : 0.22)
    },
  })
  const shared = { uWet: { value: 0 }, uSnow: { value: 0 }, uPlayerSunVis: { value: 1 }, uOpp: { value: new THREE.Vector2(0.8, 0.06) }, uRego: { value: new THREE.Vector4(1, 1, 0.85, 1.3) } }

  // A2: objects on the terrain (suit, rover, rocks, flags, props) take the DEM sun visibility at their own position
  // from a texture of the light field, instead of dimming the sun for the whole scene when the astronaut is in shadow.
  const osv = { uOsvTex: { value: null }, uOsvStep: { value: 1 }, uOsvM: { value: 2 }, uOsvHalf: { value: 1 }, uOsvOn: { value: 0 } }
  function withObjectSun(material) {
    if (!material || material.userData?.osv || !material.isMeshStandardMaterial) return material
    material.userData.osv = true
    const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey
    material.onBeforeCompile = (shader, r) => {
      prev?.call(material, shader, r)
      Object.assign(shader.uniforms, osv)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uOsvStep;\nuniform float uOsvM;\nuniform float uOsvHalf;\nvarying vec2 vOsvUV;')
        .replace('#include <project_vertex>', `vec4 osvW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          osvW = instanceMatrix * osvW;
          #endif
          osvW = modelMatrix * osvW;
          vOsvUV = ((osvW.xz + uOsvHalf) / uOsvStep + 0.5) / uOsvM;
          #include <project_vertex>`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uOsvTex;\nuniform float uOsvOn;\nvarying vec2 vOsvUV;\nfloat osvSun = 1.0;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nosvSun = mix(1.0, texture2D(uOsvTex, clamp(vOsvUV, 0.0, 1.0)).r, uOsvOn);\ntotalEmissiveRadiance *= 0.25 + 0.75 * osvSun;')
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin).replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= osvSun;')
    }
    material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|osv'
    reflMaterials.add(material)
    material.needsUpdate = true
    return material
  }
  const objectSunTree = root => { root?.traverse(o => { if (o.isMesh) [].concat(o.material).forEach(withObjectSun) }); applyReflections() }

  // A4: object materials take the sky probe explicitly, so glossy and metal parts (visor, rover metal, lander foil)
  // reflect more strongly than matte fabric; the terrain keeps the plain scene environment.
  const reflMaterials = new Set()
  const reflBoost = m => (m.metalness >= 0.5 ? 1.6 : m.roughness < 0.35 ? 1.4 : 1)
  function applyReflections() {
    const env = scene.environment
    if (!env) return
    for (const m of reflMaterials) { m.envMap = env; m.envMapIntensity = scene.environmentIntensity * reflBoost(m) }
  }
  function bindObjectSun() {
    const w = state[active], f = w?.field, L = w?.light
    if (!w || w.kind === 'tiles' || !L || !f) { osv.uOsvOn.value = 0; return }
    if (!w.osvTex || w.osvTex.image.width !== f.M) {
      w.osvTex?.dispose()
      w.osvTex = new THREE.DataTexture(new Uint8Array(f.M * f.M), f.M, f.M, THREE.RedFormat, THREE.UnsignedByteType)
      w.osvTex.magFilter = w.osvTex.minFilter = THREE.LinearFilter; w.osvTex.unpackAlignment = 1
    }
    const d = w.osvTex.image.data, s = L.sunVis
    for (let i = 0; i < d.length; i++) d[i] = Math.round(s[i] * 255)
    w.osvTex.needsUpdate = true
    osv.uOsvTex.value = w.osvTex; osv.uOsvOn.value = 1
    osv.uOsvStep.value = f.step; osv.uOsvM.value = f.M; osv.uOsvHalf.value = f.half
  }

  // B2: the planned route, drawn as a ribbon on the ground with a pole at each waypoint; the astronaut can follow it.
  const route = { points: [], follow: false, next: 1, load: 30, driveUntil: 0 }
  const routeCurv = { value: 1 / (2 * 1737400) }
  const curveOnly = material => {
    material.onBeforeCompile = shader => {
      shader.uniforms.uCurv = routeCurv
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uCurv;')
        .replace('#include <project_vertex>', 'vec4 rcW = modelMatrix * vec4(transformed, 1.0);\nvec2 rcD = rcW.xz - cameraPosition.xz;\ntransformed.y -= dot(rcD, rcD) * uCurv;\n#include <project_vertex>')
    }
    material.customProgramCacheKey = () => 'route-curve'
    return material
  }
  const routeRibbonMaterial = keep(curveOnly(new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false })))
  const routePoleMaterial = keep(curveOnly(new THREE.MeshBasicMaterial({ color: 0xffd27a, fog: false })))
  const routePoleGeometry = keep(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6)), routeHeadGeometry = keep(new THREE.SphereGeometry(0.11, 10, 8))
  const routeGroup = new THREE.Group()
  routeGroup.renderOrder = 2
  function buildRouteMesh() {
    for (const c of [...routeGroup.children]) { routeGroup.remove(c); if (c.geometry !== routePoleGeometry && c.geometry !== routeHeadGeometry) c.geometry.dispose() }
    const w = state[active]
    if (!w || w.kind === 'tiles' || !route.points.length) return
    const f = w.field, top = (x, z) => Math.max(f.height(x, z), f.farHeight ? f.farHeight(x, z) : -Infinity)
    routeCurv.value = 1 / (2 * w.profile.radius)
    for (const [x, z] of route.points) {
      const y = top(x, z)
      const pole = new THREE.Mesh(routePoleGeometry, routePoleMaterial); pole.position.set(x, y + 0.75, z)
      const head = new THREE.Mesh(routeHeadGeometry, routePoleMaterial); head.position.set(x, y + 1.55, z)
      routeGroup.add(pole, head)
    }
    if (route.points.length < 2) return
    const pts = []
    for (let i = 1; i < route.points.length; i++) {
      const [x0, z0] = route.points[i - 1], [x1, z1] = route.points[i], len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / Math.max(1.5, len / 400)))
      for (let k = i === 1 ? 0 : 1; k <= n; k++) pts.push([x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n, (x1 - x0) / (len || 1), (z1 - z0) / (len || 1)])
    }
    const pos = new Float32Array(pts.length * 6), index = []
    pts.forEach(([x, z, dx, dz], i) => {
      const nx = -dz * 0.22, nz = dx * 0.22
      pos.set([x + nx, top(x + nx, z + nz) + 0.1, z + nz, x - nx, top(x - nx, z - nz) + 0.1, z - nz], i * 6)
      if (i) index.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i)
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(index); g.computeBoundingSphere()
    const ribbon = new THREE.Mesh(g, routeRibbonMaterial); ribbon.frustumCulled = false
    routeGroup.add(ribbon)
  }
  const nearFocusRef = new THREE.Vector4(0, 0, 40, 76)
  const nearEdgeRef = new THREE.Vector4(1, 1, -1, -1), NEAR_EDGE_W = mobile ? 14 : 28
  const nearEdgeAnim = new THREE.Vector4(1, 1, -1, -1)
  // A1: sides that grow ease outward over about a second (new detail fades in from the far surface); sides that shrink
  // follow at once, because the far mesh reappears there immediately.
  function animateEdge(dt) {
    const t = nearEdgeRef, a = nearEdgeAnim
    if (!(t.z > t.x) || !(a.z > a.x) || Math.abs(a.x - t.x) > 200 || Math.abs(a.y - t.y) > 200) { a.copy(t); return }
    const k = 1 - Math.exp(-dt / 0.45), ease = (cur, to, grow) => grow ? (Math.abs(to - cur) < 0.05 ? to : cur + (to - cur) * k) : to
    a.x = ease(a.x, t.x, t.x < a.x); a.y = ease(a.y, t.y, t.y < a.y); a.z = ease(a.z, t.z, t.z > a.z); a.w = ease(a.w, t.w, t.w > a.w)
  }
  // Soft contact shadows under the astronaut and the rover ground them on the terrain.
  const blobTexture = keep(new THREE.CanvasTexture((() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const g = x.createRadialGradient(64, 64, 4, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); return c })()))
  const blobMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: blobTexture, transparent: true, opacity: 0.5, depthWrite: false }))
  const blobGeometry = keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
  const astroBlob = new THREE.Mesh(blobGeometry, blobMaterial), roverBlob = new THREE.Mesh(blobGeometry, blobMaterial.clone())
  keep(roverBlob.material)
  astroBlob.renderOrder = 2; roverBlob.renderOrder = 2
  scene.add(astroBlob, roverBlob)

  // Weather particles: rain streaks, snowflakes and Martian dust devils.
  const RAIN = mobile ? 1200 : 2600, SNOW = mobile ? 1200 : 2400, DEVIL = 700
  const rainPos = new Float32Array(RAIN * 6), rainGeometry = keep(new THREE.BufferGeometry())
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPos, 3))
  const rain = new THREE.LineSegments(rainGeometry, keep(new THREE.LineBasicMaterial({ color: 0xb8c4cf, transparent: true, opacity: 0.32, depthWrite: false })))
  rain.frustumCulled = false; rain.visible = false; scene.add(rain)
  const snowPos = new Float32Array(SNOW * 3), snowGeometry = keep(new THREE.BufferGeometry())
  snowGeometry.setAttribute('position', new THREE.BufferAttribute(snowPos, 3))
  const snow = new THREE.Points(snowGeometry, keep(new THREE.PointsMaterial({ color: 0xffffff, size: 0.05, transparent: true, opacity: 0.85, depthWrite: false })))
  snow.frustumCulled = false; snow.visible = false; scene.add(snow)
  const devilPos = new Float32Array(DEVIL * 3), devilGeometry = keep(new THREE.BufferGeometry())
  devilGeometry.setAttribute('position', new THREE.BufferAttribute(devilPos, 3))
  const devils = new THREE.Points(devilGeometry, keep(new THREE.PointsMaterial({ color: 0xc9925f, size: 1.6, transparent: true, opacity: 0.28, depthWrite: false })))
  devils.frustumCulled = false; devils.visible = false; scene.add(devils)
  let fxSeeded = false

  // Footprints
  const PRINTS = 900
  const printTexture = keep(new THREE.CanvasTexture(footprintCanvas()))
  const printMaterial = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, alphaMap: printTexture, transparent: true, opacity: 0.6, depthWrite: false, roughness: 1 }))
  const prints = new THREE.InstancedMesh(keep(new THREE.PlaneGeometry(0.16, 0.33).rotateX(-Math.PI / 2).rotateY(Math.PI)), printMaterial, PRINTS)
  prints.count = 0; prints.receiveShadow = true; prints.frustumCulled = false
  prints.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PRINTS * 3).fill(0.016), 3)
  scene.add(prints)

  // Dust particles: ballistic on airless bodies, dragged and lingering in an atmosphere
  const DUST = 900
  const dustGeometry = keep(new THREE.BufferGeometry())
  const dustPos = new Float32Array(DUST * 3), dustCol = new Float32Array(DUST * 4), dustVel = new Float32Array(DUST * 3), dustLife = new Float32Array(DUST), dustGround = new Float32Array(DUST), dustFine = new Uint8Array(DUST)
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustCol, 4))
  const dust = new THREE.Points(dustGeometry, keep(new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, depthWrite: false })))
  dust.frustumCulled = false
  scene.add(dust)
  let dustCursor = 0

  const FLOAT = 320
  const floatGeometry = keep(new THREE.BufferGeometry())
  const floatPos = new Float32Array(FLOAT * 3)
  floatGeometry.setAttribute('position', new THREE.BufferAttribute(floatPos, 3))
  const floaters = new THREE.Points(floatGeometry, keep(new THREE.PointsMaterial({ size: 0.025, color: 0xe2b48a, transparent: true, opacity: 0.5, depthWrite: false })))
  floaters.frustumCulled = false
  scene.add(floaters)

  // Rocks: many smooth pebbles plus fewer detailed boulders
  const rockMaterial = keep(withStoneDetail(withObjectSun(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, bumpMap: bumpTexture, bumpScale: 4 })), 'rock'))
  const SMALL = mobile ? 500 : 900, LARGE = mobile ? 60 : 140
  const rockSets = [0, 1, 2].map(k => ({ small: true, cap: SMALL, mesh: new THREE.InstancedMesh(keep(rockGeometry(3 + k * 5, 1)), rockMaterial, SMALL) }))
    .concat([0, 1, 2].map(k => ({ small: false, cap: LARGE, mesh: new THREE.InstancedMesh(keep(rockGeometry(31 + k * 7, mobile ? 2 : 3)), rockMaterial, LARGE) })))
  rockSets.forEach(set => { set.mesh.count = 0; set.mesh.castShadow = !(mobile && set.small); set.mesh.receiveShadow = true; set.mesh.frustumCulled = false; scene.add(set.mesh) })
  let rockColliders = []
  let rockCellKey = ''

  // Gravel: dense centimetre-scale stones close to the astronaut. Their long shadows under a low Sun are what make
  // the ground read as real regolith. Placement is fixed by a hash of the 4 m cell, so stones never move.
  const GRAVEL = mobile ? 900 : 2600
  const gravelMaterial = keep(withStoneDetail(withObjectSun(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 })), 'gravel'))
  const gravelSets = [0, 1, 2].map(k => new THREE.InstancedMesh(keep(gravelGeometry(k, 1, (x, z, seed) => clamp(fbm(x, z, seed, 2) + 0.5, 0, 1))), gravelMaterial, GRAVEL))
  gravelSets.forEach(mesh => { mesh.count = 0; mesh.castShadow = !mobile; mesh.receiveShadow = true; mesh.frustumCulled = false; scene.add(mesh) })
  let gravelKey = ''

  // Flags
  const flagTexture = keep(new THREE.CanvasTexture(flagCanvas()))
  flagTexture.colorSpace = THREE.SRGBColorSpace
  const flagMaterial = keep(withObjectSun(new THREE.MeshStandardMaterial({ map: flagTexture, side: THREE.DoubleSide, roughness: 0.8 })))
  const poleMaterial = keep(withObjectSun(new THREE.MeshStandardMaterial({ color: 0xd9dde0, metalness: 0.7, roughness: 0.3 })))
  scene.add(routeGroup)

  // NASA models
  const draco = new DRACOLoader(); draco.setDecoderPath('/assets/draco/')
  const gltf = new GLTFLoader(); gltf.setDRACOLoader(draco); gltf.setMeshoptDecoder(MeshoptDecoder)
  const propCache = {}
  let propGroup = null, propCollider = null
  // GLB files the loading screen already downloaded are parsed from memory; anything else is fetched here.
  const loadModel = (name, url, onLoad, onError) => {
    const buffer = assets.models?.[name]
    if (buffer) { assets.models[name] = null; gltf.parse(buffer, '/assets/nasa3d/', onLoad, onError) }
    else gltf.load(url, onLoad, undefined, onError)
  }
  loadModel('suit', '/assets/nasa3d/z2_spacesuit_webp.glb', result => {
    if (disposed) return
    try {
      const z2 = makeZ2Astronaut(result.scene, { lite: mobile })
      objectSunTree(z2.root)
      adoptHeadlamp(z2)
      z2.root.position.copy(astro.root.position); z2.root.rotation.copy(astro.root.rotation); z2.root.visible = astro.root.visible
      scene.remove(astro.root); astro.dispose()
      astro = z2; suitModel = 'NASA Z-2'; scene.add(z2.root)
      gaitReset()
      astro.setDust(new THREE.Color(state[active].profile.suitDust), player.dustByWorld[active] / 1500)
    } catch { if (!astro.root.parent) scene.add(astro.root) /* procedural suit as fallback */ }
    suitSettled = true
  }, undefined, () => { if (!disposed && !astro.root.parent) scene.add(astro.root); suitSettled = true })

  // Drivable NASA Space Exploration Vehicle
  let vehicle = null, vehicleTemplate = null
  const vehiclePose = {}
  loadModel('rover', mobile ? '/assets/nasa3d/sev_rover_mobile.glb' : '/assets/nasa3d/sev_rover_desktop.glb', result => {
    if (disposed) return
    try {
      vehicleTemplate = buildRoverTemplate(result.scene); vehicle = createVehicle(vehicleTemplate, scene); objectSunTree(vehicle.group); placeVehicle()
      if (mobile) vehicle.group.traverse(o => { if (o.isMesh) o.castShadow = false })
    } catch { vehicle = null }
    roverSettled = true
  }, undefined, () => { roverSettled = true })
  function placeVehicle(near_ = 9) {
    if (!vehicle) return
    const saved = vehiclePose[active]
    // Park where the camera looks, a few steps ahead of the astronaut, so it is easy to find.
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw)
    const yaw = saved ? saved.yaw : player.yaw + Math.PI * 0.5
    const x = saved ? saved.x : player.pos.x + fx * near_ + rx * 2
    const z = saved ? saved.z : player.pos.z + fz * near_ + rz * 2
    vehicle.clearTracks()
    vehicle.place(x, z, yaw, (qx, qz) => ground(qx, qz))
  }
  function exitVehicle() {
    const st = vehicle.state
    const spots = [[0, -3.9], [3.2, -1], [-3.2, -1], [0, 4]]
    for (const [lx, lz] of spots) {
      const x = st.x + lx * Math.cos(st.yaw) + lz * Math.sin(st.yaw), z = st.z - lx * Math.sin(st.yaw) + lz * Math.cos(st.yaw)
      if (Number.isFinite(ground(x, z))) { player.pos.set(x, ground(x, z), z); break }
    }
    player.driving = false; player.dist = 5.2; player.pitch = 0.22; player.vel.set(0, 0, 0)
    player.facing = st.yaw + Math.PI
    gaitReset()
    onToast?.('exit')
  }

  // Rover-mesh world
  let roverTiles = null, roverSky = null
  const roverParent = new THREE.Group()
  roverParent.matrixAutoUpdate = false
  // Site frame (x north, y east, z down) to scene (x east, y up, z south).
  roverParent.matrix.set(0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0, 0, 1)
  scene.add(roverParent)
  const roverCache = new Map(), roverRay = new THREE.Raycaster(), roverDown = new THREE.Vector3(0, -1, 0), roverOrigin = new THREE.Vector3()
  roverRay.firstHitOnly = true
  function roverHeight(x, z) {
    const key = Math.round(x * 10) * 100000 + Math.round(z * 10)
    let h = roverCache.get(key)
    if (h !== undefined) return h
    if (!roverTiles) return NaN
    roverOrigin.set(x, 60, z); roverRay.set(roverOrigin, roverDown); roverRay.far = 160
    const hit = roverRay.intersectObject(roverTiles.group, true)[0]
    h = hit ? hit.point.y : NaN
    if (roverCache.size > 250000) roverCache.clear()
    roverCache.set(key, h)
    return h
  }
  const roverField = {
    kind: 'tiles', half: 125, sizeM: 250, minH: -12, maxH: 12, nativeCell: 0.05, exaggeration: 1,
    height: roverHeight,
    gradient(x, z, d = 0.5) {
      const a = roverHeight(x + d, z), b = roverHeight(x - d, z), c = roverHeight(x, z + d), e = roverHeight(x, z - d)
      return [Number.isFinite(a) && Number.isFinite(b) ? (a - b) / (2 * d) : 0, Number.isFinite(c) && Number.isFinite(e) ? (c - e) / (2 * d) : 0]
    },
    slopeDeg(x, z) { const [gx, gz] = this.gradient(x, z); return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI },
    absolute(x, z) { return roverHeight(x, z) },
  }
  // Photo-textured rover mesh with world-space grain near the camera, the "real data as the first
  // octave, procedural detail on top" approach: it sharpens close-up ground without inventing shape.
  function roverMaterial(map) {
    const material = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.62, roughness: 1, metalness: 0 })
    material.onBeforeCompile = shader => {
      shader.uniforms.uDetail = { value: detailTexture }
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRoverWorld;')
        .replace('#include <project_vertex>', 'vRoverWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nvarying vec3 vRoverWorld;\nfloat roverGrain = 1.0;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float roverDist = distance(vRoverWorld, cameraPosition);
          float g1 = texture2D(uDetail, vRoverWorld.xz / 0.55).r, g2 = texture2D(uDetail, vRoverWorld.xz / 2.1 + 0.3).r;
          roverGrain = mix(1.0, (0.86 + g1 * 0.28) * (0.93 + g2 * 0.14), (1.0 - smoothstep(3.0, 30.0, roverDist)) * 0.6);
          diffuseColor.rgb *= roverGrain;`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= roverGrain;')
    }
    material.customProgramCacheKey = () => 'rover-grain'
    return material
  }
  function ensureRoverTiles() {
    if (roverTiles) return
    const maxAniso = renderer.capabilities.getMaxAnisotropy()
    const prepare = (tiles, sky) => {
      tiles.fetchOptions.mode = 'cors'
      // Finer LOD on desktop; one tile decoded per frame keeps the frame rate even while streaming.
      tiles.errorTarget = mobile ? 12 : 4
      tiles.parseQueue.maxJobs = 1
      tiles.addEventListener('load-model', ({ scene: model }) => {
        model.traverse(o => {
          if (!o.isMesh) return
          const map = o.material.map
          if (map) { map.anisotropy = maxAniso; map.needsUpdate = true }
          o.material.dispose()
          // The textures are photographs, already shaded by the real Sun: keep them mostly as
          // captured and let the scene light add only a little, enough for the astronaut's shadow.
          o.material = sky ? new THREE.MeshBasicMaterial({ map, fog: false, side: THREE.DoubleSide }) : roverMaterial(map)
          o.receiveShadow = !sky; o.castShadow = false
          if (!sky) o.geometry.computeBoundsTree()
        })
        if (!sky) roverCache.clear()
      })
      tiles.addEventListener('dispose-model', ({ scene: model }) => model.traverse(o => o.geometry?.disposeBoundsTree?.()))
      roverParent.add(tiles.group)
    }
    roverTiles = new TilesRenderer(ROVER_TILES.ground); prepare(roverTiles, false)
    Object.assign(roverTiles.lruCache, { minSize: 1500, maxSize: 3000, minBytesSize: (mobile ? 0.15 : 0.5) * 2 ** 30, maxBytesSize: (mobile ? 0.25 : 0.75) * 2 ** 30 })
    roverSky = new TilesRenderer(ROVER_TILES.sky); roverSky.lruCache = roverTiles.lruCache; prepare(roverSky, true)
    roverParent.updateMatrixWorld(true)
  }

  // Per-world state
  const state = {}
  for (const key of ['target', 'earth']) {
    const w = worlds[key]
    const sizeM = w.patchKm * 1000
    const res = mobile ? 257 : sizeM <= 20000 ? 321 : 385
    state[key] = { ...w, key, profile: WORLD_PROFILES[w.body], micro: microRelief(w.body), sizeM, res, field: buildField(w.terrain, sizeM, res, 1, w.detail || null), flags: [], path: [], texture: null, textureState: w.textureUrl ? 'loading' : 'none', minimapBase: null, pendingDetail: null }
  }

  if (worlds.target.body === 'mars') {
    state.rover = { key: 'rover', body: 'mars', kind: 'tiles', label: 'Dingo Gap', lat: NaN, lon: NaN, profile: ROVER_PROFILE, micro: () => 0, sizeM: 250, field: roverField, flags: [], path: [], textureState: 'loading', ready: false, nextTry: 0 }
  }
  let active = initial
  let exaggerationNow = 1
  // Time of day per world: real season now, mid-morning by default; the weather panel changes it.
  const nowDate = new Date()
  const worldTime = {}
  for (const key of Object.keys(state)) {
    const w = state[key]
    const lon = key === 'rover' ? 137.4 : w.lon
    worldTime[key] = { hour: 10, month: Wx.earthNow(lon, nowDate).month, ls: w.body === 'mars' ? Wx.marsNow(lon, nowDate).ls : 0, speed: 0, override: 'auto' }
    // Start in the morning when the sun stands about 25 degrees high: long shadows show the relief.
    const t = worldTime[key], lat = key === 'rover' ? -4.6 : w.lat
    const decl = w.body === 'earth' ? Wx.earthDeclination(t.month) : w.body === 'mars' ? Wx.marsDeclination(t.ls) : 0
    let best = 10, err = Infinity
    for (let h = 5; h <= 11.5; h += 0.25) { const e = Math.abs(Wx.sunFrom(lat, decl, h).elevation - 25); if (e < err) { err = e; best = h } }
    t.hour = best
  }
  let climate = null, climateState = 'loading'
  const climateAbort = new AbortController()
  Wx.loadEarthClimate(worlds.earth.lat, worlds.earth.lon, climateAbort.signal).then(c => { climate = c; climateState = 'ready' }).catch(() => { if (!disposed) climateState = 'unavailable' })
  function conditionsFor(key) {
    const w = state[key], t = worldTime[key], body = w.body
    const lat = key === 'rover' ? -4.6 : w.lat
    const decl = body === 'earth' ? Wx.earthDeclination(t.month) : body === 'mars' ? Wx.marsDeclination(t.ls) : 0
    const sunPos = Wx.sunFrom(lat, decl, t.hour)
    const elevM = key === 'rover' ? -4500 : w.field.absolute(0, 0)
    const weather = body === 'earth' ? Wx.earthWeather(climate, t.month, t.hour, 15, t.override, elevM)
      : body === 'mars' ? Wx.marsWeather(lat, t.ls, t.hour, elevM, t.override) : Wx.moonWeather(sunPos.elevation)
    return { sun: sunPos, decl, weather, lat, dayLength: Wx.dayLengthHours(lat, decl, body === 'mars' ? Wx.SOL_HOURS.mars : 24) }
  }
  let current = null
  let terrainMesh = null, skirtMesh = null, outerMesh = null, boundaryLine = null, near = null
  const flagGroup = new THREE.Group(); scene.add(flagGroup)

  const player = {
    pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(), vy: 0, grounded: true, facing: 0, phase: 0,
    distance: 0, startTime: performance.now(), o2: 100, view: 'third', lamp: false, rocks: true, speedMult: 1, run: false,
    yaw: Math.PI * 0.82, pitch: 0.22, dist: 5.2, fpPitch: -0.05, airTime: 0, boundaryNotice: 0, dustByWorld: { target: 0, earth: 0, rover: 0 },
    jumpCharge: 0, impact: 0, driving: false, nearNotice: 0,
  }
  const input = { f: 0, b: 0, l: 0, r: 0, joyX: 0, joyY: 0, jump: false, brake: 0, camL: 0, camR: 0, zoomIn: 0, zoomOut: 0 }
  let sunElevation = 22, sunAzimuth = 128

  const ground = (x, z) => near ? near.height(x, z) : state[active].field.height(x, z)
  const groundOr = (x, z, fallback) => { const h = ground(x, z); return Number.isFinite(h) ? h : fallback }
  const groundGradient = (x, z, d = 0.3) => [(ground(x + d, z) - ground(x - d, z)) / (2 * d), (ground(x, z + d) - ground(x, z - d)) / (2 * d)]

  const sunDirection = () => {
    const el = THREE.MathUtils.degToRad(sunElevation), az = THREE.MathUtils.degToRad(sunAzimuth)
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize()
  }

  const col = hex => new THREE.Color(hex)
  const mixC = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)))
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
  // Sky, light and fog for a body, sun elevation and weather. Colours are artistic fits to
  // photographs (blue Earth sky, butterscotch Mars sky with a blue sunset, black lunar sky).
  function lookFor(body, el, wx, rover) {
    if (body === 'moon') {
      const lit = sstep(-0.6, 0.6, el)
      return { top: col(0x000000), horizon: col(0x020203), sunset: col(0), sunsetAmt: 0, halo: col(0), haloOn: 0, cloud: 0, cloudColor: col(0xffffff), sunColor: col(0xffffff), sunI: 3.6 * lit, hemiI: el > 0 ? 0.3 : 0.05, hemiSky: col(0x181b20), fogDensity: 0, fogColor: col(0), stars: el > 0 ? 0.35 : 1, exposure: el > 0 ? 1 : 1.6 }
    }
    if (body === 'mars') {
      const day = sstep(-6, 6, el), tau = wx.tau, dusty = clamp((tau - 0.4) / 2, 0, 1), storm = wx.kind === 'storm'
      const top = mixC(col(0x070403), mixC(col(0x9c6f4b), col(0xb38a65), dusty), day)
      const horizon = mixC(col(0x140b07), mixC(col(0xe1bf96), col(0xc79f78), dusty), day)
      const sunI = 2.6 * sstep(-1, 4, el) * Math.exp(-tau * 0.35 / Math.max(Math.sin(Math.max(el, 2) * Math.PI / 180), 0.08)) * (rover ? 0.6 : 1)
      return { top, horizon, sunset: col(0x6f93c9), sunsetAmt: 0.9 * clamp(1 - Math.abs(el - 2) / 10, 0, 1) * day, halo: col(0x7ea6d8), haloOn: (0.6 + 2 * (1 - sstep(0, 15, el))) * day, cloud: 0, cloudColor: col(0xffffff),
        sunColor: col(0xfff0d6), sunI, hemiI: Math.max(0.03, 0.6 * day * (1 + 0.6 * dusty)) * (rover ? 0.9 : 1), hemiSky: horizon.clone(), fogDensity: storm ? 1 / 350 : (0.6 + tau) / (rover ? 900 : 15000), fogColor: horizon.clone().multiplyScalar(0.4 + 0.6 * day),
        stars: (1 - sstep(-8, -2, el)) * (1 - dusty), exposure: 1.05 * (1 + 1.3 * (1 - day)) }
    }
    const day = sstep(-6, 8, el), golden = clamp(1 - Math.abs(el - 3) / 9, 0, 1) * sstep(-7, -2, el), cloud = wx.cloud
    let top = mixC(col(0x020611), col(0x2f6dbd), day), horizon = mixC(col(0x081322), col(0xcadff0), day)
    top = mixC(top, col(0x8c959d).multiplyScalar(0.15 + 0.85 * day), cloud * 0.75)
    horizon = mixC(horizon, col(0xb3bbc2).multiplyScalar(0.15 + 0.85 * day), cloud * 0.6)
    if (wx.dust) { top = mixC(top, col(0xb79a70).multiplyScalar(0.2 + 0.8 * day), wx.dust); horizon = mixC(horizon, col(0xd2b085).multiplyScalar(0.2 + 0.8 * day), wx.dust) }
    if (wx.kind === 'fog') horizon = mixC(horizon, col(0xd3d9de).multiplyScalar(0.2 + 0.8 * day), 0.8)
    const fogDensity = { fog: 1 / 320, rain: 1 / 3500, snow: 1 / 1800, dust: 1 / 1300, cloudy: 1 / 15000 }[wx.kind] || 1 / 30000
    const cloudColor = (wx.kind === 'rain' || wx.kind === 'snow' ? col(0x9aa2aa) : col(0xf2f4f6)).multiplyScalar(0.12 + 0.88 * day)
    return { top, horizon, sunset: col(0xff7a3d), sunsetAmt: 1.2 * golden * (1 - cloud * 0.7), halo: col(0xffffff), haloOn: 0.6 * day * (1 - cloud), cloud, cloudColor,
      sunColor: mixC(col(0xfff4e2), col(0xff9a52), golden * 0.85), sunI: 3.1 * sstep(-1.5, 6, el) * (1 - 0.78 * cloud) * (wx.kind === 'fog' ? 0.5 : 1) * (wx.dust ? 0.6 : 1),
      hemiI: Math.max(0.05, (0.15 + 0.75 * day) * (1 + 0.4 * cloud)), hemiSky: mixC(top, horizon, 0.5), fogDensity, fogColor: horizon.clone(), stars: (1 - sstep(-10, -3, el)) * (1 - cloud), exposure: 1 + 1.5 * (1 - day) + 0.15 * cloud }
  }

  let envKey = '', look = null

  // B3: suit consumables (estimates). O2 from the metabolic rate (eva_route.js). Heat to reject = 80 % of metabolic
  // power plus the environment through the insulation, UA = 0.6 W/K between the suit (288 K) and the radiative
  // equilibrium temperature of its outer layer (sunlight, ground and sky infrared); a positive load evaporates
  // sublimator water (2.83 MJ/kg), a negative one runs battery heaters. Battery: fans, pumps and radio 90 W, headlamp
  // 10 W, heaters. Capacities are design assumptions: 4 kg water, 1.2 kWh.
  const LIFE = { waterKg: 4, batteryWh: 1200, baseW: 90, lampW: 10, ua: 0.6, absorb: 0.18, emit: 0.85, proj: 0.6, area: 1.8, suitK: 288 }
  const life = { water: 100, battery: 100, metW: 0, heatW: 0, heaterW: 0, rates: { o2: 0, water: 0, battery: 0 }, back: null, backTimer: 0 }
  const SIGMA = 5.670e-8
  function suitEnvironment(w) {
    const wx = current?.weather, sunUp = sunElevation > 0, lit = shared.uPlayerSunVis.value
    if (!wx) return { w: 0, outerK: LIFE.suitK, surfK: LIFE.suitK }
    let surfK = wx.temperature + 273.15
    if (w.body === 'moon' && sunUp && lit < 0.5) surfK = Math.min(surfK, 110)    // shaded regolith cools within hours
    const solar = w.body === 'moon' ? 1361 : w.body === 'mars' ? 590 * Math.max(0.2, 1 - 0.25 * (wx.tau || 0.5)) : 1000 * (1 - 0.75 * (wx.cloud || 0))
    const sunIn = sunUp ? LIFE.absorb * solar * Math.sin(Math.min(Math.PI / 2, Math.max(0.15, sunElevation * Math.PI / 180))) * LIFE.proj / LIFE.area * lit : 0
    const skyK = w.body === 'moon' ? 3 : w.body === 'mars' ? 150 : surfK - 20
    const eq = Math.pow((sunIn + LIFE.emit * SIGMA * 0.5 * (surfK ** 4 + skyK ** 4)) / (LIFE.emit * SIGMA), 0.25)
    return { w: LIFE.ua * (eq - LIFE.suitK), outerK: eq, surfK }
  }
  function updateLife(dt, metW) {
    const w = state[active]
    const envState = w.kind === 'tiles' ? { w: 0, outerK: LIFE.suitK, surfK: LIFE.suitK } : suitEnvironment(w), env = envState.w
    life.outerK = envState.outerK; life.surfK = envState.surfK
    const heat = 0.8 * metW + env, heater = heat < 0 ? -heat : 0
    const waterKgS = heat > 0 ? heat / 2.83e6 : 0, batteryW = LIFE.baseW + (player.lamp ? LIFE.lampW : 0) + heater
    life.water = Math.max(0, life.water - waterKgS * dt / LIFE.waterKg * 100)
    life.battery = Math.max(0, life.battery - batteryW * dt / 3600 / LIFE.batteryWh * 100)
    const k = life.primed ? Math.min(1, dt / 4) : 1    // the first step seeds the smoothed rates
    life.primed = true
    life.metW += (metW - life.metW) * k; life.heatW += (heat - life.heatW) * k; life.heaterW += (heater - life.heaterW) * k
    life.energyJ = (life.energyJ || 0) + metW * dt
    life.rates.o2 += (o2Percent(metW) - life.rates.o2) * k                         // percent per second
    life.rates.water += (waterKgS / LIFE.waterKg * 100 - life.rates.water) * k
    life.rates.battery += (batteryW / 3600 / LIFE.batteryWh * 100 - life.rates.battery) * k
    // walk-back to the lander / base (straight line over the DEM), refreshed every 2 s
    life.backTimer -= dt
    if (life.backTimer <= 0 && w.kind !== 'tiles') {
      life.backTimer = 2
      const f = w.field, [bx, bz] = baseAt(w)
      const m = routeMetrics([[player.pos.x, player.pos.z], [bx, bz]], { height: (x, z) => f.height(x, z) / f.exaggeration, gravity: w.profile.gravity, load: route.load, speedScale: w.profile.walk / 1.4 })
      life.back = { o2: m.o2, time: m.time, dist: m.length }
    }
  }
  function lifeReport() {
    const left = [['o2', player.o2], ['water', life.water], ['battery', life.battery]].map(([k, v]) => [k, life.rates[k] > 1e-7 ? v / life.rates[k] : Infinity])
    const [limit, seconds] = left.reduce((a, b) => (b[1] < a[1] ? b : a))
    const back = state[active]?.kind === 'tiles' ? null : life.back
    const warn = back ? (player.o2 - back.o2 < 10 || seconds < back.time * 1.5) : false
    return { o2: player.o2, water: life.water, battery: life.battery, metW: life.metW, heatW: life.heatW, heaterW: life.heaterW, remaining: seconds, limit, back, warn,
      outerC: (life.outerK ?? LIFE.suitK) - 273.15, surfC: (life.surfK ?? LIFE.suitK) - 273.15, energyJ: life.energyJ || 0 }
  }

  // B4: daylight and surface temperature over one full day at a point, from the DEM horizon in the sun's direction.
  function dayProfile(key, x, z, declOverride = null) {
    const w = state[key]
    if (!w || w.kind === 'tiles') return null
    const f = w.field, t = worldTime[key], lat = w.lat, body = w.body
    const decl = declOverride ?? (body === 'earth' ? Wx.earthDeclination(t.month) : body === 'mars' ? Wx.marsDeclination(t.ls) : 0)
    const curv = 1 / (2 * w.profile.radius), h0 = f.height(x, z) + 1.7, maxDist = Math.min(f.sizeM, 30000)
    const hours = [], elev = [], lit = [], temp = []
    for (let h = 0; h <= 24.001; h += 0.25) {
      const s = Wx.sunFrom(lat, decl, h % 24), az = s.azimuth * Math.PI / 180
      const horizon = horizonAngle(f, x, z, Math.sin(az), -Math.cos(az), h0, curv, maxDist) * 180 / Math.PI
      const on = s.elevation > 0 && s.elevation > horizon
      hours.push(h); elev.push(s.elevation); lit.push(on)
      let T
      if (body === 'moon') T = on ? Wx.moonWeather(s.elevation).temperature : Wx.moonWeather(Math.min(s.elevation, -1)).temperature
      else if (body === 'mars') T = Wx.marsWeather(lat, t.ls, h % 24, f.absolute(x, z), 'auto').temperature
      else T = Wx.earthWeather(climate, t.month, h % 24, 15, 'auto', f.absolute(x, z)).temperature
      temp.push(T)
    }
    const n = hours.length - 1
    let litN = 0, upN = 0, run = 0, longest = 0
    for (let i = 0; i < n; i++) { if (lit[i]) litN++; if (elev[i] > 0) upN++; run = lit[i] ? 0 : run + 1; longest = Math.max(longest, run) }
    // darkness that wraps past midnight
    let wrap = 0; for (let i = 0; i < n && !lit[i]; i++) wrap++
    let tail = 0; for (let i = n - 1; i >= 0 && !lit[i]; i--) tail++
    if (wrap < n) longest = Math.max(longest, wrap + tail)
    const dayHours = body === 'moon' ? 29.53 * 24 : body === 'mars' ? Wx.SOL_HOURS.mars : 24
    return { body, hours, elev, lit, temp, litShare: litN / n, sunUpShare: upN / n, longestDarkHours: longest / n * dayHours, dayHours, nowHour: t.hour,
      tMin: Math.min(...temp), tMax: Math.max(...temp) }
  }

  // B5: radio line of sight over the DEM (antenna heights above ground, the body's curvature as a bulge) and Earth in
  // the lunar sky against the local horizon.
  function lineOfSight(f, R, x1, z1, a1, x2, z2, a2) {
    const D = Math.hypot(x2 - x1, z2 - z1)
    if (D < 1) return true
    const y1 = f.height(x1, z1) + a1, y2 = f.height(x2, z2) + a2, n = Math.min(400, Math.max(8, Math.ceil(D / 8)))
    for (let k = 1; k < n; k++) {
      const t = k / n, d = t * D
      if (f.height(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t) + d * (D - d) / (2 * R) > y1 + (y2 - y1) * t) return false
    }
    return true
  }
  const ANT = { suit: 2.2, rover: 3.2, base: 6 }
  function baseAt(w) { const spec = PROPS[w.body]; return spec ? spec.at : [0, 0] }
  function earthView(w, x, z) {
    if (w.body !== 'moon') return null
    const el = THREE.MathUtils.radToDeg(Math.asin(clamp(earthDirection.y, -1, 1)))
    const hl = Math.hypot(earthDirection.x, earthDirection.z) || 1, f = w.field
    const horizon = THREE.MathUtils.radToDeg(horizonAngle(f, x, z, earthDirection.x / hl, earthDirection.z / hl, f.height(x, z) + ANT.suit, 1 / (2 * w.profile.radius), Math.min(f.sizeM, 30000)))
    return { visible: el > horizon && el > 0, elevation: el, horizon }
  }
  function commReport() {
    const w = state[active]
    if (!w || w.kind === 'tiles') return null
    const f = w.field, R = w.profile.radius, [bx, bz] = baseAt(w)
    const base = { los: lineOfSight(f, R, player.pos.x, player.pos.z, ANT.suit, bx, bz, ANT.base), dist: Math.hypot(bx - player.pos.x, bz - player.pos.z) }
    const rover = vehicle && !player.driving ? { los: lineOfSight(f, R, player.pos.x, player.pos.z, ANT.suit, vehicle.state.x, vehicle.state.z, ANT.rover), dist: Math.hypot(vehicle.state.x - player.pos.x, vehicle.state.z - player.pos.z) } : null
    return { base, rover, earth: earthView(w, player.pos.x, player.pos.z), baseName: PROPS[w.body]?.name || null }
  }
  // Minimap coverage: base radio line of sight, or (Moon) direct view of Earth, on a 72 x 72 grid computed in slices.
  let coverMode = 'off', cover = null
  function coverStep(view, w) {
    if (coverMode === 'off' || w.kind === 'tiles' || (coverMode === 'earth' && w.body !== 'moon')) { cover = null; return }
    const f = w.field, R = w.profile.radius, N = 72
    const v = view || { x0: -f.half, z0: -f.half, size: f.sizeM }
    const key = [coverMode, active, Math.round(v.x0), Math.round(v.z0), Math.round(v.size), f.exaggeration].join(':')
    if (!cover || cover.key !== key) cover = { key, N, v, data: new Uint8Array(N * N), i: 0 }
    const [bx, bz] = baseAt(w), end = Math.min(N * N, cover.i + 160)
    for (; cover.i < end; cover.i++) {
      const gx = cover.i % N, gz = Math.floor(cover.i / N)
      const x = v.x0 + (gx + 0.5) / N * v.size, z = v.z0 + (gz + 0.5) / N * v.size
      const ok = coverMode === 'earth' ? !!earthView(w, x, z)?.visible : lineOfSight(f, R, x, z, ANT.suit, bx, bz, ANT.base)
      cover.data[cover.i] = ok ? 1 : 2
    }
  }
  let lookKey = '', condTimer = 0
  function applyConditions(force = false, dt = 0) {
    const w = state[active], p = w.profile
    // Conditions change slowly: recompute a few times a second, not every frame.
    condTimer -= dt
    if (!force && current && condTimer > 0) { sun.intensity = look.sunI; return }
    condTimer = mobile ? 0.5 : 0.2
    current = conditionsFor(active)
    sunElevation = current.sun.elevation; sunAzimuth = current.sun.azimuth
    const wx = current.weather
    const key2 = active + ':' + sunElevation.toFixed(1) + ':' + sunAzimuth.toFixed(0) + ':' + wx.kind + ':' + (wx.cloud || 0).toFixed(2) + ':' + (wx.tau || 0).toFixed(2)
    if (!force && key2 === lookKey) { sun.intensity = look.sunI; return }
    lookKey = key2
    look = lookFor(w.body, sunElevation, wx, w.kind === 'tiles')
    const dir = sunDirection()
    skyUniforms.top.value.copy(look.top); skyUniforms.horizon.value.copy(look.horizon)
    skyUniforms.ground.value.copy(look.horizon).multiplyScalar(0.5)
    skyUniforms.sunDir.value.copy(dir); skyUniforms.sunColor.value.copy(look.sunColor)
    skyUniforms.halo.value.copy(look.halo); skyUniforms.haloOn.value = look.haloOn
    skyUniforms.sunset.value.copy(look.sunset); skyUniforms.sunsetAmt.value = look.sunsetAmt
    skyUniforms.cloud.value = look.cloud; skyUniforms.cloudColor.value.copy(look.cloudColor)
    skyUniforms.sunDisc.value = (1 - look.cloud * 0.9) * (sunElevation > -1 ? 1 : 0)
    skyUniforms.wind.value.set(Math.max(0.5, wx.wind || 1), (wx.wind || 1) * 0.3)
    sun.color.copy(look.sunColor)
    sun.intensity = look.sunI
    hemi.color.copy(look.hemiSky); hemi.groundColor.set(p.hemiGround); hemi.intensity = look.hemiI
    if (look.fogDensity) { if (!(scene.fog instanceof THREE.FogExp2)) scene.fog = new THREE.FogExp2(0, 0); scene.fog.color.copy(look.fogColor); scene.fog.density = look.fogDensity }
    else scene.fog = null
    renderer.toneMappingExposure = look.exposure * (w.body === 'mars' ? 1 : 1)
    stars.visible = look.stars > 0.05; stars.material.opacity = look.stars
    floaters.visible = !reducedMotion && (w.body === 'mars' || wx.kind === 'dust')
    floaters.material.opacity = w.body === 'mars' ? 0.35 + 0.5 * wx.dust : 0.6
    floaters.material.color.set(w.body === 'mars' ? 0xe2b48a : 0xd2b38a)
    printMaterial.color.set(p.print)
    shared.uWet.value = wx.kind === 'rain' ? 1 : Math.max(0, shared.uWet.value - 0.002)
    shared.uSnow.value = wx.kind === 'snow' ? Math.min(1, shared.uSnow.value + 0.004) : wx.temperature < 0 && shared.uSnow.value > 0 ? shared.uSnow.value : Math.max(0, shared.uSnow.value - 0.002)
    rain.visible = wx.kind === 'rain' && !reducedMotion
    snow.visible = wx.kind === 'snow' && !reducedMotion
    devils.visible = !!wx.dustDevils && !reducedMotion
    if (bloom) bloom.strength = w.body === 'moon' ? 0.55 : 0.4
    // A5: opposition surge amplitude and width per surface (strong on lunar regolith, weaker on Martian and terrestrial soils)
    shared.uOpp.value.set(w.body === 'moon' ? 0.8 : w.body === 'mars' ? 0.4 : 0.22, w.body === 'moon' ? 0.06 : 0.08)
    if (w.body === 'moon') shared.uRego.value.set(1, 1, 0.85, 1.3); else if (w.body === 'mars') shared.uRego.value.set(0.85, 0.6, 0, 1); else shared.uRego.value.set(0.55, 0, 0, 1)
    earthGlobe.visible = w.body === 'moon' && earthDirection.y > -0.03
    w.light?.setSun(sunElevation, sunAzimuth)
    // Rebuild the reflection probe when the sky changes noticeably.
    const key = active + ':' + Math.round(sunElevation / 3) + ':' + Math.round(sunAzimuth / 10) + ':' + wx.kind + ':' + Math.round(look.cloud * 4) + ':' + (sunElevation > 0 ? Math.round(shared.uPlayerSunVis.value * 4) : 0)
    if (force || key !== envKey) {
      envKey = key
      const envScene = new THREE.Scene()
      const envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMaterial)
      envScene.add(envSky)
      // A ground hemisphere in the regolith colour gives the visor and suit their bounce light. A4: brighter away from
      // the sun (backscatter), darker toward it, and dimmer while the astronaut stands in a terrain shadow.
      const lowSun = clamp(sunElevation / 18, 0, 1)
      const groundGeo = new THREE.SphereGeometry(9, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
      const gBase = new THREE.Color(p.palette[1]).multiplyScalar((w.body === 'moon' ? 0.6 * lowSun + 0.1 : 0.8) * (0.2 + 0.8 * clamp((sunElevation + 6) / 12, 0, 1)) * (sunElevation > 0 ? 0.3 + 0.7 * shared.uPlayerSunVis.value : 1))
      const saz = sunAzimuth * Math.PI / 180, ssx = Math.sin(saz), ssz = -Math.cos(saz), back = w.body === 'moon' ? 0.45 : 0.18
      const gp = groundGeo.attributes.position, gc = new Float32Array(gp.count * 3)
      for (let i = 0; i < gp.count; i++) {
        const gx = gp.getX(i), gy = gp.getY(i), gz = gp.getZ(i), hl = Math.hypot(gx, gz) || 1
        const k = Math.max(0, 1 - back * ((gx * ssx + gz * ssz) / hl) * (1 - Math.abs(gy) / 9) * lowSun)
        gc[i * 3] = gBase.r * k; gc[i * 3 + 1] = gBase.g * k; gc[i * 3 + 2] = gBase.b * k
      }
      groundGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3))
      const envGround = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }))
      envScene.add(envGround)
      const rt = pmrem.fromScene(envScene, 0.02)
      envSky.geometry.dispose(); envGround.geometry.dispose(); envGround.material.dispose()
      if (scene.environment) scene.environment.dispose()
      scene.environment = rt.texture
      scene.environmentIntensity = (w.body === 'moon' ? 0.45 : 0.8) * (0.15 + 0.85 * clamp((sunElevation + 6) / 14, 0, 1))
      applyReflections()
    }
  }
  const updateEnvironment = () => applyConditions(true)

  function updateWeatherFx(dt) {
    const wx = current?.weather
    if (!wx) return
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, wind = wx.wind || 0
    if (!fxSeeded) {
      for (let i = 0; i < RAIN; i++) { const x = cx + (Math.random() - 0.5) * 50, y = cy + Math.random() * 25 - 5, z = cz + (Math.random() - 0.5) * 50; rainPos.set([x, y, z, x, y - 0.5, z], i * 6) }
      for (let i = 0; i < SNOW; i++) snowPos.set([cx + (Math.random() - 0.5) * 50, cy + Math.random() * 20 - 4, cz + (Math.random() - 0.5) * 50], i * 3)
      fxSeeded = true
    }
    if (rain.visible) {
      for (let i = 0; i < RAIN; i++) {
        const k = i * 6
        let x = rainPos[k] + wind * 0.6 * dt, y = rainPos[k + 1] - 9 * dt, z = rainPos[k + 2]
        if (y < cy - 6 || Math.abs(x - cx) > 25 || Math.abs(z - cz) > 25) { x = cx + (Math.random() - 0.5) * 50; y = cy + 12 + Math.random() * 8; z = cz + (Math.random() - 0.5) * 50 }
        rainPos.set([x, y, z, x - wind * 0.035, y + 0.55, z], k)
      }
      rainGeometry.attributes.position.needsUpdate = true
    }
    if (snow.visible) {
      for (let i = 0; i < SNOW; i++) {
        const k = i * 3
        let x = snowPos[k] + (wind * 0.4 + Math.sin(clock + i) * 0.3) * dt, y = snowPos[k + 1] - 0.9 * dt, z = snowPos[k + 2] + Math.cos(clock * 0.7 + i) * 0.3 * dt
        if (y < cy - 5 || Math.abs(x - cx) > 25 || Math.abs(z - cz) > 25) { x = cx + (Math.random() - 0.5) * 50; y = cy + 10 + Math.random() * 6; z = cz + (Math.random() - 0.5) * 50 }
        snowPos.set([x, y, z], k)
      }
      snowGeometry.attributes.position.needsUpdate = true
    }
    if (devils.visible) {
      // Two convective vortices drifting a few hundred metres away in the afternoon.
      for (let i = 0; i < DEVIL; i++) {
        const column = i % 2, t = (i / DEVIL) * 2, hgt = (i * 0.618 % 1) * 90
        const baseA = clock * 0.02 + column * 2.4, dist = 380 + column * 220
        const bx = player.pos.x + Math.cos(baseA) * dist, bz = player.pos.z + Math.sin(baseA) * dist
        const r = 3 + hgt * 0.18, a = clock * 2.2 + t * 40 + hgt * 0.15
        devilPos.set([bx + Math.cos(a) * r, groundOr(bx, bz, player.pos.y) + hgt, bz + Math.sin(a) * r], i * 3)
      }
      devilGeometry.attributes.position.needsUpdate = true
    }
  }

  const tintFor = w => {
    const [a, b, c] = w.profile.palette.map(x => new THREE.Color(x))
    return (out, t, slope) => {
      out.copy(t < 0.5 ? a : b).lerp(t < 0.5 ? b : c, t < 0.5 ? t * 2 : (t - 0.5) * 2)
      out.multiplyScalar(clamp(1.06 - slope / 45, 0.55, 1.1))
    }
  }

  function terrainColors(w) {
    const f = w.field, M = f.M, colors = new Float32Array(M * M * 3)
    const span = Math.max(1, f.maxH - f.minH), tint = tintFor(w)
    const col = new THREE.Color()
    for (let r = 0; r < M; r++) for (let q = 0; q < M; q++) {
      const i = r * M + q, x = -f.half + q * f.step, z = -f.half + r * f.step
      tint(col, (f.H[i] - f.minH) / span, f.slopeDeg(x, z))
      colors.set([col.r, col.g, col.b], i * 3)
    }
    return colors
  }

  function disposeMesh(m) { if (!m) return; scene.remove(m); m.geometry.dispose(); m.material.dispose() }

  function buildTerrain() {
    const w = state[active], f = w.field, M = f.M
    disposeMesh(terrainMesh); disposeMesh(skirtMesh); disposeMesh(outerMesh); disposeMesh(boundaryLine)
    terrainMesh = skirtMesh = outerMesh = boundaryLine = null
    near?.dispose(); near = null
    roverParent.visible = w.kind === 'tiles'
    if (w.kind === 'tiles') { ensureRoverTiles(); return }
    if (!w.light) w.light = createTerrainLight(f, w.profile.radius, { dirs: mobile ? 5 : 8 })
    near = new NearField({
      scene, field: f, micro: w.micro, tint: tintFor(w), textured: !!w.texture, mobile,
      makeMaterial: () => curvedMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, map: w.texture || null, roughness: 0.97, metalness: 0, side: THREE.DoubleSide }), w.profile.radius, { detail: detailTexture, light: true, shared, nearFocus: nearFocusRef, edge: nearEdgeAnim, edgeW: NEAR_EDGE_W }),
    })
    near.bounds = nearEdgeRef; near.edgeW = NEAR_EDGE_W
    near.light = w.light
    near.focus = nearFocusRef
    nearFocusRef.set(player.pos.x, player.pos.z, mobile ? 22 : 40, mobile ? 36 : 76)
    const geometry = new THREE.BufferGeometry()
    const pos = new Float32Array(M * M * 3), uv = new Float32Array(M * M * 2)
    for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) {
      const i = r * M + c
      pos.set([-f.half + c * f.step, f.H[i], -f.half + r * f.step], i * 3)
      uv.set([c / (M - 1), 1 - r / (M - 1)], i * 2)
    }
    const index = new Uint32Array((M - 1) * (M - 1) * 6)
    let k = 0
    for (let r = 0; r < M - 1; r++) for (let c = 0; c < M - 1; c++) {
      const a = r * M + c, b = (r + 1) * M + c, cc = (r + 1) * M + c + 1, d = r * M + c + 1
      index.set([a, b, d, b, cc, d], k); k += 6
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(terrainColors(w), 3))
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
    geometry.computeVertexNormals()
    near.farNormals = geometry.attributes.normal.array
    geometry.setAttribute('sunVis', new THREE.BufferAttribute(Float32Array.from(w.light.sunVis), 1))
    geometry.setAttribute('skyVis', new THREE.BufferAttribute(Float32Array.from(w.light.skyVis), 1))
    const material = curvedMaterial(new THREE.MeshStandardMaterial({ vertexColors: !w.texture, map: w.texture || null, roughness: 0.97, metalness: 0 }), w.profile.radius, { detail: detailTexture, hole: near.bounds, light: true, shared })
    material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 2
    terrainMesh = new THREE.Mesh(geometry, material)
    terrainMesh.receiveShadow = true
    scene.add(terrainMesh)
    const base = f.minH - 40
    const ring = []
    for (let c = 0; c < M; c++) ring.push([c, 0])
    for (let r = 1; r < M; r++) ring.push([M - 1, r])
    for (let c = M - 2; c >= 0; c--) ring.push([c, M - 1])
    for (let r = M - 2; r > 0; r--) ring.push([0, r])
    ring.push(ring[0])
    const sp = [], si = [], linePts = []
    ring.forEach(([c, r], i) => {
      const x = -f.half + c * f.step, z = -f.half + r * f.step, y = f.H[r * M + c]
      sp.push(x, y, z, x, base, z); linePts.push(new THREE.Vector3(x, y + 0.6, z))
      if (i > 0) { const a = (i - 1) * 2; si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    })
    const skirtGeometry = new THREE.BufferGeometry()
    skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3))
    skirtGeometry.setIndex(si); skirtGeometry.computeVertexNormals()
    const mean = new THREE.Color(w.profile.palette[1]).multiplyScalar(0.55)
    skirtMesh = new THREE.Mesh(skirtGeometry, curvedMaterial(new THREE.MeshStandardMaterial({ color: mean, roughness: 1, side: THREE.DoubleSide }), w.profile.radius))
    scene.add(skirtMesh)
    // Beyond the data window the ground continues smoothly toward the mean edge height and colour,
    // so there is no cliff or seam on the horizon (it carries no data; the boundary line marks it).
    const edgeColor = new THREE.Color(), meanEdge = ring.reduce((sum, [c, r]) => sum + f.H[r * M + c], 0) / ring.length
    const dists = [0, 150, 500, 1300, 3000, 6500, 14000, 30000]
    const ap = [], ac = [], ai = [], terrainCol = geometry.attributes.color.array
    const texColor = w.edgeColors
    ring.forEach(([c, r], i) => {
      const x = -f.half + c * f.step, z = -f.half + r * f.step, h = f.H[r * M + c], len = Math.hypot(x, z) || 1
      if (texColor) edgeColor.setRGB(...texColor(c / (M - 1), r / (M - 1)))
      else edgeColor.setRGB(terrainCol[(r * M + c) * 3], terrainCol[(r * M + c) * 3 + 1], terrainCol[(r * M + c) * 3 + 2])
      dists.forEach((d, k) => {
        const t = Math.min(1, d / 6500), e = t * t * (3 - 2 * t)
        ap.push(x + x / len * d, h + (meanEdge - h) * e - 0.05 * Math.min(1, d / 50), z + z / len * d)
        const cc = edgeColor.clone().lerp(mean.clone().multiplyScalar(1.8), e * 0.7)
        ac.push(cc.r, cc.g, cc.b)
        if (i > 0 && k > 0) { const a = (i - 1) * dists.length + k - 1, b = i * dists.length + k - 1; ai.push(a, b, a + 1, b, b + 1, a + 1) }
      })
    })
    const outerGeometry = new THREE.BufferGeometry()
    outerGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ap, 3))
    outerGeometry.setAttribute('color', new THREE.Float32BufferAttribute(ac, 3))
    outerGeometry.setIndex(ai); outerGeometry.computeVertexNormals()
    outerMesh = new THREE.Mesh(outerGeometry, curvedMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }), w.profile.radius, { detail: detailTexture, shared }))
    outerMesh.receiveShadow = true
    scene.add(outerMesh)
    boundaryLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), new THREE.LineBasicMaterial({ color: 0xececec, transparent: true, opacity: 0.45 }))
    scene.add(boundaryLine)
    near.update(player.pos.x, player.pos.z)
    nearEdgeAnim.copy(nearEdgeRef)
    bindObjectSun()
    buildRouteMesh()
    cascadeAll()
  }

  function adoptTexture(key, texture) {
    const w = state[key]
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy())
    w.texture = keep(texture); w.textureState = 'ready'
    try {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64
      const cx2 = cv.getContext('2d'); cx2.drawImage(texture.image, 0, 0, 64, 64)
      const px = cx2.getImageData(0, 0, 64, 64).data
      const lin = v => Math.pow(v / 255, 2.2)
      w.edgeColors = (u, v) => { const i = (Math.min(63, Math.round(v * 63)) * 64 + Math.min(63, Math.round(u * 63))) * 4; return [lin(px[i]), lin(px[i + 1]), lin(px[i + 2])] }
    } catch { w.edgeColors = null }
    w.minimapBase = null
  }

  function loadTexture(key) {
    const w = state[key]
    if (!w.textureUrl || w.texture || w.textureLoading) return
    // Preloaded by the loading screen: ready before the terrain is built, so it is built once.
    const image = assets.images?.[key]
    if (image) { const texture = new THREE.Texture(image); texture.needsUpdate = true; adoptTexture(key, texture); return }
    w.textureLoading = true
    new THREE.TextureLoader().load(w.textureUrl, texture => {
      if (disposed) { texture.dispose(); return }
      adoptTexture(key, texture)
      if (key === active && terrainMesh) buildTerrain()
    }, undefined, () => { w.textureState = 'unavailable'; w.textureLoading = false })
  }

  function regenerateGravel() {
    const w = state[active], f = w.field, CELL = 4, R = mobile ? 3 : 5
    const cx = Math.floor(player.pos.x / CELL), cz = Math.floor(player.pos.z / CELL)
    const on = player.rocks && w.kind !== 'tiles' && w.profile.rocksPerCell > 0
    const key = active + ':' + cx + ':' + cz + ':' + on + ':' + f.exaggeration
    if (key === gravelKey) return
    gravelKey = key
    const counts = [0, 0, 0]
    if (on) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), color = new THREE.Color(), e = new THREE.Euler()
      const [ca, cb] = w.profile.rock.map(x => new THREE.Color(x))
      const perCell = w.body === 'moon' ? 30 : w.body === 'mars' ? 24 : 10
      for (let gx = cx - R; gx <= cx + R; gx++) for (let gz = cz - R; gz <= cz + R; gz++) {
        const rand = mulberry32(hash2(gx, gz, 70 + (w.body === 'earth' ? 3 : w.body === 'mars' ? 2 : 1)))
        const patch = 0.4 + 1.2 * Math.max(0, fbm(gx * 0.21, gz * 0.21, 11, 2) + 0.5)
        const n = Math.round(perCell * patch)
        for (let i = 0; i < n; i++) {
          const x = (gx + rand()) * CELL, z = (gz + rand()) * CELL
          // Power-law sizes between about 1 and 9 cm: mostly grit, a few fist-sized stones.
          const size = clamp(0.012 * Math.pow(1 - rand() * 0.995, -0.6), 0.012, 0.09), variant = Math.floor(rand() * 3)
          const sx = 0.8 + rand() * 0.6, sy = 0.6 + rand() * 0.5, sz = 0.8 + rand() * 0.6, turn = rand() * Math.PI * 2, shade = 0.85 + rand() * 0.3, blend = rand()
          if (Math.abs(x) > f.half - 1 || Math.abs(z) > f.half - 1 || counts[variant] >= GRAVEL) continue
          s.set(size * sx, size * sy, size * sz)
          p.set(x, (near ? near.renderHeight(x, z) : ground(x, z)) - s.y * 0.2, z)
          m.compose(p, q.setFromEuler(e.set(0, turn, 0)), s)
          gravelSets[variant].setMatrixAt(counts[variant], m)
          gravelSets[variant].setColorAt(counts[variant], color.copy(ca).lerp(cb, 0.35 + blend * 0.65).multiplyScalar(shade * (w.body === 'moon' ? 0.72 : 1)))
          counts[variant]++
        }
      }
    }
    gravelSets.forEach((mesh, i) => { mesh.count = counts[i]; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true })
  }

  function regenerateRocks(force = false) {
    const w = state[active], f = w.field, CELL = 40, R = mobile ? 3 : 4
    if (w.kind === 'tiles') { rockColliders = []; rockCellKey = ''; rockSets.forEach(set => { set.mesh.count = 0 }); return }
    const cx = Math.floor(player.pos.x / CELL), cz = Math.floor(player.pos.z / CELL)
    const key = active + ':' + cx + ':' + cz + ':' + player.rocks + ':' + f.exaggeration
    if (!force && key === rockCellKey) return
    rockCellKey = key
    rockColliders = []
    const counts = rockSets.map(() => 0)
    if (player.rocks) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), color = new THREE.Color(), e = new THREE.Euler()
      const [ca, cb] = w.profile.rock.map(x => new THREE.Color(x))
      for (let gx = cx - R; gx <= cx + R; gx++) for (let gz = cz - R; gz <= cz + R; gz++) {
        const rand = mulberry32(hash2(gx, gz, w.body === 'earth' ? 3 : w.body === 'mars' ? 2 : 1))
        const centerX = (gx + 0.5) * CELL, centerZ = (gz + 0.5) * CELL
        if (Math.abs(centerX) > f.half || Math.abs(centerZ) > f.half) continue
        // Rock abundance rises with slope and is patchy, as on real regolith and desert pavement.
        const patch = 0.35 + 1.3 * Math.max(0, fbm(gx * 0.35, gz * 0.35, 5, 2) + 0.5)
        const n = Math.round(w.profile.rocksPerCell * (1 + f.slopeDeg(centerX, centerZ) / 8) * patch * (0.6 + rand() * 0.8))
        for (let i = 0; i < n; i++) {
          const x = (gx + rand()) * CELL, z = (gz + rand()) * CELL
          if (Math.abs(x) > f.half - 1 || Math.abs(z) > f.half - 1) continue
          // Power-law sizes: mostly pebbles, rare metre-scale boulders.
          const size = clamp(0.025 * Math.pow(1 - rand() * 0.9995, -0.75), 0.02, 2.2)
          if (Math.hypot(x - player.pos.x, z - player.pos.z) < 1.5 + size) continue
          const small = size < 0.35, variant = Math.floor(rand() * 3) + (small ? 0 : 3)
          const set = rockSets[variant]
          if (counts[variant] >= set.cap) continue
          s.set(size * (0.85 + rand() * 0.5), size * (0.7 + rand() * 0.45), size * (0.85 + rand() * 0.4))
          const y = (near ? near.renderHeight(x, z) : ground(x, z)) - s.y * (0.18 + rand() * 0.25)
          p.set(x, y, z)
          q.setFromEuler(e.set((rand() - 0.5) * 0.4, rand() * Math.PI * 2, (rand() - 0.5) * 0.4))
          m.compose(p, q, s)
          set.mesh.setMatrixAt(counts[variant], m)
          color.copy(ca).lerp(cb, rand()).multiplyScalar(0.8 + rand() * 0.35)
          set.mesh.setColorAt(counts[variant], color)
          counts[variant]++
          if (size > 0.35) rockColliders.push({ x, z, r: Math.max(s.x, s.z) * 0.9, top: y + s.y * 0.85 })
        }
        // A5: ejecta blocks on the rims of fresh lunar craters that dug through the regolith
        if (w.body === 'moon') for (const c of blockCraters(gx * CELL, gz * CELL, (gx + 1) * CELL, (gz + 1) * CELL)) {
          const bmax = Math.min(2.2, 0.29 * Math.pow(c.D, 0.7)), nb = Math.round(c.fresh * c.D / 2.5)
          for (let i = 0; i < nb; i++) {
            const a = rand() * Math.PI * 2, d = c.r * (0.85 + rand() * rand() * 1.6), x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d
            const size = Math.max(0.12, bmax * Math.pow(rand(), 2.2))
            if (Math.abs(x) > f.half - 1 || Math.abs(z) > f.half - 1 || Math.hypot(x - player.pos.x, z - player.pos.z) < 1.5 + size) continue
            const small = size < 0.35, variant = Math.floor(rand() * 3) + (small ? 0 : 3), set = rockSets[variant]
            if (counts[variant] >= set.cap) continue
            s.set(size * (0.85 + rand() * 0.5), size * (0.7 + rand() * 0.45), size * (0.85 + rand() * 0.4))
            const y = (near ? near.renderHeight(x, z) : ground(x, z)) - s.y * (0.15 + rand() * 0.2)
            p.set(x, y, z); q.setFromEuler(e.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5)); m.compose(p, q, s)
            set.mesh.setMatrixAt(counts[variant], m)
            // freshly excavated blocks are less space-weathered, so a little brighter than the mature regolith
            color.copy(ca).lerp(cb, 0.4 + rand() * 0.6).multiplyScalar(0.9 + rand() * 0.3)
            set.mesh.setColorAt(counts[variant], color)
            counts[variant]++
            if (size > 0.35) rockColliders.push({ x, z, r: Math.max(s.x, s.z) * 0.9, top: y + s.y * 0.85 })
          }
        }
      }
    }
    rockSets.forEach((set, i) => {
      set.mesh.count = counts[i]; set.mesh.instanceMatrix.needsUpdate = true
      if (set.mesh.instanceColor) set.mesh.instanceColor.needsUpdate = true
    })
  }

  function placeProp() {
    if (propGroup) { scene.remove(propGroup); propGroup = null; propCollider = null }
    const w = state[active], spec = w.kind === 'tiles' ? null : PROPS[w.body]
    if (!spec) return
    const attach = template => {
      if (disposed || state[active].body !== w.body) return
      const group = template.clone(true)
      const [x, z] = spec.at
      const f = w.field
      if (Math.abs(x) > f.half - 10 || Math.abs(z) > f.half - 10) return
      // Rest on the lowest of a few footprint samples so no part floats.
      const r = spec.width * 0.4
      const y = Math.min(...[[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].map(([dx, dz]) => ground(x + dx, z + dz)))
      group.position.set(x, y - 0.05, z); group.rotation.y = spec.yaw
      objectSunTree(group)
      scene.add(group); propGroup = group
      propCollider = { x, z, r: spec.width * 0.45, top: y + template.userData.height }
    }
    if (propCache[w.body]) { attach(propCache[w.body]); return }
    if (propCache[w.body] === null) return  // already loading
    propCache[w.body] = null
    propPending = true
    const settle = () => { propPending = false }
    loadModel(assets.propBody === w.body ? 'prop' : 'none', spec.path, result => {
      settle()
      if (disposed) return
      const object = result.scene
      object.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      const box = new THREE.Box3().setFromObject(object), size = box.getSize(new THREE.Vector3())
      object.scale.setScalar(spec.width / Math.max(size.x, size.z))
      const fitted = new THREE.Box3().setFromObject(object), center = fitted.getCenter(new THREE.Vector3())
      object.position.set(-center.x, -fitted.min.y, -center.z)
      const template = new THREE.Group(); template.add(object)
      template.userData.height = fitted.max.y - fitted.min.y
      propCache[w.body] = template
      attach(template)
    }, () => { settle(); delete propCache[w.body] })
  }

  // B7 / B8 (2026-10-20): field-science markers (sample stations, seismometer) and the habitat placed at a base site,
  // kept per world and rebuilt on a world switch like the flags.
  const missionGroup = new THREE.Group(); scene.add(missionGroup)
  const stakeMaterial = keep(withObjectSun(new THREE.MeshStandardMaterial({ color: 0xff7a2f, roughness: 0.55 })))
  const foilMaterial = keep(withObjectSun(new THREE.MeshStandardMaterial({ color: 0xd9a63a, metalness: 1, roughness: 0.32 })))
  const whiteMaterial = keep(withObjectSun(new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.6 })))
  const padMaterial = keep(new THREE.LineBasicMaterial({ color: 0xececec, transparent: true, opacity: 0.85 }))
  const missionMarks = {}, baseSites = {}
  let habitatTemplate = null, habitatLoading = false
  const siteSpot = () => [player.pos.x - Math.sin(player.yaw) * 14, player.pos.z - Math.cos(player.yaw) * 14]
  const realHeight = (w, x, z) => w.field.height(x, z) / w.field.exaggeration + w.micro(x, z)
  function slopeAt(w, x, z, d = 1.5) {
    const gx = (realHeight(w, x + d, z) - realHeight(w, x - d, z)) / (2 * d), gz = (realHeight(w, x, z + d) - realHeight(w, x, z - d)) / (2 * d)
    return { deg: Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI, gx, gz }
  }
  function markerMesh(mark) {
    const g = new THREE.Group(), y = groundOr(mark.x, mark.z, player.pos.y)
    g.position.set(mark.x, y, mark.z)
    if (mark.kind === 'sample') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.75, 6), whiteMaterial); pole.position.y = 0.37
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 10), stakeMaterial); tip.position.y = 0.8
      const bag = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.12), whiteMaterial); bag.position.set(0.18, 0.05, 0.05)
      ;[pole, tip, bag].forEach(o => { o.castShadow = true; g.add(o) })
    } else {
      // seismometer: gold-foil thermal shroud on a levelling base, as in the Apollo passive seismic experiment
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.05, 20), whiteMaterial); base.position.y = 0.025
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.3, 20), foilMaterial); body.position.y = 0.2
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), foilMaterial); cap.position.y = 0.35
      ;[base, body, cap].forEach(o => { o.castShadow = true; o.receiveShadow = true; g.add(o) })
    }
    return g
  }
  function padOutline(site) {
    const pts = [], half = 10
    for (let k = 0; k <= 40; k++) {
      const t = k / 10, side = Math.floor(t) % 4, u = t - Math.floor(t)
      const [x, z] = [[-half + 2 * half * u, -half], [half, -half + 2 * half * u], [half - 2 * half * u, half], [-half, half - 2 * half * u]][side]
      pts.push(new THREE.Vector3(site.x + x, groundOr(site.x + x, site.z + z, player.pos.y) + 0.06, site.z + z))
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), padMaterial)
  }
  function syncMissionMarks() {
    missionGroup.children.slice().forEach(child => { missionGroup.remove(child); child.traverse(o => { if (o.geometry) o.geometry.dispose() }) })
    const w = state[active]
    if (!w || w.kind === 'tiles') return
    for (const mark of missionMarks[active] || []) missionGroup.add(markerMesh(mark))
    const site = baseSites[active]
    if (site) {
      missionGroup.add(padOutline(site))
      if (habitatTemplate) {
        const hab = habitatTemplate.clone(true), r = 2
        const y = Math.min(...[[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].map(([dx, dz]) => groundOr(site.x + dx, site.z + dz, player.pos.y)))
        hab.position.set(site.x, y - 0.05, site.z); hab.rotation.y = 0.3
        objectSunTree(hab); missionGroup.add(hab)
      }
    }
  }
  function loadHabitat() {
    if (habitatTemplate || habitatLoading) return
    habitatLoading = true
    loadModel('none', PROPS.earth.path, result => {
      habitatLoading = false
      if (disposed) return
      const object = result.scene
      object.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      const box = new THREE.Box3().setFromObject(object), size = box.getSize(new THREE.Vector3())
      object.scale.setScalar(PROPS.earth.width / Math.max(size.x, size.z))
      const fitted = new THREE.Box3().setFromObject(object), center = fitted.getCenter(new THREE.Vector3())
      object.position.set(-center.x, -fitted.min.y, -center.z)
      habitatTemplate = new THREE.Group(); habitatTemplate.add(object)
      syncMissionMarks()
    }, () => { habitatLoading = false })
  }
  // B8: the 20 m x 20 m footprint of a habitat site: slope and relief from the DEM plus the sub-DEM relief, sunlit share
  // over a full day, Earth in view (Moon), distance to the landing site (Moon: the lander; elsewhere the start point).
  function siteAt(key, x, z) {
    const w = state[key]
    if (!w || w.kind === 'tiles') return null
    let lo = Infinity, hi = -Infinity, maxSlope = 0, sum = 0, n = 0
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const px = x - 10 + i * 2.5, pz = z - 10 + j * 2.5, h = realHeight(w, px, pz), s = slopeAt(w, px, pz, 1.25).deg
      lo = Math.min(lo, h); hi = Math.max(hi, h); maxSlope = Math.max(maxSlope, s); sum += s; n++
    }
    const day = dayProfile(key, x, z), [bx, bz] = w.body === 'moon' ? PROPS.moon.at : [0, 0]
    return { body: w.body, meanSlope: sum / n, maxSlope, relief: hi - lo, litShare: day?.litShare ?? null, longestDark: day?.longestDarkHours ?? null,
      earth: earthView(w, x, z), landing: Math.hypot(x - bx, z - bz) }
  }
  // B8: permanent shadow test for ice (Moon): no direct sun at either extreme of the 1.54 deg solar declination.
  function permanentShadow(x, z) {
    const w = state.target
    if (!w || w.body !== 'moon') return null
    for (const decl of [-1.54, 1.54]) { const p = dayProfile('target', x, z, decl); if (!p || p.lit.some(Boolean)) return false }
    return true
  }
  // B7: is a steep wall (a crater wall or a scarp) in front of the camera? Looks 4-60 m ahead along the view.
  function wallAhead() {
    const w = state[active]
    if (!w || w.kind === 'tiles') return { ok: false }
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw)
    let best = { slope: 0, dist: 0, relief: 0 }
    for (let t = 4; t <= 60; t += 2) {
      const x = player.pos.x + fx * t, z = player.pos.z + fz * t, s = slopeAt(w, x, z, 1.5)
      // the slope must rise away from the camera, so its face is the side being photographed
      if (s.gx * fx + s.gz * fz <= 0 || s.deg <= best.slope) continue
      let lo = Infinity, hi = -Infinity
      for (let k = -6; k <= 6; k += 2) { const h = realHeight(w, x + fx * k, z + fz * k); lo = Math.min(lo, h); hi = Math.max(hi, h) }
      best = { slope: s.deg, dist: t, relief: hi - lo }
    }
    return { ok: best.slope >= 20 && best.relief >= 1, ...best }
  }
  function thumbnail() {
    draw()
    const c = document.createElement('canvas'); c.width = 192; c.height = 108
    c.getContext('2d').drawImage(renderer.domElement, 0, 0, c.width, c.height)
    try { return c.toDataURL('image/jpeg', 0.72) } catch { return null }
  }

  function rebuildFlags() {
    flagGroup.children.slice().forEach(child => { flagGroup.remove(child); child.traverse(o => { if (o.geometry) o.geometry.dispose() }) })
    const w = state[active]
    w.flags.forEach(flag => flagGroup.add(makeFlag(flag, w)))
    syncMissionMarks()
  }

  function makeFlag(flag, w) {
    const g = new THREE.Group()
    g.position.set(flag.x, groundOr(flag.x, flag.z, player.pos.y) - 0.15, flag.z)
    g.rotation.y = flag.yaw
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.0, 8), poleMaterial)
    pole.position.y = 1.0; pole.castShadow = true; g.add(pole)
    const clothGeometry = new THREE.PlaneGeometry(0.9, 0.56, 12, 6)
    clothGeometry.translate(0.45, 0, 0)
    const cloth = new THREE.Mesh(clothGeometry, flagMaterial)
    cloth.position.set(0.02, 1.68, 0); cloth.castShadow = true
    cloth.userData.base = Float32Array.from(clothGeometry.attributes.position.array)
    cloth.userData.wind = w.body !== 'moon'
    g.add(cloth)
    if (w.body === 'moon') {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.92, 6), poleMaterial)
      rod.rotation.z = Math.PI / 2; rod.position.set(0.47, 1.96, 0); g.add(rod)
    }
    return g
  }

  function applyPendingDetail(key) {
    const w = state[key]
    if (!w?.pendingDetail) return
    w.detail = w.pendingDetail; w.pendingDetail = null
    w.field = buildField(w.terrain, w.sizeM, w.res, exaggerationNow, w.detail); w.minimapBase = null; w.light = null
  }

  function enterWorld(key, keepPosition = true) {
    applyPendingDetail(key)
    route.follow = false
    if (vehicle && state[active]) vehiclePose[active] = { x: vehicle.state.x, z: vehicle.state.z, yaw: vehicle.state.yaw }
    if (player.driving) { player.driving = false; player.dist = 5.2; player.pitch = 0.22 }
    active = key
    const w = state[key]
    const f = w.field
    if (keepPosition) {
      player.pos.x = clamp(player.pos.x, -f.half + 2, f.half - 2)
      player.pos.z = clamp(player.pos.z, -f.half + 2, f.half - 2)
    }
    player.vel.set(0, 0, 0); player.vy = 0; player.grounded = true
    prints.count = 0; prints.instanceMatrix.needsUpdate = true; printCursor = 0
    dustLife.fill(0)
    if (w.kind !== 'tiles') loadTexture(key)
    buildTerrain()
    player.pos.y = groundOr(player.pos.x, player.pos.z, player.pos.y)
    updateEnvironment()
    regenerateRocks(true)
    rebuildFlags()
    placeProp()
    seedFloaters()
    astro.setDust(new THREE.Color(w.profile.suitDust), player.dustByWorld[key] / 1500)
    if (!w.path.length) w.path.push([player.pos.x, player.pos.z])
    gaitReset()
    placeVehicle()
  }

  function seedFloaters() {
    const rand = mulberry32(5)
    for (let i = 0; i < FLOAT; i++) floatPos.set([player.pos.x + (rand() - 0.5) * 40, player.pos.y + rand() * 6, player.pos.z + (rand() - 0.5) * 40], i * 3)
    floatGeometry.attributes.position.needsUpdate = true
  }

  let printCursor = 0
  function addFootprintAt(x, z, facing) {
    const gy = ground(x, z)
    if (!Number.isFinite(gy)) return
    const y = gy + 0.02
    const [gx, gz] = state[active].kind === 'tiles' ? roverField.gradient(x, z, 0.15) : groundGradient(x, z, 0.15)
    const normal = new THREE.Vector3(-gx, 1, -gz).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal)
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing))
    // A7: Bekker sinkage for this soil and gravity, deeper on slopes; deeper prints read darker and a little wider
    const depth = bootSinkage(state[active].body, state[active].profile.gravity, Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI), grow = 1 + Math.min(0.25, depth * 4)
    prints.setMatrixAt(printCursor % PRINTS, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(grow, 1, 1 + (grow - 1) * 0.5)))
    const shade = 0.034 / (1 + depth * 100); prints.setColorAt(printCursor % PRINTS, new THREE.Color(shade, shade * 0.97, shade * 0.94)); prints.instanceColor.needsUpdate = true
    printCursor++
    prints.count = Math.min(printCursor, PRINTS)
    prints.instanceMatrix.needsUpdate = true
  }

  function emitDust(x, z, count, speed, dir = null) {
    if (reducedMotion) count = Math.ceil(count / 3)
    const w = state[active], y = groundOr(x, z, player.pos.y), [r, g, b] = w.profile.dust
    for (let i = 0; i < count; i++) {
      const k = dustCursor++ % DUST
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7)
      dustPos.set([x + (Math.random() - 0.5) * 0.2, y + 0.03, z + (Math.random() - 0.5) * 0.2], k * 3)
      if (dir) dustVel.set([dir.x * speed * (0.5 + Math.random() * 0.5) + Math.cos(a) * s * 0.25, speed * (0.35 + Math.random() * 0.5), dir.z * speed * (0.5 + Math.random() * 0.5) + Math.sin(a) * s * 0.25], k * 3)
      else dustVel.set([Math.cos(a) * s, speed * (0.4 + Math.random() * 0.9), Math.sin(a) * s], k * 3)
      dustFine[k] = w.profile.dustDrag > 0 && Math.random() < 0.4 ? 1 : 0
      dustLife[k] = 1; dustGround[k] = y
      const shade = 0.85 + Math.random() * 0.3
      dustCol.set([r * shade, g * shade, b * shade, 0.9], k * 4)
    }
  }

  const keyMap = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', KeyQ: 'camL', KeyE: 'camR', Equal: 'zoomIn', NumpadAdd: 'zoomIn', Minus: 'zoomOut', NumpadSubtract: 'zoomOut' }
  function key(code, down) {
    if (keyMap[code]) { input[keyMap[code]] = down ? 1 : 0; return true }
    if (code === 'ShiftLeft' || code === 'ShiftRight') { player.run = down; return true }
    if (code === 'Space') { if (down) input.jump = true; input.brake = down ? 1 : 0; return true }
    return false
  }

  function action(name) {
    const w = state[active]
    if (name === 'jump') input.jump = true
    else if (name === 'run') player.run = !player.run
    else if (name === 'view') { player.view = player.view === 'third' ? 'first' : 'third'; onToast?.(player.view === 'first' ? 'view-first' : 'view-third') }
    else if (name === 'lamp') { player.lamp = !player.lamp; astro.setLamp(player.lamp); onToast?.(player.lamp ? 'lamp-on' : 'lamp-off') }
    else if (name === 'rocks') { if (w.kind === 'tiles') return null; player.rocks = !player.rocks; regenerateRocks(true); onToast?.(player.rocks ? 'rocks-on' : 'rocks-off') }
    else if (name === 'speed') { player.speedMult = player.speedMult === 1 ? 5 : player.speedMult === 5 ? 25 : 1; onToast?.('speed:' + player.speedMult) }
    else if (name === 'switch') { enterWorld(active === 'target' ? 'earth' : 'target'); onToast?.('switch:' + active) }
    else if (name === 'board') {
      if (!vehicle) { onToast?.('rover-loading'); return null }
      if (player.driving) exitVehicle()
      else if (Math.hypot(vehicle.state.x - player.pos.x, vehicle.state.z - player.pos.z) < 8) { player.driving = true; player.vel.set(0, 0, 0); player.yaw = vehicle.state.yaw + Math.PI; player.pitch = 0.3; player.dist = 13; onToast?.('board') }
      else onToast?.('rover-far')
    }
    else if (name === 'rover') { if (!state.rover) return null; if (active === 'rover') { enterWorld('target'); onToast?.('switch:target') } else { state.rover.ready = false; player.pos.set(0, 0, 0); enterWorld('rover', false); onToast?.('rover') } }
    else if (name === 'flag') {
      if (w.flags.length >= 20) { onToast?.('flag-limit'); return }
      const flag = { x: player.pos.x + Math.sin(player.facing) * 0.9, z: player.pos.z + Math.cos(player.facing) * 0.9, yaw: player.facing - Math.PI / 2 }
      w.flags.push(flag); flagGroup.add(makeFlag(flag, w)); onToast?.('flag:' + w.flags.length)
    } else if (name === 'scan') return scan()
    else if (name === 'photo') return photo()
    else if (name === 'recenter') teleport(0.5, 0.5)
    else if (name === 'summon') { if (vehicle && !player.driving) { delete vehiclePose[active]; placeVehicle(5.5); onToast?.('summon') } }
    return null
  }

  function scanWorld(key, x, z) {
    const w = state[key], f = w.field
    const cx = clamp(x, -f.half, f.half), cz = clamp(z, -f.half, f.half)
    const samples = []
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) samples.push(f.absolute(cx + i * 50, cz + j * 50))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length)
    const wide = []
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) wide.push(f.absolute(cx + i * 125, cz + j * 125))
    return { body: w.body, label: w.label, elevation: f.absolute(cx, cz), slope: f.slopeDeg(cx, cz), relief500: Math.max(...wide) - Math.min(...wide), roughness300: sd, nativeCell: f.nativeCell,
      bootCm: bootSinkage(w.body, w.profile.gravity, f.slopeDeg(cx, cz)) * 100, wheelCm: terraFor(w).sinkage * 100 }
  }
  // B6: rover terramechanics per world (cached) and the energy used so far in each world
  const terraCache = {}, roverEnergy = {}
  const terraFor = w => terraCache[w.body] ||= roverModel(w.body, w.profile.gravity)
  function roverReport() {
    const w = state[active], m = terraFor(w), e = roverEnergy[active] || { wh: 0, dist: 0 }
    return { powerW: player.driving ? vehicle.state.powerW || 0 : 0, slip: player.driving ? vehicle.state.slip || 0 : 0, batteryPct: Math.max(0, 100 - e.wh / ROVER.batteryWh * 100),
      whPerKm: e.dist > 50 ? e.wh / (e.dist / 1000) : null, limitDeg: m.limitDeg, sinkCm: m.sinkage * 100, crr: m.crr }
  }
  function scan() {
    if (state[active].kind === 'tiles') return { unsupported: true }
    emitDust(player.pos.x, player.pos.z, 4, 0.4)
    return { x: player.pos.x, z: player.pos.z, active, here: scanWorld(active, player.pos.x, player.pos.z), other: scanWorld(active === 'target' ? 'earth' : 'target', player.pos.x, player.pos.z) }
  }

  function photo() {
    draw()
    const url = renderer.domElement.toDataURL('image/png')
    const link = document.createElement('a')
    link.href = url
    link.download = `twinground-eva-${state[active].body}-${Date.now()}.png`
    document.body.appendChild(link); link.click(); link.remove()
    return true
  }

  function teleport(u, v) {
    const f = state[active].field
    player.pos.x = clamp((u - 0.5) * f.sizeM, -f.half + 2, f.half - 2)
    player.pos.z = clamp((v - 0.5) * f.sizeM, -f.half + 2, f.half - 2)
    near?.update(player.pos.x, player.pos.z)
    if (!Number.isFinite(ground(player.pos.x, player.pos.z))) { onToast?.('no-mesh'); const back = state[active].path.filter(Boolean).at(-1) || [0, 0]; player.pos.x = back[0]; player.pos.z = back[1] }
    player.pos.y = groundOr(player.pos.x, player.pos.z, player.pos.y)
    player.vel.set(0, 0, 0); player.vy = 0; player.grounded = true
    state[active].path.push(null, [player.pos.x, player.pos.z])
    regenerateRocks(true); seedFloaters()
    if (player.driving && vehicle) vehicle.place(player.pos.x, player.pos.z, vehicle.state.yaw, (qx, qz) => ground(qx, qz))
    gaitReset()
    onToast?.('teleport')
  }

  // Pointer camera control
  const pointers = new Map()
  let pinchStart = 0, pinchDist = 0
  const onPointerDown = e => {
    renderer.domElement.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchStart = Math.hypot(a.x - b.x, a.y - b.y); pinchDist = player.dist }
  }
  const onPointerMove = e => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchStart > 0) player.dist = clamp(pinchDist * pinchStart / d, 1.8, 60)
      return
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y
    p.x = e.clientX; p.y = e.clientY
    player.yaw -= dx * 0.0055
    if (player.view === 'third') player.pitch = clamp(player.pitch + dy * 0.004, -0.15, 1.35)
    else player.fpPitch = clamp(player.fpPitch - dy * 0.004, -1.3, 1.3)
  }
  const onPointerUp = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = 0 }
  const onWheel = e => { e.preventDefault(); player.dist = clamp(player.dist * Math.exp(e.deltaY * 0.0012), 1.8, 60) }
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointercancel', onPointerUp)
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
  renderer.domElement.style.touchAction = 'none'

  // Minimap
  let planning = false, mapCenter = null, lastView = null
  function mapViewFor(w) {
    if (!planning || w.kind === 'tiles') return null
    const f = w.field, size = Math.min(f.sizeM, 6000)
    if (size >= f.sizeM) return null
    const lim = f.half - size / 2
    if (!mapCenter || mapCenter[2] !== active || Math.abs(player.pos.x - mapCenter[0]) > size * 0.35 || Math.abs(player.pos.z - mapCenter[1]) > size * 0.35)
      mapCenter = [clamp(player.pos.x, -lim, lim), clamp(player.pos.z, -lim, lim), active]
    const x0 = mapCenter[0] - size / 2, z0 = mapCenter[1] - size / 2
    return { x0, z0, size, key: [active, Math.round(x0), Math.round(z0), f.exaggeration, w.textureState].join(':') }
  }
  function minimapBase(w, view = null) {
    if (!view && w.minimapBase) return w.minimapBase
    if (view && w.minimapZoom?.key === view.key) return w.minimapZoom.canvas
    if (w.kind === 'tiles') {
      const c = document.createElement('canvas'); c.width = c.height = 256
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#2a1a14'; ctx.fillRect(0, 0, 256, 256)
      ctx.strokeStyle = 'rgba(240,180,140,0.18)'; ctx.lineWidth = 1
      for (let i = 0; i <= 250; i += 25) { const q = i / 250 * 256; ctx.beginPath(); ctx.moveTo(q, 0); ctx.lineTo(q, 256); ctx.moveTo(0, q); ctx.lineTo(256, q); ctx.stroke() }
      w.minimapBase = c
      return c
    }
    const f = w.field, S = 256, canvas = document.createElement('canvas')
    canvas.width = canvas.height = S
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(S, S)
    const light = new THREE.Vector3(-1, 1.4, -1).normalize()
    const [a, b, c] = w.profile.palette.map(x => new THREE.Color(x))
    const span = Math.max(1, f.maxH - f.minH)
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const wx = view ? view.x0 + x / (S - 1) * view.size : (x / (S - 1) - 0.5) * f.sizeM, wz = view ? view.z0 + y / (S - 1) * view.size : (y / (S - 1) - 0.5) * f.sizeM
      const [gx, gz] = f.gradient(wx, wz, (view ? view.size : f.sizeM) / S)
      const n = new THREE.Vector3(-gx * 3, 1, -gz * 3).normalize()
      const shade = clamp(0.7 + (n.dot(light) - 0.7) * 2.2, 0.45, 1.35)
      const t = (f.height(wx, wz) - f.minH) / span
      const col = (t < 0.5 ? a.clone().lerp(b, t * 2) : b.clone().lerp(c, (t - 0.5) * 2)).lerp(b, 0.35).multiplyScalar(shade * 1.25)
      const i = (y * S + x) * 4
      img.data[i] = clamp(col.r * 255, 0, 255); img.data[i + 1] = clamp(col.g * 255, 0, 255); img.data[i + 2] = clamp(col.b * 255, 0, 255); img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    if (w.texture?.image) {
      ctx.globalAlpha = 0.72; ctx.globalCompositeOperation = 'multiply'
      const im = w.texture.image, tw = im.width, th = im.height
      if (view) ctx.drawImage(im, (view.x0 / f.sizeM + 0.5) * tw, (view.z0 / f.sizeM + 0.5) * th, view.size / f.sizeM * tw, view.size / f.sizeM * th, 0, 0, S, S)
      else ctx.drawImage(im, 0, 0, S, S)
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    }
    if (view) w.minimapZoom = { key: view.key, canvas }; else w.minimapBase = canvas
    return canvas
  }
  function drawMinimap() {
    if (!minimap) return
    const w = state[active], f = w.field, ctx = minimap.getContext('2d'), S = minimap.width
    const view = lastView = mapViewFor(w)
    ctx.drawImage(minimapBase(w, view), 0, 0, S, S)
    const toMap = view ? (x, z) => [(x - view.x0) / view.size * S, (z - view.z0) / view.size * S] : (x, z) => [(x / f.sizeM + 0.5) * S, (z / f.sizeM + 0.5) * S]
    ctx.strokeStyle = '#ececec'; ctx.lineWidth = 2; ctx.beginPath()
    let pen = false
    for (const point of w.path) {
      if (!point) { pen = false; continue }
      const [mx, my] = toMap(point[0], point[1])
      if (pen) ctx.lineTo(mx, my); else { ctx.moveTo(mx, my); pen = true }
    }
    const [px, py] = toMap(player.pos.x, player.pos.z)
    if (pen) ctx.lineTo(px, py)
    ctx.stroke()
    if (cover && cover.v && coverMode !== 'off') {
      // B5: cells without line of sight are tinted (red: no radio path to the base; blue: Earth hidden), covered ones faint mint
      const cv = cover.v, N = cover.N, [ox, oy] = toMap(cv.x0, cv.z0), [ex] = toMap(cv.x0 + cv.size, cv.z0)
      if (!cover.canvas) { cover.canvas = document.createElement('canvas'); cover.canvas.width = cover.canvas.height = N; cover.img = cover.canvas.getContext('2d').createImageData(N, N) }
      const px = cover.img.data, tint = coverMode === 'earth' ? [80, 130, 255] : [230, 90, 84]
      for (let i = 0; i < N * N; i++) { const v = cover.data[i], c = v === 2 ? tint : [236, 236, 236]; px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = v === 2 ? 125 : v === 1 ? 42 : 0 }
      cover.canvas.getContext('2d').putImageData(cover.img, 0, 0)
      ctx.imageSmoothingEnabled = true; ctx.drawImage(cover.canvas, ox, oy, ex - ox, ex - ox)
      if (coverMode === 'base') { const [bx, by] = toMap(...baseAt(w)); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2); ctx.stroke() }
    }
    if (route.points.length) {
      ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]); ctx.beginPath()
      route.points.forEach(([x, z], i) => { const [rx, ry] = toMap(x, z); if (i) ctx.lineTo(rx, ry); else ctx.moveTo(rx, ry) })
      ctx.stroke(); ctx.setLineDash([])
      route.points.forEach(([x, z], i) => { const [rx, ry] = toMap(x, z); ctx.fillStyle = i ? '#ffd27a' : '#ffffff'; ctx.beginPath(); ctx.arc(rx, ry, i ? 3.5 : 4.5, 0, Math.PI * 2); ctx.fill() })
    }
    const [sx, sy] = toMap(0, 0)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(sx - 3, sy - 3, 6, 6)
    ctx.fillStyle = '#e65a54'
    w.flags.forEach(fl => { const [fx, fy] = toMap(fl.x, fl.z); ctx.fillRect(fx - 1, fy - 7, 2, 8); ctx.fillRect(fx, fy - 7, 6, 4) })
    for (const mk of missionMarks[active] || []) {
      const [mx, my] = toMap(mk.x, mk.z); ctx.fillStyle = mk.kind === 'sample' ? '#ff7a2f' : '#f3c27a'; ctx.beginPath()
      if (mk.kind === 'sample') ctx.arc(mx, my, 3, 0, Math.PI * 2); else { ctx.moveTo(mx, my - 5); ctx.lineTo(mx + 5, my); ctx.lineTo(mx, my + 5); ctx.lineTo(mx - 5, my) }
      ctx.fill()
    }
    if (baseSites[active]) { const [hx, hy] = toMap(baseSites[active].x, baseSites[active].z); ctx.strokeStyle = '#ececec'; ctx.lineWidth = 2; ctx.strokeRect(hx - 5, hy - 5, 10, 10) }
    const look = Math.atan2(-Math.cos(player.yaw), -Math.sin(player.yaw))
    ctx.fillStyle = 'rgba(248,248,248,0.18)'; ctx.beginPath(); ctx.moveTo(px, py)
    ctx.arc(px, py, 34, look - 0.5, look + 0.5); ctx.closePath(); ctx.fill()
    ctx.save(); ctx.translate(px, py); ctx.rotate(-player.facing + Math.PI)
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0b1a1f'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath(); ctx.stroke(); ctx.fill()
    ctx.restore()
  }

  // Main loop
  let last = performance.now(), frame = 0, statsTimer = 0, disposed = false, pathTimer = 0, clock = 0, mapTick = 0, eyeAdapt = 1
  const tmp = new THREE.Vector3(), desired = new THREE.Vector3()

  function findRoverStart() {
    const w = state.rover
    if (performance.now() < w.nextTry) return
    w.nextTry = performance.now() + 400
    for (let r = 0; r <= 40; r += 2) for (let k = 0; k < Math.max(1, r * 2); k++) {
      const a = k / Math.max(1, r * 2) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r
      const h = roverHeight(x, z)
      if (Number.isFinite(h) && Number.isFinite(roverHeight(x + 1, z)) && Number.isFinite(roverHeight(x, z + 1))) {
        player.pos.set(x, h, z); player.vel.set(0, 0, 0); player.vy = 0; player.grounded = true
        w.ready = true; w.textureState = 'ready'; w.path.push([x, z])
        gaitReset(); placeVehicle()
        return
      }
    }
  }

  function step(dt) {
    const w = state[active], f = w.field, p = w.profile
    const g = p.gravity
    if (w.kind === 'tiles' && !w.ready) { findRoverStart(); return }
    if (player.driving && vehicle) { driveStep(dt); return }
    player.yaw += (input.camL - input.camR) * dt * 1.6
    if (input.zoomIn) player.dist = clamp(player.dist * (1 - dt * 1.5), 1.8, 60)
    if (input.zoomOut) player.dist = clamp(player.dist * (1 + dt * 1.5), 1.8, 60)
    const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw)
    const rightX = Math.cos(player.yaw), rightZ = -Math.sin(player.yaw)
    let mx = (input.r - input.l) + input.joyX, mz = (input.f - input.b) + input.joyY
    let mag = Math.min(1, Math.hypot(mx, mz))
    let followDir = null
    if (route.follow && mag > 0.05) { route.follow = false; onToast?.('route-stop') }
    if (route.follow) {
      while (route.next < route.points.length && Math.hypot(route.points[route.next][0] - player.pos.x, route.points[route.next][1] - player.pos.z) < 1.2) route.next++
      if (route.next >= route.points.length) { route.follow = false; onToast?.('route-done') }
      else {
        const [tx, tz] = route.points[route.next], d = Math.hypot(tx - player.pos.x, tz - player.pos.z)
        followDir = [(tx - player.pos.x) / d, (tz - player.pos.z) / d]
        let turn = Math.atan2(-followDir[0], -followDir[1]) - player.yaw
        turn = Math.atan2(Math.sin(turn), Math.cos(turn)); player.yaw += turn * Math.min(1, dt * 1.5)
      }
    }
    desired.set(0, 0, 0)
    if (mag > 0.05) {
      const n = Math.hypot(mx, mz); mx /= n; mz /= n
      desired.set(rightX * mx + fwdX * mz, 0, rightZ * mx + fwdZ * mz).normalize()
    }
    if (followDir) { desired.set(followDir[0], 0, followDir[1]); mag = 1 }
    const running = player.run || Math.hypot(input.joyX, input.joyY) > 0.92
    let target = (running ? p.run : p.walk) * mag * player.speedMult
    // Uphill grade on the DEM slows the astronaut; very steep slopes stop progress.
    if (mag > 0.05) {
      const [gx, gz] = f.gradient(player.pos.x, player.pos.z)
      const grade = (gx * desired.x + gz * desired.z) / f.exaggeration
      target *= clamp(1 - Math.max(0, grade) * 2.2, 0.15, 1)
      if (Math.atan(Math.max(0, grade)) > THREE.MathUtils.degToRad(34)) target = 0
    }
    desired.multiplyScalar(target)
    // Traction is friction times gravity, so low gravity feels slippery.
    const accel = player.grounded ? (player.speedMult > 1 ? 60 : Math.max(1.4, 0.75 * g)) : 0.15
    tmp.set(desired.x - player.vel.x, 0, desired.z - player.vel.z)
    const maxDelta = accel * dt
    if (tmp.length() > maxDelta) tmp.setLength(maxDelta)
    player.vel.add(tmp)
    const speed = Math.hypot(player.vel.x, player.vel.z)
    const lope = p.hop > 0 && running && speed > p.run * 0.7 && player.speedMult === 1
    // Jumps start with a short crouch; the low-gravity lope launches straight from the stride.
    if (input.jump && player.grounded && player.jumpCharge <= 0) player.jumpCharge = 0.16
    input.jump = false
    let launch = false
    if (player.jumpCharge > 0) { player.jumpCharge -= dt; if (player.jumpCharge <= 0) { player.jumpCharge = 0; launch = player.grounded } }
    if (player.grounded && (launch || (lope && player.airTime > 0.12))) {
      player.vy = launch ? JUMP_SPEED : Math.sqrt(2 * g * p.hop)
      player.grounded = false; player.airTime = 0
    }
    let nx = player.pos.x + player.vel.x * dt, nz = player.pos.z + player.vel.z * dt
    const colliders = propCollider ? rockColliders.concat([propCollider]) : rockColliders
    for (const rock of colliders) {
      const dx = nx - rock.x, dz = nz - rock.z, d = Math.hypot(dx, dz), minD = rock.r + 0.3
      if (d < minD && player.pos.y < rock.top - 0.15 && d > 1e-4) { nx = rock.x + dx / d * minD; nz = rock.z + dz / d * minD }
    }
    const lim = f.half - 2
    if (Math.abs(nx) > lim || Math.abs(nz) > lim) {
      if (performance.now() - player.boundaryNotice > 2500) { onToast?.('boundary'); player.boundaryNotice = performance.now() }
      nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim)
    }
    if (w.kind === 'tiles' && !Number.isFinite(ground(nx, nz))) {
      // No stereo coverage here: the mesh ends where the rover's cameras could not see.
      if (performance.now() - player.boundaryNotice > 2500) { onToast?.('no-mesh'); player.boundaryNotice = performance.now() }
      nx = player.pos.x; nz = player.pos.z; player.vel.set(0, 0, 0)
    }
    const moved = Math.hypot(nx - player.pos.x, nz - player.pos.z)
    player.pos.x = nx; player.pos.z = nz
    player.distance += moved
    player.dustByWorld[active] += player.speedMult === 1 ? moved : 0
    near?.update(nx, nz)
    const groundY = groundOr(nx, nz, player.pos.y)
    if (player.grounded) {
      if (player.pos.y - groundY > 0.35 && speed > 0.1) { player.grounded = false; player.vy = 0 }
      else player.pos.y = groundY
    }
    if (!player.grounded) {
      player.vy -= g * dt
      player.pos.y += player.vy * dt
      player.airTime += dt
      if (player.pos.y <= groundY) {
        player.pos.y = groundY
        const impact = -player.vy
        player.grounded = true; player.vy = 0; player.airTime = 0
        player.impact = impact
      }
    } else player.airTime += dt
    if (speed > 0.05) {
      const targetFacing = Math.atan2(player.vel.x, player.vel.z)
      let diff = targetFacing - player.facing
      diff = Math.atan2(Math.sin(diff), Math.cos(diff))
      player.facing += diff * Math.min(1, dt * 8)
    }
    {
      const [ogx, ogz] = f.gradient(player.pos.x, player.pos.z), real = speed / Math.max(1, player.speedMult)
      const along = speed > 0.05 ? (ogx * player.vel.x + ogz * player.vel.z) / speed / f.exaggeration : 0
      const metW = metabolicPower(real, along, g, route.load)
      player.o2 = Math.max(0, player.o2 - o2Percent(metW * dt))
      updateLife(dt, metW)
    }
    pathTimer += moved
    if (pathTimer > Math.max(3, f.sizeM / 2000)) { w.path.push([player.pos.x, player.pos.z]); pathTimer = 0; if (w.path.length > 6000) w.path.splice(0, 1000) }
    animateAstronaut(dt)
    updateDust(dt, p)
    updateFloaters(dt)
    regenerateRocks(); regenerateGravel()
  }

  let dustTimer = 0
  const bodyPos = new THREE.Vector3(0, NaN, 0)
  function gaitState(pos = player.pos) {
    const w = state[active], p = w.profile, f = w.field
    const speed = Math.hypot(player.vel.x, player.vel.z)
    const running = player.run || Math.hypot(input.joyX, input.joyY) > 0.92
    const [gx, gz] = f.gradient(player.pos.x, player.pos.z)
    let lookYaw = Math.atan2(-Math.sin(player.yaw), -Math.cos(player.yaw)) - player.facing
    lookYaw = Math.atan2(Math.sin(lookYaw), Math.cos(lookYaw))
    return {
      pos, facing: player.facing, vel: player.vel, speed, grounded: player.grounded, vy: player.vy, impact: player.impact,
      running, lope: p.hop > 0 && running && speed > p.run * 0.7 && player.speedMult === 1, gravity: p.gravity, walkSpeed: p.walk, runSpeed: p.run,
      groundAt: groundOr, crouch: player.jumpCharge > 0 ? 1 - player.jumpCharge / 0.16 : 0,
      grade: ((gx * Math.sin(player.facing) + gz * Math.cos(player.facing)) / (f.exaggeration || 1)) || 0, lookYaw, reducedMotion,
    }
  }
  function animateAstronaut(dt) {
    const a = astro, p = state[active].profile
    // The body glides over regolith bumps the legs absorb: its height is low-passed, the feet still land on the ground.
    if (!player.grounded || player.driving || Math.abs(player.pos.y - bodyPos.y) > 1.5 || !Number.isFinite(bodyPos.y)) bodyPos.y = player.pos.y
    else bodyPos.y += (player.pos.y - bodyPos.y) * Math.min(1, dt * 9)
    bodyPos.x = player.pos.x; bodyPos.z = player.pos.z
    a.root.position.copy(bodyPos)
    a.root.rotation.y = player.facing
    if (a.animate) a.animate(gaitState(bodyPos), dt, false, clipPlant); else gait.update(a, gaitState(bodyPos), dt)
    player.impact = 0
    // a headlamp is barely visible in sunlight; full strength in shadow and at night
    a.headlamp.intensity = player.lamp ? 120 * (1 - 0.85 * clamp(sun.intensity * shared.uPlayerSunVis.value / 3, 0, 1)) : 0
    a.root.visible = player.view === 'third' && !player.driving
    dustTimer += dt
    if (dustTimer > 1) { dustTimer = 0; astro.setDust(new THREE.Color(p.suitDust), player.dustByWorld[active] / 1500) }
  }

  function driveStep(dt) {
    const w = state[active], f = w.field, p = w.profile
    const throttle = clamp((input.f - input.b) + input.joyY, -1, 1)
    const steer = clamp((input.l - input.r) - input.joyX, -1, 1)
    vehicle.update(dt, { throttle, steer, brake: input.jump || input.brake }, (x, z) => ground(x, z), {
      gravity: p.gravity, speedMult: player.speedMult, colliders: propCollider ? rockColliders.concat([propCollider]) : rockColliders, half: f.half,
      onDust: (x, z, v, dx, dz) => emitDust(x, z, 4, 0.3 + v * 0.3, dx === undefined ? null : { x: dx, z: dz }),
      terra: terraFor(w),
      onBlocked: why => { if (performance.now() - player.boundaryNotice > 2500) { onToast?.('drive-' + why); player.boundaryNotice = performance.now() } },
    })
    input.jump = false
    const st = vehicle.state
    const moved = Math.hypot(st.x - player.pos.x, st.z - player.pos.z)
    player.pos.set(st.x, st.y, st.z); player.facing = st.yaw
    player.vel.set(Math.sin(st.yaw) * st.speed, 0, Math.cos(st.yaw) * st.speed)
    player.distance += moved
    { const e = roverEnergy[active] ||= { wh: 0, dist: 0 }; e.wh += (vehicle.state.powerW || 0) * dt / 3600; e.dist += moved }
    near?.update(st.x, st.z)
    pathTimer += moved
    if (pathTimer > Math.max(3, f.sizeM / 2000)) { w.path.push([st.x, st.z]); pathTimer = 0; if (w.path.length > 6000) w.path.splice(0, 1000) }
    // The chase camera eases in behind the rover unless the user is dragging the view.
    if (!pointers.size) { let d = (st.yaw + Math.PI) - player.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); player.yaw += d * Math.min(1, dt * 1.2) }
    player.yaw += (input.camL - input.camR) * dt * 1.6
    if (input.zoomIn) player.dist = clamp(player.dist * (1 - dt * 1.5), 6, 60)
    if (input.zoomOut) player.dist = clamp(player.dist * (1 + dt * 1.5), 6, 60)
    player.o2 = Math.max(0, player.o2 - dt * (100 / (8 * 3600)) * 0.5)
    updateLife(dt, 150)
    if (astro.animate && vehicle?.seat && player.view === 'third') {
      vehicle.group.updateMatrixWorld()
      astro.root.position.copy(vehicle.seat).applyMatrix4(vehicle.group.matrixWorld); astro.root.quaternion.copy(vehicle.group.quaternion)
      astro.animate(gaitState(), dt, true); astro.root.visible = true
    } else astro.root.visible = false
    updateDust(dt, p); updateFloaters(dt); regenerateRocks(); regenerateGravel()
  }

  function updateDust(dt, p) {
    let alive = false
    const air = p.dustDrag > 0, windSpeed = air ? (current?.weather?.wind || 0) : 0, windX = 0.96 * windSpeed, windZ = 0.27 * windSpeed
    for (let i = 0; i < DUST; i++) {
      if (dustLife[i] <= 0) { dustCol[i * 4 + 3] = 0; continue }
      alive = true
      // A7: on airless bodies every grain flies a clean parabola and stops where it lands; in an atmosphere the grains are
      // dragged toward the wind, and the fine fraction settles at ~0.12 m/s and drifts downwind as a haze.
      if (!air) dustVel[i * 3 + 1] -= p.gravity * dt
      else {
        const fine = dustFine[i], d = Math.exp(-p.dustDrag * (fine ? 3 : 1) * dt)
        dustVel[i * 3] = windX + (dustVel[i * 3] - windX) * d; dustVel[i * 3 + 2] = windZ + (dustVel[i * 3 + 2] - windZ) * d
        dustVel[i * 3 + 1] = fine ? -0.12 + (dustVel[i * 3 + 1] + 0.12) * d : dustVel[i * 3 + 1] * d - p.gravity * dt * 0.25
      }
      dustPos[i * 3] += dustVel[i * 3] * dt; dustPos[i * 3 + 1] += dustVel[i * 3 + 1] * dt; dustPos[i * 3 + 2] += dustVel[i * 3 + 2] * dt
      const gy = dustGround[i]
      if (dustPos[i * 3 + 1] < gy) { dustPos[i * 3 + 1] = gy; if (!air) dustLife[i] = 0; else { dustVel[i * 3 + 1] = 0; dustLife[i] -= dt * (dustFine[i] ? 0.3 : 0.8) } }
      dustLife[i] -= dt * (!air ? 0.25 : dustFine[i] ? 0.12 : 0.45)
      dustCol[i * 4 + 3] = clamp(dustLife[i], 0, 1) * (air && dustFine[i] ? 0.45 : 0.85)
    }
    if (alive) { dustGeometry.attributes.position.needsUpdate = true; dustGeometry.attributes.color.needsUpdate = true }
  }

  let windT = 0
  function updateFloaters(dt) {
    windT += dt
    if (floaters.visible) {
      const f = state[active].field
      for (let i = 0; i < FLOAT; i++) {
        let x = floatPos[i * 3] + dt * (0.9 + Math.sin(i + windT * 0.3) * 0.4), y = floatPos[i * 3 + 1] + Math.sin(windT + i) * dt * 0.05, z = floatPos[i * 3 + 2] + dt * 0.25
        if (x - player.pos.x > 20) x -= 40
        if (z - player.pos.z > 20) z -= 40
        if (x - player.pos.x < -20) x += 40
        if (z - player.pos.z < -20) z += 40
        const gy = f.height(x, z)
        if (y < gy + 0.1 || y > gy + 7) y = gy + 0.2 + ((i * 37) % 60) / 10
        floatPos.set([x, y, z], i * 3)
      }
      floatGeometry.attributes.position.needsUpdate = true
    }
    flagGroup.children.forEach((g, gi) => {
      const cloth = g.children.find(o => o.userData.base)
      if (!cloth || !cloth.userData.wind || reducedMotion) return
      if (g.position.distanceToSquared(player.pos) > 250 * 250) return
      const pos = cloth.geometry.attributes.position, base = cloth.userData.base, strength = state[active].body === 'mars' ? 0.05 : 0.09
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3]
        pos.setZ(i, Math.sin(x * 7 - windT * 6 + gi) * strength * x + Math.sin(base[i * 3 + 1] * 9 + windT * 4) * 0.01 * x)
      }
      pos.needsUpdate = true
      cloth.geometry.computeVertexNormals()
    })
  }

  function updateCamera(dt) {
    if (player.view === 'first') {
      const bob = 0
      if (player.driving && vehicle) camera.position.copy(vehicle.eyeOffset).applyEuler(vehicle.group.rotation).add(vehicle.group.position)
      else camera.position.set(player.pos.x + Math.sin(player.facing) * 0.12, (player.grounded && Number.isFinite(bodyPos.y) ? bodyPos.y : player.pos.y) + EYE_HEIGHT + bob, player.pos.z + Math.cos(player.facing) * 0.12)
      const dir = new THREE.Vector3(-Math.sin(player.yaw) * Math.cos(player.fpPitch), Math.sin(player.fpPitch), -Math.cos(player.yaw) * Math.cos(player.fpPitch))
      camera.lookAt(camera.position.clone().add(dir))
      camera.fov = 70
    } else {
      const target = new THREE.Vector3(player.pos.x, (player.driving || !Number.isFinite(bodyPos.y) ? player.pos.y : bodyPos.y) + (player.driving ? 2.4 : 1.4), player.pos.z)
      const offset = new THREE.Vector3(Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), Math.cos(player.yaw) * Math.cos(player.pitch)).multiplyScalar(player.dist)
      const want = target.clone().add(offset)
      want.y = Math.max(want.y, groundOr(want.x, want.z, -Infinity) + 0.45)
      camera.position.lerp(want, 1 - Math.exp(-dt * 12))
      camera.position.y = Math.max(camera.position.y, groundOr(camera.position.x, camera.position.z, -Infinity) + 0.35)
      camera.lookAt(target)
      camera.fov = 50
    }
    camera.updateProjectionMatrix()
    if (player.view === 'first' || player.driving || !astro.root.visible) {
      camera.getWorldDirection(lampDir)
      lamp.position.copy(camera.position); lamp.target.position.copy(camera.position).addScaledVector(lampDir, 4); lamp.target.position.y -= 0.6
    } else {
      astro.head.updateWorldMatrix(true, false)
      lamp.position.copy(lampLocal).applyMatrix4(astro.head.matrixWorld); lamp.target.position.copy(lampAim).applyMatrix4(astro.head.matrixWorld)
    }
    const dir = sunDirection()
    sky.position.copy(camera.position); sky.scale.setScalar(120)
    stars.position.copy(camera.position); stars.scale.setScalar(50)
    sunSprite.position.copy(camera.position).addScaledVector(dir, 40000)
    sunSprite.material.opacity = state[active].body === 'moon' ? 1 : 0.6
    if (earthGlobe.visible) {
      const D = 40000
      earthGlobe.position.copy(camera.position).addScaledVector(earthDirection, D)
      earthGlobe.scale.setScalar(D * Math.tan(THREE.MathUtils.degToRad(0.95)))
      earthGlobe.rotation.y = clock * 0.01
    }
    sun.position.copy(player.pos).addScaledVector(dir, 150)
    sun.target.position.copy(player.pos)
    if (sunFar) { sunFar.position.copy(player.pos).addScaledVector(dir, 500); sunFar.target.position.copy(player.pos); sunFar.color.copy(sun.color); sunFar.intensity = sun.intensity }
    cascade.center.value.copy(player.pos)
  }

  function emitStats() {
    const w = state[active], f = w.field, R = w.profile.radius
    const degPerM = 180 / (Math.PI * R)
    const lat = w.lat - player.pos.z * degPerM
    const lon = ((w.lon + player.pos.x * degPerM / Math.cos(THREE.MathUtils.degToRad(w.lat)) + 540) % 360) - 180
    const speed = Math.hypot(player.vel.x, player.vel.z)
    const headingDeg = ((THREE.MathUtils.radToDeg(Math.atan2(Math.sin(player.facing), -Math.cos(player.facing))) + 360) % 360)
    const lookDeg = ((THREE.MathUtils.radToDeg(Math.atan2(-Math.sin(player.yaw), Math.cos(player.yaw))) + 360) % 360)
    onStats?.({
      world: active, body: w.body, label: w.label, lat, lon,
      elevation: f.absolute(player.pos.x, player.pos.z), slope: f.slopeDeg(player.pos.x, player.pos.z),
      heading: headingDeg, look: lookDeg, speed, distance: player.distance, elapsed: (performance.now() - player.startTime) / 1000,
      o2: player.o2, grounded: player.grounded, altitude: player.pos.y - groundOr(player.pos.x, player.pos.z, player.pos.y),
      kind: w.kind || 'dem', loading: w.kind === 'tiles' && !w.ready, suitModel, hasRover: !!state.rover,
      ready: revealed, suitSettled, roverSettled, propSettled: !propPending, terrainDetail: f.detail,
      loading: revealed ? null : { stage: loadStage, programs: warmup?.progress.programs || null, textures: warmup?.progress.textures || null },
      view: player.view, lamp: player.lamp, rocks: player.rocks, speedMult: player.speedMult, run: player.run,
      gravity: w.profile.gravity, nativeCell: f.nativeCell, exaggeration: f.exaggeration, textureState: w.textureState,
      textureCredit: w.textureCredit, horizonKm: Math.sqrt(2 * R * EYE_HEIGHT) / 1000, sizeKm: f.sizeM / 1000,
      fromStart: Math.hypot(player.pos.x, player.pos.z), sunElevation, sunAzimuth, flags: w.flags.length,
      jumpHeight: JUMP_SPEED ** 2 / (2 * w.profile.gravity), prop: propGroup ? PROPS[w.body]?.name : null,
      earthInSky: w.body === 'moon' && earthGlobe.visible, earthElevation: THREE.MathUtils.radToDeg(Math.asin(clamp(earthDirection.y, -1, 1))),
      time: { ...worldTime[active] }, weather: current?.weather, dayLength: current?.dayLength, climateState,
      conditions: { target: conditionsFor(active === 'earth' ? 'target' : active), earth: conditionsFor('earth') },
      driving: player.driving, vehicleReady: !!vehicle, vehicleNear: !!vehicle && !player.driving && Math.hypot(vehicle.state.x - player.pos.x, vehicle.state.z - player.pos.z) < 8,
      vehicle: vehicle ? { speed: vehicle.state.speed, pitch: vehicle.state.pitch * 180 / Math.PI, roll: vehicle.state.roll * 180 / Math.PI, ...roverReport() } : null,
      fps, resScale, quality, postOn, sunVisHere: shared.uPlayerSunVis.value,
      route: { n: route.points.length, follow: route.follow, next: route.next, load: route.load }, eyeAdapt,
      mapKm: (lastView ? lastView.size : f.sizeM) / 1000,
      life: lifeReport(), comm: commReport(), coverMode,
    })
  }

  // Before the scene is shown: compile every shader (in parallel where KHR_parallel_shader_compile exists) and upload
  // textures a few at a time, so no single task blocks the page and the first frames draw without stalls.
  function startWarmup() {
    scene.updateMatrixWorld(true)
    let materials = new Set()
    try { materials = renderer.compile(scene, camera) } catch { /* compiled on first draw */ }
    const textures = new Set()
    const addTexture = v => { if (v && v.isTexture && !v.isRenderTargetTexture && v.image) textures.add(v) }
    scene.traverse(o => {
      if (!o.material) return
      for (const m of [].concat(o.material)) {
        for (const v of Object.values(m)) addTexture(v)
        if (m.uniforms) for (const u of Object.values(m.uniforms)) addTexture(u?.value)
      }
    })
    const queue = [...textures], started = performance.now()
    const progress = { programs: [0, materials.size], textures: [0, queue.length] }
    return {
      progress,
      step(now) {
        const t0 = performance.now()
        while (queue.length && performance.now() - t0 < 10) {
          try { renderer.initTexture(queue.shift()) } catch { /* uploaded on first draw */ }
          progress.textures[0]++
        }
        let ready = 0
        for (const m of materials) { const p = renderer.properties.get(m).currentProgram; if (!p || (p.isReady ? p.isReady() : true)) ready++ }
        progress.programs[0] = ready
        return !queue.length && (ready === materials.size || now - started > 10000)
      },
    }
  }

  function loop(now) {
    if (disposed) return
    frame = requestAnimationFrame(loop)
    // While the loading screen is up nothing is drawn: the main thread is left to decode the models and to warm up
    // shaders and textures in short slices; only the loading state is reported.
    if (!revealed) {
      last = now
      const report = () => { if (now - lastLoadingStats > 200) { lastLoadingStats = now; emitStats() } }
      if (!modelsReady()) { loadStage = 'models'; report(); return }
      if (!warmup) { cascadeAll(); applyReflections(); warmup = startWarmup(); loadStage = 'warmup' }
      if (!warmup.step(now)) { report(); return }
      loadStage = 'frames'
    }
    // Fixed sub-steps keep walking speed and gravity in real time on slow devices.
    const realDt = (now - last) / 1000
    let remaining = Math.min(0.25, realDt)
    const dt = Math.min(0.05, remaining)
    last = now
    clock += remaining
    tuneQuality(realDt)
    const t = worldTime[active]
    if (t.speed) { t.hour = ((t.hour + t.speed * remaining) % 24 + 24) % 24; condTimer = 0 }
    applyConditions(false, remaining)
    // Terrain shadow passes run a slice per frame; publish into the far mesh and the near tiles.
    const L = state[active].light
    if (L && L.step(mobile ? 700 : 3500) && terrainMesh) {
      terrainMesh.geometry.attributes.sunVis.array.set(L.sunVis); terrainMesh.geometry.attributes.sunVis.needsUpdate = true
      terrainMesh.geometry.attributes.skyVis.array.set(L.skyVis); terrainMesh.geometry.attributes.skyVis.needsUpdate = true
      near?.refreshLight()
      bindObjectSun()
    }
    const here = L ? L.sample(L.sunVis, player.pos.x, player.pos.z) : 1
    shared.uPlayerSunVis.value += (here - shared.uPlayerSunVis.value) * Math.min(1, remaining * 4)
    // A6: the eye opens up in a terrain shadow (slowly) and closes again in sunlight (quickly)
    {
      const day = look ? clamp(look.sunI / 2.5, 0, 1) : 0, light = 1 - day * (1 - shared.uPlayerSunVis.value)
      const want = clamp(1 / (0.38 + 0.62 * light), 1, 2.6)
      eyeAdapt += (want - eyeAdapt) * (1 - Math.exp(-remaining / (want > eyeAdapt ? 1.2 : 0.35)))
      renderer.toneMappingExposure = (look?.exposure ?? 1) * eyeAdapt
    }
    while (remaining > 1e-4) { const h = Math.min(0.05, remaining); step(h); remaining -= h }
    updateCamera(dt)
    if (roverTiles && active === 'rover') {
      for (const t of [roverTiles, roverSky]) { t.setCamera(camera); t.setResolutionFromRenderer(camera, renderer); t.update() }
    }
    updateWeatherFx(dt)
    skyUniforms.time.value = clock
    near?.setFocus(player.pos.x, player.pos.z)
    animateEdge(dt)
    if (coverMode !== 'off') coverStep(lastView, state[active])
    if (boundaryLine) {
      const f = state[active].field, toEdge = f.half - Math.max(Math.abs(player.pos.x), Math.abs(player.pos.z))
      boundaryLine.material.opacity = 0.5 * (1 - clamp((toEdge - 250) / 1200, 0, 1))
      boundaryLine.visible = boundaryLine.material.opacity > 0.01
    }
    {
      const ambient = clamp(1 - (look?.hemiI || 0.5) * 0.4, 0.25, 0.75)
      const gy = groundOr(player.pos.x, player.pos.z, player.pos.y), air = clamp((player.pos.y - gy) / 1.5, 0, 1)
      astroBlob.visible = !player.driving && astro.root.visible
      // contact shadow only: under direct sun the shadow map already draws the real shadow
      const direct = clamp(sun.intensity * shared.uPlayerSunVis.value / 3, 0, 1)
      astroBlob.position.set(player.pos.x, gy + 0.03, player.pos.z); astroBlob.scale.setScalar(0.75 + air * 0.5)
      blobMaterial.opacity = 0.34 * ambient * (1 - air * 0.7) * (1 - 0.6 * direct)
      roverBlob.visible = !!vehicle && vehicle.group.visible
      if (vehicle) {
        const st = vehicle.state
        roverBlob.position.set(st.x, groundOr(st.x, st.z, st.y) + 0.04, st.z); roverBlob.rotation.y = st.yaw
        roverBlob.scale.set(5.2, 1, 7.2); roverBlob.material.opacity = 0.5 * ambient * (1 - 0.5 * direct)
      }
    }
    if (grain) grain.uniforms.uTime.value = (clock * 7.3) % 100
    draw()
    statsTimer += dt
    if (statsTimer > (mobile ? 0.3 : 0.15)) { statsTimer = 0; emitStats(); if (!mobile || (mapTick = (mapTick + 1) % 2) === 0) drawMinimap() }
  }

  const resize = new ResizeObserver(() => {
    const width = container.clientWidth, height = container.clientHeight
    if (!width || !height) return
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height)
    composer?.setSize(width, height)
  })
  resize.observe(container)

  if (resScale !== 1) applyScale()
  enterWorld(initial, false)
  frame = requestAnimationFrame(loop)

  return {
    key, action, teleport,
    setJoystick(x, y) { input.joyX = x; input.joyY = y },
    // B2/B1: route in window coordinates (metres east/south of the window centre), shared by both sites
    setRoute(points) { route.points = points.map(([x, z]) => [x, z]); route.next = 1; if (route.points.length < 2) route.follow = false; buildRouteMesh() },
    setLoad(kg) { route.load = kg },
    playerXZ() { return [player.pos.x, player.pos.z] },
    setPlanning(on) { planning = !!on; mapCenter = null; mapTick = 0 },
    // B4: full-day daylight and temperature at the astronaut's position, for this site and the other one
    dayProfiles() { const x = player.pos.x, z = player.pos.z; return { here: active, target: dayProfile('target', x, z), earth: dayProfile('earth', x, z) } },
    // B5: minimap coverage overlay: 'off', 'base' (radio to the lander / base) or 'earth' (direct view of Earth, Moon only)
    setCover(mode) { coverMode = mode; cover = null; mapTick = 0 },
    mapToWorld(u, v) { const f = state[active].field, view = planning ? lastView : null; return view ? [view.x0 + u * view.size, view.z0 + v * view.size] : [(u - 0.5) * f.sizeM, (v - 0.5) * f.sizeM] },
    followRoute(on) {
      if (!on || route.points.length < 2 || player.driving) { route.follow = false; return false }
      let best = 0, bestD = Infinity
      route.points.forEach(([x, z], i) => { const d = Math.hypot(x - player.pos.x, z - player.pos.z); if (d < bestD) { bestD = d; best = i } })
      route.next = Math.min(route.points.length - 1, best + (bestD < 1.2 ? 1 : 0)); route.follow = true; return true
    },
    getRouteReport() {
      if (route.points.length < 2) return null
      const out = {}, k = Math.min(route.driveUntil || 0, route.points.length - 1)
      for (const key of ['target', 'earth']) {
        const w = state[key]
        if (!w || w.kind === 'tiles') continue
        const f = w.field, L = w.light, height = (x, z) => f.height(x, z) / f.exaggeration, o2Start = key === active ? player.o2 : 100
        const opts = { height, gravity: w.profile.gravity, load: route.load, sun: L ? (x, z) => L.sample(L.sunVis, x, z) : null, speedScale: w.profile.walk / 1.4 }
        // B6: drive the first k legs (suit at ~150 W while seated), then walk the rest
        const drive = k > 0 ? driveRoute(route.points.slice(0, k + 1), { height, body: w.body, gravity: w.profile.gravity }) : null
        const seatedO2 = drive ? o2Percent(150 * drive.time) : 0
        const walkPts = route.points.slice(k)
        const walk = walkPts.length >= 2 ? routeMetrics(walkPts, { ...opts, o2Start: o2Start - seatedO2 }) : null
        // walk-back if the rover fails at the far end: straight back to the route start on foot
        const far = route.points.at(-1), back = routeMetrics([far, route.points[0]], { ...opts, o2Start: 100 })
        out[key] = walk ? { ...walk, drive, seatedO2, failMargin: drive ? o2Start - seatedO2 - walk.o2 - back.o2 : null, backTime: back.time }
          : { drive, seatedO2, failMargin: o2Start - seatedO2 - back.o2, backTime: back.time, driveOnly: true }
      }
      if (out.target && out.earth && !out.target.driveOnly && !out.earth.driveOnly) out.compare = compareRoutes(out.target, out.earth)
      return out
    },
    setDriveUntil(k) { route.driveUntil = Math.max(0, k | 0) },
    // B7 field science
    missionMark() { return { t: clock, dist: player.distance, energyJ: life.energyJ || 0, world: active } },
    stationHere() {
      const w = state[active]
      if (!w || w.kind === 'tiles') return null
      const x = player.pos.x, z = player.pos.z, s = slopeAt(w, x, z)
      let near12 = 0, near60 = 0
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2
        near12 += realHeight(w, x + Math.cos(a) * 12, z + Math.sin(a) * 12); near60 += realHeight(w, x + Math.cos(a) * 60, z + Math.sin(a) * 60)
      }
      const h = realHeight(w, x, z), tpi12 = h - near12 / 12, tpi60 = h - near60 / 12
      const kind = tpi12 <= -0.6 || tpi60 <= -2 ? 'hollow' : s.deg >= 12 ? 'slope' : s.deg < 5 && Math.abs(tpi12) < 0.4 ? 'flat' : 'other'
      const mark = { kind: 'sample', x: x + Math.sin(player.facing) * 0.7, z: z + Math.cos(player.facing) * 0.7 }
      ;(missionMarks[active] ||= []).push(mark); missionGroup.add(markerMesh(mark)); mapTick = 0
      emitDust(x, z, 6, 0.5)
      return { world: active, body: w.body, x, z, slope: s.deg, tpi: tpi12, tpiWide: tpi60, kind, elevation: w.field.absolute(x, z), u: x / w.field.sizeM + 0.5, v: z / w.field.sizeM + 0.5 }
    },
    deploySeismometer() {
      const w = state[active]
      if (!w || w.kind === 'tiles') return null
      const x = player.pos.x + Math.sin(player.facing) * 0.8, z = player.pos.z + Math.cos(player.facing) * 0.8
      const [bx, bz] = baseAt(w), dist = Math.hypot(x - bx, z - bz), slope = slopeAt(w, x, z, 0.6).deg
      if (dist < 50) return { ok: false, reason: 'near', dist, slope }
      if (slope > 8) return { ok: false, reason: 'steep', dist, slope }
      missionMarks[active] = (missionMarks[active] || []).filter(m => m.kind !== 'seismometer').concat([{ kind: 'seismometer', x, z }])
      syncMissionMarks(); mapTick = 0
      return { ok: true, dist, slope }
    },
    photoWall() { const r = wallAhead(); return { ...r, thumb: thumbnail() } },
    resetMission() { missionMarks[active] = []; syncMissionMarks(); mapTick = 0 },
    // B8 base site and resources
    // the site is 14 m ahead of the camera, so the habitat appears in view where the check was made
    siteCheck() { const [x, z] = siteSpot(); return { here: active, x, z, target: siteAt('target', x, z), earth: siteAt('earth', x, z) } },
    placeBase() { const w = state[active]; if (!w || w.kind === 'tiles') return false; const [x, z] = siteSpot(); baseSites[active] = { x, z }; loadHabitat(); syncMissionMarks(); mapTick = 0; return true },
    iceCheck() { return permanentShadow(player.pos.x, player.pos.z) },
    setTime(patch) { Object.assign(worldTime[active], patch); applyConditions(true) },
    useNow() {
      const w = state[active], lon = active === 'rover' ? 137.4 : w.lon, d = new Date(), t = worldTime[active]
      if (w.body === 'earth') Object.assign(t, Wx.earthNow(lon, d))
      else if (w.body === 'mars') { const m = Wx.marsNow(lon, d); t.ls = m.ls; t.hour = m.localHour }
      else t.hour = Wx.moonNow(lon, d).localHour
      applyConditions(true)
    },
    setQuality,
    setDetail(key, detail) {
      const w = state[key]
      if (!w || !detail) return
      w.pendingDetail = detail
      if (key !== active) applyPendingDetail(key)  // off screen: safe to swap now
    },
    setExaggeration(value) {
      exaggerationNow = value
      for (const k of ['target', 'earth']) { const w = state[k]; applyPendingDetail(k); w.field = buildField(w.terrain, w.sizeM, w.res, value, w.detail || null); w.minimapBase = null; w.light = null }
      if (state[active].kind === 'tiles') return
      buildTerrain()
      player.pos.y = ground(player.pos.x, player.pos.z); player.grounded = true; player.vy = 0
      regenerateRocks(true); rebuildFlags(); placeProp()
    },
    releaseKeys() { Object.keys(input).forEach(k => { input[k] = typeof input[k] === 'boolean' ? false : 0 }); player.run = false },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame); resize.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointercancel', onPointerUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      disposeMesh(terrainMesh); disposeMesh(skirtMesh); disposeMesh(outerMesh); disposeMesh(boundaryLine)
      near?.dispose()
      roverTiles?.dispose(); roverSky?.dispose()
      climateAbort.abort()
      vehicle?.dispose(); vehicleTemplate?.dispose()
      flagGroup.children.slice().forEach(child => { flagGroup.remove(child); child.traverse(o => o.geometry?.dispose()) })
      astro.dispose()
      Object.values(propCache).forEach(t => t?.traverse(o => { if (o.isMesh) { o.geometry.dispose(); [].concat(o.material).forEach(m => { Object.values(m).forEach(v => v?.isTexture && v.dispose()); m.dispose() }) } }))
      draco.dispose()
      disposables.forEach(x => x.dispose?.())
      Object.values(state).forEach(w => w.texture?.dispose())
      if (scene.environment) scene.environment.dispose()
      composer?.dispose(); bloom?.dispose()
      pmrem.dispose(); renderer.dispose(); renderer.domElement.remove()
    },
  }
}
