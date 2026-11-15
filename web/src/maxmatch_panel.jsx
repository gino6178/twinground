import React, { useEffect, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import './maxmatch_panel.css'

// Max-match on the results page (2026-11-14): for the active Earth candidate, every measured property of the Moon or
// Mars window next to the Earth value, its tolerance and whether it agrees. Ranking and verdicts come from the server
// (scripts/atlas_match/maxmatch.py); nothing is inferred about properties that were not measured.
const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const lab = l => (Array.isArray(l) ? (getLanguage() === 'en' ? l[1] : l[0]) : l)
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const STATUS = {
  match: ['is-match', ['符合', 'Match']],
  miss: ['is-miss', ['不符', 'Miss']],
  unmeasured: ['is-unmeasured', ['地球未測', 'Not measured on Earth']],
}

function fmt(v, unit) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const n = a >= 100 ? Math.round(v) : a >= 10 ? Math.round(v * 10) / 10 : a >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000
  return `${n.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW')}${unit ? ' ' + unit : ''}`
}

function Segments({ items }) {
  const [on, setOn] = useState(reduced() ? items.length : 0)
  useEffect(() => {
    if (reduced()) { setOn(items.length); return }
    setOn(0)
    let i = 0
    const t = setInterval(() => { i += 1; setOn(i); if (i >= items.length) clearInterval(t) }, 70)
    return () => clearInterval(t)
  }, [items.map(x => x.id + x.status).join('|')])
  return <div className="mm-seg" role="img" aria-label={tr('每一格是一項實測資料', 'one cell per measured property')}>
    {items.map((x, i) => <span key={x.id} className={(STATUS[x.status] || STATUS.unmeasured)[0] + (x.earth_limit ? ' is-limit' : '') + (i < on ? ' is-on' : '')} title={lab(x.label)} />)}
  </div>
}

// Pre-field check of one candidate (server: scripts/atlas_match/prefield.py): known analog nearby, papers that name the
// place with Mars/Moon analog words (leads, not proof), and what the challenge resources hold for it.
const VERDICT = {
  catalogued: ['is-known', ['已知類比場址', 'Documented analog site']],
  studied: ['is-studied', ['文獻提過這裡', 'Papers name this place']],
  region_studied: ['is-region', ['同地區有類比研究', 'Analog studies in the region']],
  no_record: ['is-new', ['查無類比紀錄：可能是新的', 'No analog record found: possibly new']],
}
export function PrefieldCheck({ body, qlat, qlon, lat, lon }) {
  useLanguage()
  const [st, setSt] = useState({ loading: true })
  useEffect(() => {
    if (![qlat, qlon, lat, lon].every(Number.isFinite)) return
    let live = true
    setSt({ loading: true })
    fetch(`/api/maxmatch/check?body=${body}&qlat=${qlat}&qlon=${qlon}&lat=${lat}&lon=${lon}`)
      .then(r => r.json()).then(d => { if (live) setSt(d.error ? { error: d.error } : { d }) })
      .catch(() => { if (live) setSt({ error: 'unavailable' }) })
    return () => { live = false }
  }, [body, qlat, qlon, lat, lon])
  if (st.loading) return <div className="mm-check is-loading">{tr('出發前查核中：已知場址、文獻、挑戰資源……', 'Pre-field check: known sites, papers, challenge resources…')}</div>
  if (st.error) return <div className="mm-check">{tr('出發前查核暫時無法取得。', 'The pre-field check is unavailable right now.')}</div>
  const d = st.d, v = VERDICT[d.verdict] || VERDICT.no_record
  const lit = d.literature || {}, res = d.resources || {}, cat = d.catalogue || {}
  const ed = res.earthdata || {}, s1 = res.sentinel1 || {}, r1 = res.radarsat1 || {}, wv = res.worldview || {}
  const town = d.place?.name ? `${d.place.name}${d.place.admin1 ? '，' + d.place.admin1 : ''}${d.place.country ? '，' + d.place.country : ''}` : ''
  const ex = (lit.place?.examples || []).filter(e => e.title).slice(0, 2)
  return <div className="mm-check">
    <h3>{tr('出發前查核', 'Pre-field check')} <span className={'mm-verdict ' + v[0]}>{tr(...v[1])}</span></h3>
    <dl>
      <div><dt>{tr('最近的已知類比場址', 'Nearest documented analog site')}</dt><dd>{(getLanguage() === 'en' ? cat.name : cat.name_zh || cat.name) || '—'}{Number.isFinite(cat.distance_km) ? `（${Math.round(cat.distance_km).toLocaleString()} km）` : ''}</dd></div>
      <div><dt>{tr('文獻（OpenAlex）', 'Papers (OpenAlex)')}</dt><dd>{town && <>{tr(`提到「${d.place.name}」並談月球／火星類比：`, `naming “${d.place.name}” with Moon/Mars analog: `)}<b>{lit.place?.count ?? '—'}</b>{tr(' 篇', '')}</>}{d.place?.admin1 && <>{tr(`；「${d.place.admin1}」：`, `; “${d.place.admin1}”: `)}<b>{lit.region?.count ?? '—'}</b>{tr(' 篇', '')}</>}</dd></div>
      <div><dt>{tr('NASA Earthdata 可用資料', 'NASA Earthdata granules')}</dt><dd>{Number.isFinite(ed.granules) ? ed.granules.toLocaleString() : '—'}{ed.link && <> · <a href={ed.link} target="_blank" rel="noreferrer">{tr('開啟搜尋', 'open search')}</a></>}</dd></div>
      <div><dt>{tr('雷達', 'Radar')}</dt><dd>{s1.date ? `Sentinel-1 ${s1.date}` : 'Sentinel-1 —'}{Number.isFinite(r1.images) ? ` · RADARSAT-1 ${r1.images} ${tr('張', 'images')}${r1.first ? `（${r1.first}–${r1.last}）` : ''}` : ''}{res.rcm ? ' · RCM' : ''}</dd></div>
      {wv.link && <div><dt>{tr('衛星影像', 'Imagery')}</dt><dd><a href={wv.link} target="_blank" rel="noreferrer">NASA Worldview</a>{wv.dates?.length ? ` · ${wv.dates.join('、')}` : ''}</dd></div>}
    </dl>
    {ex.length > 0 && <ul className="mm-papers">{ex.map(e => <li key={e.title}>{e.doi ? <a href={e.doi} target="_blank" rel="noreferrer">{e.title}</a> : e.title}{e.year ? `（${e.year}）` : ''}</li>)}</ul>}
  </div>
}

export function MaxMatchPanel({ data, active }) {
  useLanguage()
  const block = active?.maxmatch, sum = data?.maxmatch
  if (!block || !sum) return null
  const body = data?.window?.body || (data?.mars_reference ? 'mars' : 'moon')
  const where = body === 'mars' ? tr('火星', 'Mars') : tr('月球', 'Moon')
  const limits = (sum.earth_limits || []).map(l => lab(l.label))
  return <section id="maxmatch-panel" className="mm-panel" aria-labelledby="mm-title">
    <div className="mm-head">
      <h2 id="mm-title">{tr('實測資料比對', 'Measured-data match')}</h2>
      <p>{tr(`把${where}窗格的每一項實測資料，和這個地球窗格的實測值逐項比對。排序只看「符合幾項」，不用任何地質規則或學習模型；地球沒量到的項目標為未測，不算符合也不算不符。`,
        `Each measured property of the ${where} window is compared with the measured value of this Earth window. The ranking counts agreements only, with no geologic rule and no learned model; a property Earth has not measured here is shown as not measured, neither a match nor a miss.`)}</p>
    </div>
    <div className="mm-top">
      <div className="mm-total"><b>{block.matched}<span> / {block.properties}</span></b><small>{tr('項實測資料符合', 'measured properties agree')}</small></div>
      <Segments items={block.items} />
      <ul className="mm-counts">
        <li><b>{block.items.filter(x => x.status === 'match').length}</b>{tr('符合', 'match')}</li>
        <li className="is-miss"><b>{block.items.filter(x => x.status === 'miss').length}</b>{tr('不符', 'miss')}</li>
        <li className="is-unmeasured"><b>{block.items.filter(x => x.status === 'unmeasured').length}</b>{tr('地球未測', 'not measured')}</li>
      </ul>
    </div>
    {limits.length > 0 && <p className="mm-limits">{tr('地球上沒有任何地方做得到：', 'No place on Earth reaches: ')}<b>{limits.join(tr('、', ', '))}</b>{tr(`。全球最好的地方也只符合 ${sum.best_matched} / ${sum.properties} 項。`, `. The best place on Earth matches ${sum.best_matched} of ${sum.properties}.`)}</p>}
    <PrefieldCheck body={body} qlat={data?.window?.lat} qlon={data?.window?.lon} lat={active?.center?.latitude} lon={active?.center?.longitude_east} />
    <table className="mm-table">
      <thead><tr><th>{tr('性質', 'Property')}</th><th>{where}</th><th>{tr('這個地球窗格', 'This Earth window')}</th><th>{tr('容許差', 'Tolerance')}</th><th>{tr('結果', 'Result')}</th></tr></thead>
      <tbody>
        {block.items.map(x => <tr key={x.id} className={(STATUS[x.status] || STATUS.unmeasured)[0]}>
          <th scope="row">{lab(x.label)}{x.earth_limit && <em className="mm-tag">{tr('地球做不到', 'beyond Earth')}</em>}</th>
          <td title={x.source_query || ''}>{fmt(x.query, x.unit)}</td>
          <td title={x.source_earth || ''}>{fmt(x.earth, x.unit)}</td>
          <td>±{fmt(x.tolerance, x.unit)}</td>
          <td><span className="mm-status">{tr(...(STATUS[x.status] || STATUS.unmeasured)[1])}</span></td>
        </tr>)}
      </tbody>
    </table>
  </section>
}

// Compact list for the chat page: the same verdicts, one line per property.
export function MaxMatchList({ block, target, lat, lon }) {
  useLanguage()
  if (!block) return null
  return <div className="mm-chat">
    <p><b>{block.matched} / {block.properties}</b> {tr('項實測資料符合', 'measured properties agree')}</p>
    <Segments items={block.items} />
    <ul>{block.items.map(x => <li key={x.id} className={(STATUS[x.status] || STATUS.unmeasured)[0]}>
      <span>{lab(x.label)}</span><b>{fmt(x.query, x.unit)} → {fmt(x.earth, x.unit)}</b><em>{tr(...(STATUS[x.status] || STATUS.unmeasured)[1])}</em>
    </li>)}</ul>
    {target && <PrefieldCheck body={target.body} qlat={target.lat} qlon={target.lon} lat={lat} lon={lon} />}
  </div>
}
