// Earth place names without a server call: 10 x 10 degree tiles built from Natural Earth (public domain) admin-1,
// admin-0 and physical regions on a 0.05 degree grid (scripts/build_earth_names.py). Row 0 is north.
import { useEffect, useState } from 'react'

const tiles = new Map()

function loadTile(lat0, lon0) {
  const key = `${lat0}_${lon0}`
  if (!tiles.has(key)) {
    tiles.set(key, fetch(`/gazetteer/earth/${key}.json`).then(r => (r.ok ? r.json() : null)).then(tile => {
      if (!tile) return null
      // Expand the run-length labels once per tile.
      const cells = new Uint16Array(tile.n * tile.n)
      let at = 0
      for (let i = 0; i < tile.rle.length; i += 2) { cells.fill(tile.rle[i], at, at + tile.rle[i + 1]); at += tile.rle[i + 1] }
      return { ...tile, cells }
    }).catch(() => null))
  }
  return tiles.get(key)
}

// [zh, en] for a coordinate; coastal windows fall back to the nearest land cell within about 30 km.
export async function earthPlace(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const lon180 = ((lon + 180) % 360 + 360) % 360 - 180
  const lat0 = Math.min(80, Math.floor(lat / 10) * 10), lon0 = Math.floor(lon180 / 10) * 10
  const tile = await loadTile(lat0, lon0)
  if (!tile) return null
  const { n, res, cells, labels } = tile
  const r0 = Math.min(n - 1, Math.max(0, Math.floor((lat0 + 10 - lat) / res)))
  const c0 = Math.min(n - 1, Math.max(0, Math.floor((lon180 - lon0) / res)))
  for (let radius = 0; radius <= 6; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue
        const r = r0 + dr, c = c0 + dc
        if (r < 0 || c < 0 || r >= n || c >= n) continue
        const label = cells[r * n + c]
        if (label) return labels[label]
      }
    }
  }
  return null
}

// Place names for a list of candidates: { [id]: [zh, en] }, filled in as tiles arrive.
export function useEarthPlaces(matches) {
  const [names, setNames] = useState({})
  const key = matches.map(m => m.id).join('|')
  useEffect(() => {
    let alive = true
    for (const m of matches) {
      if (names[m.id] !== undefined) continue
      earthPlace(m.center.latitude, m.center.longitude_east).then(place => {
        if (alive) setNames(previous => ({ ...previous, [m.id]: place }))
      })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return names
}
