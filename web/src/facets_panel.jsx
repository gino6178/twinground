import React, { useEffect, useRef, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import './facets_panel.css'

// Facets v6 on the results page: the ten facets of the challenge (terrain, material, thermal, sunlight, water and ice,
// dust and wind, surface processes, habitability, subsurface, operations) for the active Earth candidate. A radar
// shows the facet scores against the best any Earth window reaches for this query; each facet opens to its items with
// the target, the Earth value and the verdict. Display only: scores and verdicts come from the server.
const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const pick = t => (t ? (getLanguage() === 'en' ? t.en : t.zh) : '')
const pct = v => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—')
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const STATUS = {
  strong: ['is-strong', '✓', ['強類比', 'Strong']], partial: ['is-partial', '~', ['部分相符', 'Partial']],
  breaks: ['is-break', '✗', ['不成立', 'Breaks down']], unknown: ['is-unknown', '?', ['地球無資料', 'No Earth data']],
  not_applicable: ['is-na', '–', ['不適用', 'Not applicable']],
}
// Facet labels that would read the same as a Conditions card but measure something else: on the Moon facet F only
// checks loose fine topsoil (there is no wind), facet C the latitude-model temperature, facet G the geologic setting.
const LABEL_OVERRIDE = {
  moon: { F: ['沙塵（鬆散細粒表土）', 'Dust (loose fine soil)'], C: ['熱環境（對照目標）', 'Thermal (vs target)'], G: ['地表作用（地質背景）', 'Surface processes (geologic setting)'] },
  mars: { G: ['地表作用（地質背景）', 'Surface processes (geologic setting)'] },
}
const facetLabel = (f, body) => (LABEL_OVERRIDE[body]?.[f.id] ? tr(...LABEL_OVERRIDE[body][f.id]) : pick(f.label))
const NA_REASON = {
  H: ['月球沒有已知生物，這個面向不計分。', 'The Moon has no known life, so this facet is not scored.'],
}

function fmt(v, unit) {
  if (!Number.isFinite(v)) return '—'
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100
  return `${n.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW')}${unit ? ' ' + unit : ''}`
}

// Radar of the ten facets. The polygon eases to the new scores when the candidate changes.
function Radar({ facets, ceiling }) {
  const target = facets.map(f => (Number.isFinite(f.score) ? f.score : 0))
  const [shown, setShown] = useState(target.map(() => 0))
  const from = useRef(shown)
  useEffect(() => {
    if (reduced()) { setShown(target); from.current = target; return }
    const start = performance.now(), a = from.current
    let raf
    const step = now => {
      const t = Math.min(1, (now - start) / 700), e = 1 - Math.pow(1 - t, 4)
      const cur = target.map((v, i) => (a[i] ?? 0) + (v - (a[i] ?? 0)) * e)
      setShown(cur); from.current = cur
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const n = facets.length, R = 96, C = 130
  const pt = (i, r) => { const a = (i / n) * 2 * Math.PI - Math.PI / 2; return [C + r * Math.cos(a), C + r * Math.sin(a)] }
  const poly = vals => vals.map((v, i) => pt(i, R * Math.max(0, Math.min(1, v))).map(x => x.toFixed(1)).join(',')).join(' ')
  const ceil = facets.map(f => (Number.isFinite(ceiling?.[f.id]) ? ceiling[f.id] : 0))
  return <svg className="fx-radar" viewBox="-58 0 376 260" role="img" aria-label={tr('十個面向的分數雷達圖', 'Radar of the ten facet scores')}>
    {[0.25, 0.5, 0.75, 1].map(r => <polygon key={r} className="fx-radar-ring" points={poly(facets.map(() => r))} />)}
    {facets.map((f, i) => { const [x, y] = pt(i, R); return <line key={f.id} className="fx-radar-axis" x1={C} y1={C} x2={x} y2={y} /> })}
    {ceiling && <polygon className="fx-radar-ceiling" points={poly(ceil)} />}
    <polygon className="fx-radar-score" points={poly(shown)} />
    {facets.map((f, i) => {
      const [x, y] = pt(i, R + 18)
      const cls = STATUS[f.status]?.[0] || 'is-unknown'
      return <text key={f.id} x={x} y={y} className={'fx-radar-label ' + cls} textAnchor={x < C - 8 ? 'end' : x > C + 8 ? 'start' : 'middle'} dominantBaseline="middle">{pick(f.label)}</text>
    })}
  </svg>
}

function Facet({ f, body }) {
  const [cls, mark, text] = STATUS[f.status] || STATUS.unknown
  const na = f.status === 'not_applicable'
  return <details className={'fx-facet ' + cls} open={f.status === 'breaks' || undefined}>
    <summary>
      <span className="fx-mark" aria-hidden="true">{mark}</span>
      <b>{facetLabel(f, body)}</b>
      <span className="fx-bar" aria-hidden="true"><i style={{ width: Number.isFinite(f.score) ? `${Math.round(f.score * 100)}%` : 0 }} /></span>
      <span className="fx-score">{na ? tr(...text) : Number.isFinite(f.score) ? pct(f.score) : tr(...text)}</span>
    </summary>
    {na ? <p className="fx-na">{tr(...(NA_REASON[f.id] || ['這個查詢地沒有對應的項目。', 'Nothing in this facet applies to this query.']))}</p>
      : <ul className="fx-items">
        {f.tokens.map(t => {
          const [c2, m2, t2] = STATUS[t.status] || STATUS.unknown
          return <li key={t.id} className={c2 + (t.counted ? '' : ' is-uncounted')}>
            <span className="fx-mark" aria-hidden="true">{m2}</span>
            <div>
              <b>{pick(t.label)}</b>
              <small>{body === 'mars' ? tr('火星：', 'Mars: ') : tr('月球：', 'Moon: ')}{t.unit === 'K' ? pick(t.query).replace(/(\d) K(?![A-Za-z])/g, '$1 °C') : pick(t.query)}</small>
              {t.unit && Number.isFinite(t.earth_value) && <small>{tr('地球此處：', 'Earth here: ')}{fmt(t.earth_value, t.unit === 'K' ? '°C' : t.unit)}</small>}
            </div>
            <span className="fx-verdict">{tr(...t2)}{t.counted ? '' : tr('（此用途不計分）', ' (not scored for this use)')}</span>
          </li>
        })}
      </ul>}
  </details>
}

// Measured values of the lunar query window (LRO Diviner, LOLA, Mini-RF, Lunar Prospector) that set the facet targets.
function Measured({ m }) {
  if (!m) return null
  const th = m.thermal, po = m.polar, ra = m.radar
  const items = []
  const c = k => `${Math.round(k - 273.15)} °C`
  if (th) items.push([tr('地表溫度', 'Surface temperature'), tr(`平均 ${c(th.mean_k)}，最高 ${c(th.max_k)}，最低 ${c(th.min_k)}`, `mean ${c(th.mean_k)}, max ${c(th.max_k)}, min ${c(th.min_k)}`)])
  if (po && Number.isFinite(po.ice_stable_1m_share)) items.push([tr('1 m 內水冰可穩定', 'Ice stable within 1 m'), `${Math.round(po.ice_stable_1m_share * 100)}%`])
  if (po && Number.isFinite(po.permanent_shadow_share)) items.push([tr('永久陰影', 'Permanent shadow'), `${Math.round(po.permanent_shadow_share * 100)}%`])
  if (po && Number.isFinite(po.sun_visibility_mean)) items.push([tr('平均日照', 'Mean Sun visibility'), `${Math.round(po.sun_visibility_mean * 100)}%`])
  if (Number.isFinite(m.hydrogen_ppm)) items.push([tr('氫', 'Hydrogen'), `${Math.round(m.hydrogen_ppm)} ppm`])
  if (ra) items.push([tr('雷達圓偏振比', 'Radar CPR'), ra.cpr_median.toFixed(2)])
  if (!items.length) return null
  return <dl className="fx-measured" aria-label={tr('月球查詢地的實測值', 'Measured values at the lunar query')}>
    {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
  </dl>
}

export function FacetsPanel({ data, active }) {
  useLanguage()
  const block = active?.facets, sum = data?.facets
  if (!block || !sum) return null
  const body = sum.body === 'mars' ? 'mars' : 'moon'
  const ranked = sum.ranking && !/^not used/.test(sum.ranking)
  // Count the ten facets by their own verdict so the header matches the tiles below (block.strong etc. list sub-checks).
  const count = k => block.facets.filter(f => f.status === k).length
  const naCount = count('not_applicable')
  return <section id="facets-panel" className="fx-panel" aria-labelledby="fx-title">
    <header className="fx-head">
      <h2 id="fx-title">{tr('十個面向的類比程度', 'How good the analog is, facet by facet')}</h2>
      <p>{tr('把挑戰列出的考量整理成十個面向，逐項比對這個地球候選與查詢地。', 'The considerations of the challenge as ten facets, each compared between this Earth candidate and the query.')}
        {' '}{ranked ? tr(`這次搜尋依「${pick(sum.use_label)}」的面向分數排序。`, `This search is ranked by the facet score for “${pick(sum.use_label)}”.`)
          : tr('這次搜尋不是依面向分數排序，以下僅供對照。', 'This search is not ranked by the facet score; shown for comparison.')}</p>
    </header>
    <div className="fx-top">
      <Radar facets={block.facets} ceiling={sum.ceiling?.facets} />
      <div className="fx-totals">
        <div className="fx-total"><b>{pct(block.score)}</b><small>{tr(`整體（${pick(sum.use_label)}）`, `Overall (${pick(sum.use_label)})`)}</small></div>
        {Number.isFinite(sum.ceiling?.score) && <div className="fx-total is-ceiling"><b>{pct(sum.ceiling.score)}</b><small>{tr('地球上最接近的窗格', 'Best any Earth window reaches')}</small></div>}
        <ul className="fx-counts">
          <li className="is-strong"><b>{count('strong')}</b>{tr('項強類比', ' strong')}</li>
          <li className="is-partial"><b>{count('partial')}</b>{tr('項部分相符', ' partial')}</li>
          <li className="is-break"><b>{count('breaks')}</b>{tr('項不成立', ' break down')}</li>
          <li className="is-unknown"><b>{count('unknown')}</b>{tr('項無資料', ' unknown')}</li>
          {naCount > 0 && <li className="is-na"><b>{naCount}</b>{tr('項不適用', ' not applicable')}</li>}
        </ul>
        <p className="fx-count-note">{tr(`以上為 ${block.facets.length} 個面向的判定。`, `Counts are of the ${block.facets.length} facets.`)}</p>
        {sum.ceiling && <p className="fx-legend"><i className="fx-key is-score" />{tr('這個候選', 'this candidate')}<i className="fx-key is-ceiling" />{tr('地球最高', 'best on Earth')}</p>}
      </div>
    </div>
    <Measured m={sum.measured} />
    <div className="fx-list">{block.facets.map(f => <Facet key={f.id} f={f} body={body} />)}</div>
  </section>
}
