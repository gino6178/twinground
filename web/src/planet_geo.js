// Shared planetary coordinate helpers (selection globe, results Earth locator).
import * as THREE from 'three'

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const coord = (v, positive, negative) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? positive : negative}`
export const formatCoord = (lat, lon) => `${coord(lat, 'N', 'S')} · ${coord(lon, 'E', 'W')}`

export function lonLatPoint(lat, lon, radius = 1.015) {
  const u = (lon + 180) / 360
  const phi = 2 * Math.PI * u
  const theta = (90 - lat) * Math.PI / 180
  return new THREE.Vector3(
    -Math.cos(phi) * Math.sin(theta) * radius,
    Math.cos(theta) * radius,
    Math.sin(phi) * Math.sin(theta) * radius,
  )
}
