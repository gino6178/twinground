import React, { useEffect, useRef, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import './resource_panel.css'

// The challenge's recommended resources applied to the active Earth candidate: satellite views by season (Worldview),
// radar (Sentinel-1, RADARSAT Constellation, RADARSAT-1 archive, and Mini-RF for lunar queries) and the NASA
// observations available for a field campaign (Earthdata). Loaded when the panel scrolls into view; display only.
const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const pick = t => (t ? (getLanguage() === 'en' ? t.en : t.zh) : '')
const num = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: d }) : '—')
const CLASS = { rough: ['粗糙／多岩塊', 'rough or blocky'], smooth: ['平滑', 'smooth'], mixed: ['介於中間', 'in between'] }
const STATUS = { strong: ['is-strong', ['同一類', 'same class']], partial: ['is-partial', ['部分相符', 'partly similar']], breaks: ['is-break', ['不同類', 'different class']] }

function useVisible() {
  const [el, ref] = useState(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect() } }, { rootMargin: '200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el, seen])
  return [ref, seen]
}

function Img({ src, alt }) {
  const [state, setState] = useState('loading')
  return <span className={'rs-img is-' + state}>
    <img src={src} alt={alt} loading="lazy" decoding="async" onLoad={() => setState('ok')} onError={() => setState('err')} />
    {state === 'err' && <em>{tr('這一天沒有可用影像', 'No image for this date')}</em>}
  </span>
}

function Radar({ r, body }) {
  if (!r) return null
  const s1 = r.sentinel1 && !r.sentinel1.error ? r.sentinel1 : null
  const rcm = r.rcm && !r.rcm.error ? r.rcm : null
  const r1 = r.radarsat1 && !r.radarsat1.error ? r.radarsat1 : null
  const cmp = r.compare
  return <div className="rs-block">
    <h3>{tr('雷達：地表粗糙度與結構', 'Radar: surface roughness and structure')}</h3>
    <div className="rs-radar">
      {body === 'moon' && r.moon_minirf && <figure className="rs-stat">
        <b>{num(r.moon_minirf.cpr_median, 2)}</b>
        <figcaption>{tr('月球查詢地的 Mini-RF 圓偏振比（中位數）', 'Mini-RF circular polarisation ratio at the lunar query (median)')}</figcaption>
      </figure>}
      {s1 && <figure className="rs-quick">
        <Img src={`/api/resources/img/${s1.quicklook}`} alt={tr('Sentinel-1 VV 雷達影像', 'Sentinel-1 VV radar image')} />
        <figcaption>
          <b>Sentinel-1</b> <small>{s1.date}</small>
          <span>VV {num(s1.vv_db)} dB · VH {num(s1.vh_db)} dB</span>
          <span>{tr('交叉極化比', 'Cross-polarised ratio')} {num(s1.cross_ratio_db)} dB</span>
        </figcaption>
      </figure>}
      {rcm && <figure className="rs-quick">
        <Img src={`/api/resources/img/${rcm.quicklook}`} alt={tr('RADARSAT 星座任務緊湊極化影像', 'RADARSAT Constellation compact-polarimetry image')} />
        <figcaption>
          <b>RADARSAT Constellation</b>
          <span>{tr('紅／綠／藍占比', 'Red / green / blue share')} {num(rcm.red * 100, 0)} / {num(rcm.green * 100, 0)} / {num(rcm.blue * 100, 0)}%</span>
        </figcaption>
      </figure>}
    </div>
    {cmp && <p className={'rs-compare ' + (STATUS[cmp.status]?.[0] || '')}>
      {tr('月球：', 'Moon: ')}{tr(...CLASS[cmp.moon_class])}　{tr('地球：', 'Earth: ')}{tr(...CLASS[cmp.earth_class])}　→ <b>{tr(...STATUS[cmp.status][1])}</b>
      <small>{tr('兩者波段與極化方式不同，只比較粗糙程度的類別。', 'Different bands and polarisations, so only the roughness class is compared.')}</small>
    </p>}
    {r1 && <p className="rs-note">{r1.images
      ? tr(`RADARSAT-1 存檔有 ${num(r1.images, 0)} 景影像涵蓋這裡（${r1.first}–${r1.last}），可供申請比對過去的地表。`,
        `The RADARSAT-1 archive holds ${num(r1.images, 0)} images over this spot (${r1.first}–${r1.last}) for comparing the past surface.`)
      : tr('RADARSAT-1 存檔沒有影像涵蓋這裡。', 'No RADARSAT-1 archive image covers this spot.')}</p>}
    {!s1 && !rcm && <p className="rs-note">{tr('這個地點沒有可用的 Sentinel-1 或 RADARSAT 星座雷達影像。', 'No Sentinel-1 or RADARSAT Constellation image is available here.')}</p>}
  </div>
}

// Measured environment of the candidate: surface temperature (Terra MODIS normals hosted by JAXA), soil moisture
// (GCOM-W AMSR2), precipitation (GSMaP) and permafrost (ESA CCI). Shown only; ranking uses the frozen facet rules.
function EarthNow({ e }) {
  const items = [
    [tr('地表溫度（年均）', 'Surface temperature (mean)'), e.lst_mean_c, ' °C', 0],
    [tr('夏季白天最高', 'Summer daytime high'), e.lst_day_max_c, ' °C', 0],
    [tr('冬季夜間最低', 'Winter night low'), e.lst_night_min_c, ' °C', 0],
    [tr('日夜溫差', 'Day-night swing'), e.lst_swing_k, ' K', 0],
    [tr('土壤水分', 'Soil moisture'), e.soil_moisture_pct, '%', 1],
    [tr('年降水', 'Precipitation'), e.precip_mm_yr, ' mm', 0],
    [tr('永凍土占比', 'Permafrost fraction'), Number.isFinite(e.permafrost_frac) ? e.permafrost_frac * 100 : null, '%', 0],
  ].filter(x => Number.isFinite(x[1]))
  if (!items.length) return null
  return <div className="rs-block">
    <h3>{tr('這個地點的實測環境', 'Measured environment here')}</h3>
    <dl className="rs-now">{items.map(([k, v, u, d]) => <div key={k}><dt>{k}</dt><dd>{num(v, d)}{u}</dd></div>)}</dl>
  </div>
}

export function ResourcePanel({ data, active }) {
  useLanguage()
  const [ref, seen] = useVisible()
  const [res, setRes] = useState(null)
  const [state, setState] = useState('idle')
  const key = useRef('')
  const c = active?.center, w = data?.window || {}
  const body = w.body === 'mars' ? 'mars' : 'moon'
  const qlat = w.lat, qlon = w.lon
  const km = w.patch_km || active?.context_match?.patch_km || 40
  useEffect(() => {
    if (!seen || !c) return
    const k = `${c.latitude},${c.longitude_east},${km}`
    if (k === key.current) return
    key.current = k
    setState('loading'); setRes(null)
    const url = `/api/resources/card?body=${body}&qlat=${qlat ?? 0}&qlon=${qlon ?? 0}&lat=${c.latitude}&lon=${c.longitude_east}&km=${km}`
    fetch(url).then(r => r.json()).then(j => { if (key.current === k) { setRes(j); setState('ok') } }).catch(() => { if (key.current === k) setState('err') })
  }, [seen, c?.latitude, c?.longitude_east, km, body, qlat, qlon]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null
  const wv = res?.worldview, ed = res?.earthdata
  return <section id="resource-panel" ref={ref} className="rs-panel" aria-labelledby="rs-title">
    <header className="rs-head">
      <h2 id="rs-title">{tr('衛星與雷達實景', 'Satellite and radar views')}</h2>
      <p>{tr('同一個候選地點的四季衛星影像、雷達量測，以及實地考察前可以調閱的 NASA 觀測。', 'Seasonal satellite images, radar measurements and the NASA observations available before a field visit, for this candidate.')}</p>
    </header>
    {state === 'loading' && <p className="rs-loading" role="status">{tr('正在讀取衛星與雷達資料…', 'Reading satellite and radar data…')}</p>}
    {state === 'err' && <p className="rs-note">{tr('暫時讀不到這些資料，請稍後再試。', 'These data could not be read right now; try again later.')}</p>}
    {wv && <div className="rs-block">
      <h3>{tr('四季衛星影像', 'Satellite images by season')}</h3>
      <div className="rs-grid">{wv.images.map(im => <figure key={im.layer + im.date} className="rs-wv">
        <Img src={im.url} alt={pick(im.label)} /><figcaption>{pick(im.label)}<small>{im.date}</small></figcaption>
      </figure>)}</div>
      <a className="rs-link" href={wv.link} target="_blank" rel="noreferrer">{tr('在 NASA Worldview 開啟這個範圍', 'Open this extent in NASA Worldview')}</a>
    </div>}
    {res?.earth && <EarthNow e={res.earth} />}
    {res && <Radar r={res.radar} body={body} />}
    {ed && !ed.error && <div className="rs-block">
      <h3>{tr('實地考察前可調閱的 NASA 觀測', 'NASA observations available before a field visit')}</h3>
      <ul className="rs-ed">{ed.collections.map(x => <li key={x.short_name}><span>{pick(x.label)}</span><b>{num(x.granules, 0)}</b><small>{tr('筆', 'granules')}</small></li>)}</ul>
      <a className="rs-link" href={ed.search_link} target="_blank" rel="noreferrer">{tr('在 Earthdata Search 查這個範圍', 'Search this extent in Earthdata Search')}</a>
    </div>}
  </section>
}
