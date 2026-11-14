// Facets v7 display pieces (2026-11-13): off-catalogue tag on candidates, and the biosignature + sampled-life rows of the
// habitability card. Display only: nothing here enters retrieval, gating or ranking.
import React, { useEffect, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { requestJson } from './api_request.js'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const km = v => (Number.isFinite(v) ? Math.round(v).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW') : '—')

export function OffcatTag({ row }) {
  const c = row?.catalogue_nearest
  if (!c || row.known_analog) return null
  const name = getLanguage() === 'en' ? c.name : c.name_zh || c.name
  return <small className={`candidate-offcat ${c.off_catalogue ? 'is-off' : ''}`}>
    {c.off_catalogue ? tr('目錄外', 'Off-catalogue') : tr('目錄附近', 'Near catalogue')}
    <span>{' · '}{tr(`最近的已知類比：${name} ${km(c.distance_km)} km`, `nearest known analog: ${name}, ${km(c.distance_km)} km`)}</span>
  </small>
}

export function OffcatToggle({ checked, onChange }) {
  return <label className="candidate-offcat-toggle">
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {tr('只看目錄外的候選', 'Off-catalogue only')}
  </label>
}

export function useBiology(env, body, qlat, qlon) {
  const [bio, setBio] = useState(null)
  const lat = env?.center?.latitude, lon = env?.center?.longitude_east
  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
    let alive = true
    const q = new URLSearchParams({ lat, lon, body: body || 'moon' })
    if (body === 'mars' && Number.isFinite(qlat) && Number.isFinite(qlon)) { q.set('qlat', qlat); q.set('qlon', qlon) }
    requestJson(`/api/biology?${q}`).then(d => { if (alive) setBio(d) }).catch(() => { if (alive) setBio({ error: true }) })
    return () => { alive = false }
  }, [lat, lon, body, qlat, qlon])
  return bio
}

const word = v => v == null ? tr('資料不足', 'no data') : v >= 0.99 ? tr('有', 'present') : v >= 0.49 ? tr('部分', 'partly') : tr('沒有', 'absent')

export function BioRows({ bio, mars }) {
  if (!bio) return <p className="analogy-dim-extra">{tr('正在讀取生命痕跡與採樣紀錄…', 'Loading biosignature settings and sampling records…')}</p>
  if (bio.error) return null
  const L = k => tr(bio.labels[k].zh, bio.labels[k].en)
  const m = bio.microbiome
  const sampled = !m?.available ? '' : m.total === 0
    ? tr(`${m.radius_km} km 內沒有公開的微生物定序樣本。這只表示沒有人採過，不代表沒有生命。`, `No public microbiome sequencing sample within ${m.radius_km} km. That means nobody has sampled here, not that nothing lives here.`)
    : tr(`${m.radius_km} km 內有 ${m.total} 筆公開的微生物定序樣本`, `${m.total} public microbiome sequencing samples within ${m.radius_km} km`) +
      (Object.entries(m.by_class).some(([, n]) => n > 0)
        ? tr('，其中極端環境：', '; from extreme settings: ') + Object.entries(m.by_class).filter(([, n]) => n > 0).map(([k, n]) => `${tr(m.labels[k].zh, m.labels[k].en)} ${n}`).join(tr('、', ', '))
        : tr('，都不是極端環境。', ', none from extreme settings.'))
  const target = mars ? bio.target?.settings || [] : []
  return <dl className="analogy-bio">
    {mars && target.length > 0 && <div>
      <dt>{tr('可以找的生命痕跡', 'Where to look for biosignatures')}</dt>
      <dd>{target.map(k => <span key={k} className="analogy-bio-item">{L(k)}{tr('：這裡', ': here ')}{word(bio.earth?.[k])}</span>)}</dd>
    </div>}
    {!mars && <div><dt>{tr('生命痕跡', 'Biosignatures')}</dt><dd>{tr('月球沒有已知生命；這裡只用來演練採樣時的污染管制。', 'The Moon has no known life; this site only serves to rehearse contamination control.')}</dd></div>}
    {sampled && <div><dt>{tr('這裡採樣過什麼', 'What has been sampled here')}</dt><dd>{sampled}</dd></div>}
  </dl>
}
