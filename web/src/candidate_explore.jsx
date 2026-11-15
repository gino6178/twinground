// Direct 3D exploration of a Search Candidates site (/?explore=<id>): the candidate is the Earth world and the
// lunar or Martian target it was ranked for is the other world. Terrain for both comes from /api/explore-dem.
import React, { Suspense, useEffect, useState } from 'react'
import { useLanguage } from './i18n/language.jsx'
import { fetchExploreDem } from './explore_dem.js'
import { decodeDetail } from './astronaut_engine.js'

const AstronautExplorer = React.lazy(() => import('./astronaut_explorer.jsx'))

// Target windows from scripts/facets_v7/offcat.py (the rankings each candidate was found for).
const TARGETS = {
  mouton: { body: 'moon', lat: -84.6, lon: 31.5, name: ['Artemis III 南極選區（Mons Mouton）', 'Artemis III south-polar region (Mons Mouton)'] },
  marius: { body: 'moon', lat: 14.0917, lon: -56.7701, name: ['Marius Hills 天窗坑', 'Marius Hills skylight'] },
  jezero: { body: 'mars', lat: 18.4, lon: 77.7, name: ['Jezero 撞擊坑', 'Jezero crater'] },
}
export const CANDIDATE_TARGET = {
  central_oregon: 'mouton', pinacate: 'marius', harrat_ash_shaam: 'marius', harrat_khaybar: 'marius',
  victoria_island: 'mouton', sistan: 'jezero', chott_el_djerid: 'jezero', sw_alaska: 'jezero',
}
const PATCH_KM = 20  // the smallest window the API accepts (20/40/80); the server caps the explorer DEM at 16 km

export function exploreIdFromUrl() {
  try { return new URLSearchParams(window.location.search).get('explore') } catch { return null }
}

// Coarse terrain grid (what buildField expects) from the high-resolution explorer DEM.
function terrainFrom(detail, size = 129) {
  const { n, h } = detail
  let min = Infinity
  for (const v of h) if (Number.isFinite(v) && v < min) min = v
  const out = new Array(size * size)
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const v = h[Math.round(j * (n - 1) / (size - 1)) * n + Math.round(i * (n - 1) / (size - 1))]
    out[j * size + i] = Number.isFinite(v) ? v : min
  }
  return { size, heights_m: out, min_m: min }
}

const coord = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`

export default function CandidateExplore({ id, site, onClose }) {
  const lang = useLanguage()
  const tr = (zh, en) => (lang === 'en' ? en : zh)
  const [worlds, setWorlds] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    ;(async () => {
      // `site` (chat search) names the Earth point and its target directly; otherwise `id` is a Search Candidates site.
      const c = site ? site.earth : (await fetch('/offcatalogue/data.json').then(r => r.json())).find(x => x.id === id)
      const t = site ? site.target : TARGETS[CANDIDATE_TARGET[id]]
      if (!c || !t) throw new Error('unknown')
      const target = { body: t.body, lat: t.lat, lon: t.lon, patchKm: PATCH_KM }
      const earth = { body: 'earth', lat: c.lat, lon: c.lon, patchKm: PATCH_KM }
      // The high-resolution lunar DEM covers 60°S-60°N only: near the pole the target falls back to the coarse
      // search-window terrain (the same grid the results page hands the explorer).
      const coarse = () => fetch(`/api/${t.body === 'mars' ? 'mars-window' : 'window'}?lat=${t.lat}&lon=${t.lon}&size_km=${PATCH_KM}`)
        .then(r => (r.ok ? r.json() : null)).then(v => v?.window?.terrain || null).catch(() => null)
      const [td, ed] = await Promise.all([fetchExploreDem(target), fetchExploreDem(earth)].map(p => p.then(decodeDetail)))
      const targetTerrain = td ? terrainFrom(td) : await coarse()
      if (!targetTerrain || !ed) throw new Error('dem')
      if (!alive) return
      const en = lang === 'en'
      setWorlds({
        target: {
          ...target, terrain: targetTerrain,
          textureUrl: t.body === 'moon' ? `/api/surface-texture?body=moon&lat=${t.lat}&lon=${t.lon}&size_km=${PATCH_KM}` : null,
          textureCredit: 'NASA SVS · LROC WAC',
          label: `${t.name[en ? 1 : 0]} · ${coord(t.lat, t.lon)} · ${PATCH_KM} × ${PATCH_KM} km`,
        },
        earth: {
          ...earth, terrain: terrainFrom(ed),
          textureUrl: `/api/surface-texture?extent=v2&body=earth&lat=${c.lat}&lon=${c.lon}&size_km=${PATCH_KM}`,
          textureCredit: 'Imagery: Esri, Vantor / Maxar, Earthstar Geographics, GIS User Community',
          label: c.name?.[en ? 'en' : 'zh'] || c.id,
        },
      })
    })().catch(() => alive && setError(tr('無法載入這個地點的地形，請稍後再試。', 'Could not load the terrain for this site. Please try again later.')))
    return () => { alive = false }
  }, [id, site])

  if (error) return <div className="eva-loading eva-boot" role="alert">{error} <button type="button" onClick={onClose}>{tr('返回', 'Back')}</button></div>
  if (!worlds) return <div className="eva-loading eva-boot" role="status">{tr('下載候選地點與目標的地形…', 'Downloading terrain for the candidate and its target…')}</div>
  return <Suspense fallback={<div className="eva-loading eva-boot" role="status">{tr('載入探索場景…', 'Loading the exploration scene…')}</div>}>
    <AstronautExplorer target={worlds.target} earth={worlds.earth} initialWorld="earth" onClose={onClose} />
  </Suspense>
}
