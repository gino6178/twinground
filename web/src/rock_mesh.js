// Procedural rock meshes shared by the purpose tiles and the condition art.
import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

export const LOOKS = {
  basalt: { base: '#33363a', alt: '#4f5358', speck: 0.25, dot: '#8d918d' },
  anorthosite: { base: '#d2d0c8', alt: '#ebe9e2', speck: 0.22, dot: '#6f6c64' },
  andesite: { base: '#6d6e6c', alt: '#8a8b88', speck: 0.25, dot: '#2e2f2e' },
  rhyolite: { base: '#c9a9a0', alt: '#dcc2b9', speck: 0.15, dot: '#8c6c63' },
  pyroclastic: { base: '#8a4f3a', alt: '#a8654b', speck: 0.35, dot: '#3f2219' },
  gabbro: { base: '#2f3a33', alt: '#46534a', speck: 0.4, dot: '#c9cfc8' },
  diorite: { base: '#8d8f8c', alt: '#b5b7b3', speck: 0.45, dot: '#262726' },
  granite: { base: '#c8a59a', alt: '#e2d2c8', speck: 0.45, dot: '#2b2626' },
  sandstone: { base: '#c99c60', alt: '#a8784a', band: 11 },
  mixed: { base: '#9a8f7c', alt: '#6f6a60', band: 8 },
  limestone: { base: '#ddd6c1', alt: '#bdb49b', band: 9 },
  sand: { base: '#d6b77d', alt: '#bf9c62', speck: 0.5, dot: '#8e6f40' },
  gneiss: { base: '#a2a2a2', alt: '#3f3f42', band: 14, wavy: true },
  evaporite: { base: '#f1ece6', alt: '#e7d3d0', speck: 0.15, dot: '#b9a7a3', rough: 0.45 },
  ice: { base: '#d6eef9', alt: '#9fd0ee', rough: 0.15, opacity: 0.9 },
  unknown: { base: '#7c8783', alt: '#96a19c', speck: 0.1, dot: '#4a524f' },
}

const hash = (x, y, z) => { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s) }
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const sm = v => v * v * (3 - 2 * v), fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi)
  const L = (a, b, k) => a + (b - a) * k, h = (a, b, c) => hash(xi + a, yi + b, zi + c)
  return L(L(L(h(0, 0, 0), h(1, 0, 0), fx), L(h(0, 1, 0), h(1, 1, 0), fx), fy), L(L(h(0, 0, 1), h(1, 0, 1), fx), L(h(0, 1, 1), h(1, 1, 1), fx), fy), fz)
}
const fbm3 = (x, y, z, o = 4) => { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * noise3(x * f, y * f, z * f); f *= 2.03; a *= 0.5 } return s }

export function rockMesh(lookKey, seed) {
  const look = LOOKS[lookKey] || LOOKS.unknown
  let g = new THREE.IcosahedronGeometry(1, 5)
  g.deleteAttribute('normal'); g.deleteAttribute('uv')
  g = mergeVertices(g)
  const pos = g.attributes.position, v = new THREE.Vector3(), P = new THREE.Vector3()
  let sd = seed
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647 }
  const o = [rnd() * 50, rnd() * 50, rnd() * 50]
  // a few cleavage planes give the flat fractured faces of a broken rock
  const cuts = Array.from({ length: 6 }, () => [new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize(), 0.62 + rnd() * 0.22])
  const stretch = new THREE.Vector3(1.18, 0.78, 0.95)
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize()
    const r = 1 + 0.34 * (fbm3(v.x * 1.4 + o[0], v.y * 1.4 + o[1], v.z * 1.4 + o[2], 3) - 0.5)
    P.copy(v).multiplyScalar(r)
    for (const [n, d] of cuts) { const k = P.dot(n) - d; if (k > 0) P.addScaledVector(n, -k * 0.92) }
    const mid = fbm3(v.x * 4 + o[1], v.y * 4 + o[2], v.z * 4 + o[0], 2) - 0.5
    const fine = fbm3(v.x * 13 + o[2], v.y * 13 + o[0], v.z * 13 + o[1], 3) - 0.5
    const pit = Math.max(0, fbm3(v.x * 22, v.y * 22, v.z * 22, 2) - 0.62) // small pits and chips
    P.addScaledVector(v, 0.09 * mid + 0.05 * fine - 0.08 * pit).multiply(stretch)
    pos.setXYZ(i, P.x, P.y, P.z)
  }
  const base = new THREE.Color(look.base), alt = new THREE.Color(look.alt), dot = new THREE.Color(look.dot || look.base), c = new THREE.Color()
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const grain = fbm3(x * 6 + o[2], y * 6, z * 6, 3)
    if (look.band) c.copy(base).lerp(alt, 0.5 + 0.5 * Math.sin(y * look.band + (look.wavy ? Math.sin(x * 3) * 1.6 : 0) + (grain - 0.5) * 1.5))
    else c.copy(base).lerp(alt, Math.min(1, Math.max(0, (grain - 0.5) * 2.2 + 0.5)))
    colors.set([c.r, c.g, c.b], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: look.rough ?? 0.93, metalness: 0, transparent: !!look.opacity, opacity: look.opacity ?? 1 })
  // per-pixel grain, mineral speckles and (basalt) vesicles in object space, finer than the mesh can carry
  m.onBeforeCompile = sh => {
    sh.uniforms.uDot = { value: dot }
    sh.uniforms.uSpeck = { value: look.speck || 0 }
    sh.uniforms.uPits = { value: lookKey === 'basalt' || lookKey === 'pyroclastic' ? 1 : 0 }
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObj;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vObj; uniform vec3 uDot; uniform float uSpeck; uniform float uPits;
float gh(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(gh(i), gh(i + vec3(1., 0., 0.)), f.x), mix(gh(i + vec3(0., 1., 0.)), gh(i + vec3(1., 1., 0.)), f.x), f.y),
             mix(mix(gh(i + vec3(0., 0., 1.)), gh(i + vec3(1., 0., 1.)), f.x), mix(gh(i + vec3(0., 1., 1.)), gh(i + vec3(1., 1., 1.)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= .74 + .34 * gn(vObj * 34.) + .16 * gn(vObj * 90.);
  diffuseColor.rgb = mix(diffuseColor.rgb, uDot, smoothstep(1. - uSpeck * .55, 1. - uSpeck * .5, gn(vObj * 70. + 7.)) * .9);
  diffuseColor.rgb *= 1. - uPits * .6 * smoothstep(.78, .84, gn(vObj * 48. + 3.));`)
  }
  return new THREE.Mesh(g, m)
}
