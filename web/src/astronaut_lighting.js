// Terrain lighting from the DEM: direct-sun visibility from the horizon angle toward the sun (long
// crater and ridge shadows beyond the shadow-map range) and sky visibility (ambient occlusion in
// valleys). Both are computed in slices over several frames so the scene keeps running.
import * as THREE from 'three'

const DEG = Math.PI / 180

export function horizonAngle(f, x, z, dx, dz, h0, curv, maxDist) {
  let best = -Math.PI / 2, d = f.step * 0.75
  while (d < maxDist) {
    const px = x + dx * d, pz = z + dz * d
    if (Math.abs(px) > f.half || Math.abs(pz) > f.half) break
    const a = Math.atan2(f.height(px, pz) - d * d * curv - h0, d)
    if (a > best) best = a
    d *= 1.16
  }
  return best
}

export function createTerrainLight(field, radius, { dirs: skyDirs = 8 } = {}) {
  const M = field.M, n = M * M, curv = 1 / (2 * radius)
  const sunVis = new Float32Array(n).fill(1), skyVis = new Float32Array(n).fill(1)
  const nextSun = new Float32Array(n)
  let sunJob = null, skyJob = { i: 0 }, sunKey = '', version = 0, wanted = null, lastEl = 90
  const maxDist = Math.min(field.sizeM, 30000)
  return {
    sunVis, skyVis, get version() { return version },
    // Request a recompute for a new sun direction; work happens in step().
    // A running pass finishes before the latest request starts, so a moving sun still converges.
    setSun(elevationDeg, azimuthDeg) {
      wanted = { key: elevationDeg.toFixed(1) + ':' + azimuthDeg.toFixed(1), el: elevationDeg, az: azimuthDeg }
    },
    // Spend about `budget` vertices of work; returns true when a new sun field was published.
    step(budget = 3000) {
      let published = false
      if (!sunJob && wanted && wanted.key !== sunKey) {
        // Sunrise after a night (or a jump in time): show the high sun at once, then refine the shadows.
        if (wanted.el > 12 && lastEl < 2) { sunVis.fill(1); version++; published = true }
        lastEl = wanted.el
        sunKey = wanted.key
        sunJob = { i: 0, el: wanted.el * DEG, dx: Math.sin(wanted.az * DEG), dz: -Math.cos(wanted.az * DEG) }
      }
      if (skyJob) {
        const dirs = skyDirs
        for (let k = 0; k < budget / 3 && skyJob.i < n; k++, skyJob.i++) {
          const r = Math.floor(skyJob.i / M), c = skyJob.i % M, x = -field.half + c * field.step, z = -field.half + r * field.step
          const h0 = field.H[skyJob.i]
          let occl = 0
          for (let d = 0; d < dirs; d++) {
            const a = d / dirs * Math.PI * 2
            occl += Math.max(0, Math.sin(horizonAngle(field, x, z, Math.cos(a), Math.sin(a), h0, curv, 4000)))
          }
          skyVis[skyJob.i] = Math.min(1, Math.max(0.35, 1 - occl / dirs * 1.6))
        }
        if (skyJob.i >= n) { skyJob = null; version++; published = true }
      }
      if (sunJob) {
        const j = sunJob
        if (j.el < -1 * DEG) { nextSun.fill(0); j.i = n }
        for (let k = 0; k < budget && j.i < n; k++, j.i++) {
          const r = Math.floor(j.i / M), c = j.i % M, x = -field.half + c * field.step, z = -field.half + r * field.step
          const horizon = horizonAngle(field, x, z, j.dx, j.dz, field.H[j.i] + 0.5, curv, maxDist)
          // Soft edge of half a degree, about the Sun's apparent radius from Earth and the Moon.
          const t = (j.el - horizon) / (0.5 * DEG)
          nextSun[j.i] = t <= -1 ? 0 : t >= 1 ? 1 : 0.5 + 0.5 * t
        }
        if (j.i >= n) { sunVis.set(nextSun); sunJob = null; version++; published = true }
      }
      return published
    },
    busy() { return !!sunJob || !!skyJob || (wanted && wanted.key !== sunKey) },
    // Bilinear sample of a field at world x/z.
    sample(arr, x, z) {
      const fx = Math.min(M - 1.001, Math.max(0, (x + field.half) / field.step)), fz = Math.min(M - 1.001, Math.max(0, (z + field.half) / field.step))
      const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r, i = r * M + c
      return (arr[i] * (1 - u) + arr[i + 1] * u) * (1 - v) + (arr[i + M] * (1 - u) + arr[i + M + 1] * u) * v
    },
  }
}

// Shader hooks: attenuate only the directional sun by per-vertex visibility and indirect light by sky visibility.
// Objects on the terrain read the same visibility from a texture at their own position (engine: withObjectSun).
export const LIGHT_VERTEX = 'attribute float sunVis;\nattribute float skyVis;\nvarying float vSunVis;\nvarying float vSkyVis;'
export function lightFragmentChunks() {
  return {
    begin: THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vSunVis;'),
    ao: 'reflectedLight.indirectDiffuse *= vSkyVis;\n#include <aomap_fragment>',
  }
}
