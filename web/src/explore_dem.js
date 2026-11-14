// High-resolution explorer DEM: one request per window, shared by the results-page prefetch and the explorer.
const pending = new Map()

export function exploreDemUrl(w) {
  return `/api/explore-dem?body=${encodeURIComponent(w.body)}&lat=${Number(w.lat).toFixed(5)}&lon=${Number(w.lon).toFixed(5)}&km=${encodeURIComponent(w.patchKm)}`
}

export function fetchExploreDem(w) {
  const url = exploreDemUrl(w)
  if (!pending.has(url)) {
    pending.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null).then(v => { if (!v) pending.delete(url); return v }))
  }
  return pending.get(url)
}

// Start the downloads early (results page): the server caches the DEM, the browser keeps the promise.
export function prefetchExploreDem(w) {
  if (!w || !Number.isFinite(Number(w.lat)) || !Number.isFinite(Number(w.lon))) return
  fetchExploreDem(w)
}

// NASA 3D models used by the explorer (bytes are the fallback total when a response has no Content-Length).
export const EXPLORER_MODELS = {
  suit: { url: '/assets/lunar-walk/astronaut.glb', bytes: 5098972 },
  roverDesktop: { url: '/assets/nasa3d/sev_rover_desktop.glb', bytes: 1965324 },
  roverMobile: { url: '/assets/nasa3d/sev_rover_mobile.glb', bytes: 1714364 },
}
export const EXPLORER_PROPS = {
  moon: { url: '/assets/lunar-walk/lunar_module.glb', bytes: 3641048 },
  mars: { url: '/assets/nasa3d/perseverance_rover.glb', bytes: 4987176 },
  earth: { url: '/assets/nasa3d/habitat_demo_part1.glb', bytes: 516748 },
}

// Download a file as an ArrayBuffer, reporting bytes as they arrive.
export async function fetchBytes(url, onProgress, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  if (!response.body) { const buffer = await response.arrayBuffer(); onProgress?.(buffer.byteLength, buffer.byteLength); return buffer }
  const reader = response.body.getReader(), chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); received += value.length
    onProgress?.(received, Math.max(total, received))
  }
  const out = new Uint8Array(received)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out.buffer
}

// Decoded image (same origin), ready to upload as a texture.
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => (image.decode ? image.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(image))
    image.onerror = () => reject(new Error('image failed'))
    image.src = url
  })
}

let modelsPrefetched = false
export function prefetchExplorerModels(mobile, body) {
  if (modelsPrefetched) return
  modelsPrefetched = true
  const urls = [EXPLORER_MODELS.suit.url, (mobile ? EXPLORER_MODELS.roverMobile : EXPLORER_MODELS.roverDesktop).url]
  if (EXPLORER_PROPS[body]) urls.push(EXPLORER_PROPS[body].url)
  for (const u of urls) fetch(u, { priority: 'low' }).catch(() => {})
}
