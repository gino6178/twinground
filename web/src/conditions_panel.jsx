import React, { useEffect, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import { ConditionArt } from './conditions_art.jsx'
import './conditions_panel.css'
import { AnalogySummary } from './analogy_summary.jsx'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const pick = t => (t ? (getLanguage() === 'en' ? t.en : t.zh) : '')
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: d }) : '—')

const VERDICT = {
  2: ['is-match', '✓', ['相符', 'match']],
  1: ['is-partial', '~', ['部分', 'partial']],
  0: ['is-miss', '✗', ['不符', 'mismatch']],
  [-1]: ['is-unknown', '?', ['無資料', 'no data']],
}
const CATEGORY = { environment: ['環境', 'Environment'], geology: ['地質', 'Geology'], resource: ['資源', 'Resource'] }
const STATUS = { yes: ['可測', 'yes'], partly: ['部分可測', 'partly'], no: ['不建議', 'not suited'] }
const MONTHS = [['1', 'Jan'], ['2', 'Feb'], ['3', 'Mar'], ['4', 'Apr'], ['5', 'May'], ['6', 'Jun'], ['7', 'Jul'], ['8', 'Aug'], ['9', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec']]

// Field season rule (display only): monthly mean 2 m temperature between -15 and 35 C and under 5 mm of rain a day.
const fieldMonth = (t, p) => Number.isFinite(t) && t >= -15 && t <= 35 && (!Number.isFinite(p) || p < 5)

// Each chart starts empty and animates to its value when it scrolls into view; switching candidates then animates
// from the previous value. CSS turns the transitions off under prefers-reduced-motion.
function useInView() {
  // callback ref: a component may swap its root element (loading text -> chart), so observe whichever is mounted
  const [el, ref] = useState(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!el || shown) return
    if (typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setShown(true); io.disconnect() } }, { rootMargin: '0px 0px -10% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el, shown])
  return [ref, shown]
}

function FitRing({ c }) {
  const [ref, shown] = useInView()
  const R = 40, L = 2 * Math.PI * R
  const parts = [[2, c.matched], [1, c.partial], [0, c.mismatched], [-1, c.unknown]]
  const total = Math.max(1, parts.reduce((s, [, n]) => s + n, 0))
  let offset = 0
  return <figure ref={ref} className="fit-ring" aria-label={tr(`條件符合度 ${fmt((c.fit ?? 0) * 100)}%`, `Condition fit ${fmt((c.fit ?? 0) * 100)}%`)}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={R} className="ring-track" />
      {parts.map(([v, n]) => {
        const len = shown ? L * n / total : 0
        const el = <circle key={v} cx="50" cy="50" r={R} className={`ring-seg ${VERDICT[v][0]}`} strokeDasharray={`${len} ${L}`} strokeDashoffset={-offset} />
        offset += len
        return el
      })}
    </svg>
    <figcaption><b>{c.fit == null ? '—' : `${fmt(c.fit * 100)}%`}</b><span>{tr('條件符合度', 'condition fit')}</span></figcaption>
    <ul className="fit-legend">
      {parts.map(([v, n]) => n > 0 && <li key={v} className={VERDICT[v][0]}><i />{n} {tr(...VERDICT[v][2])}</li>)}
    </ul>
  </figure>
}

function Gauge({ g, verdict }) {
  const [ref, shown] = useInView()
  if (!g || g.value == null) return <div ref={ref} className="gauge is-empty"><span>{tr('無資料', 'no data')}</span></div>
  const span = g.max - g.min || 1
  const x = v => Math.min(100, Math.max(0, 100 * (v - g.min) / span))
  const zones = g.higher_is_better
    ? [['zone-partial', x(g.partial), x(g.match)], ['zone-match', x(g.match), 100]]
    : [['zone-match', 0, x(g.match)], ['zone-partial', x(g.match), x(g.partial)]]
  const label = v => g.unit === '%' ? `${fmt(v * 100)}%` : g.unit === '°' ? `${fmt(v)}°` : g.unit === 'km' ? `${fmt(v)} km` : fmt(v, 2)
  const pos = shown ? x(g.value) : (g.higher_is_better ? 0 : 100)
  return <div ref={ref} className={`gauge ${VERDICT[verdict]?.[0] || ''}`}>
    <div className="gauge-track">
      {zones.map(([cls, a, b]) => <span key={cls} className={cls} style={{ left: `${a}%`, width: `${Math.max(0, b - a)}%` }} />)}
      <i className="gauge-marker" style={{ left: `${pos}%` }} />
    </div>
    <div className="gauge-scale"><span>{label(g.min)}</span><span>{g.ice_cover ? tr('冰川或冰原覆蓋', 'glaciers or ice sheet') : g.via_sand ? tr('沙丘少，但表土含沙 ≥ 60%', 'few dunes, but topsoil ≥ 60% sand') : label(g.raw ?? g.value)}</span><span>{label(g.max)}{g.max === 400 && g.unit === 'km' ? '+' : ''}</span></div>
  </div>
}

function AccessBars({ acc }) {
  const [ref, shown] = useInView()
  // log scale from 1 km to 5,000 km so a 3 km road and a 900 km airport both read
  const w = km => shown ? Math.min(100, Math.max(2, 100 * Math.log10(Math.max(1, km)) / Math.log10(5000))) : 0
  const rows = [
    ['road', tr('主要道路', 'Major road'), acc.road_km, ''],
    ['town', tr('城鎮', 'Town'), acc.place?.distance_km, `${acc.place?.name || ''}${acc.place?.country ? tr(`，${acc.place.country}`, `, ${acc.place.country}`) : ''}`],
    ['airport', tr('機場', 'Airport'), acc.airport?.distance_km, `${acc.airport?.name || ''}${acc.airport?.iata ? ` (${acc.airport.iata})` : ''}`],
  ]
  return <ul ref={ref} className="access-bars">
    {rows.map(([k, label, km, name]) => <li key={k}>
      <span className="access-label">{label}</span>
      <span className="access-track"><i style={{ width: `${w(km)}%` }} /></span>
      <span className="access-value"><b>{fmt(km)} km</b>{name && <small>{name}</small>}</span>
    </li>)}
  </ul>
}

function FieldSeason({ env }) {
  const [ref, shown] = useInView()
  const temps = env?.temperature_monthly_c, rain = env?.precipitation_monthly_mm_day
  if (!env?.available || !Array.isArray(temps) || temps.length !== 12) {
    return <p ref={ref} className="cond-note">{env && !env.available ? tr('氣候資料暫時無法讀取。', 'Climate data is unavailable right now.') : tr('正在讀取每月氣候…', 'Loading monthly climate…')}</p>
  }
  const ok = temps.map((t, i) => fieldMonth(t, rain?.[i]))
  const lo = Math.min(...temps, -40), hi = Math.max(...temps, 40)
  const good = MONTHS.filter((_, i) => ok[i]).map(m => tr(`${m[0]} 月`, m[1]))
  const y = t => 100 * (t - lo) / Math.max(1, hi - lo)
  return <div ref={ref} className="cond-season">
    <div className="season-chart" aria-label={tr('每月平均氣溫與適合野外作業的月份', 'Monthly mean temperature and field months')}>
      <span className="season-band" style={{ bottom: `${y(-15)}%`, height: `${y(35) - y(-15)}%` }} />
      <ol>
        {temps.map((t, i) => <li key={i} className={ok[i] ? 'is-ok' : ''} title={`${tr(MONTHS[i][0] + ' 月', MONTHS[i][1])}: ${fmt(t, 1)} °C, ${fmt(rain?.[i], 1)} mm/${tr('日', 'day')}`}>
          <i style={{ height: `${shown ? Math.max(4, y(t)) : 0}%`, transitionDelay: `${i * 30}ms` }} /><span>{tr(MONTHS[i][0], MONTHS[i][1][0])}</span>
        </li>)}
      </ol>
    </div>
    <p>{good.length === 12 ? tr('全年都適合野外作業。', 'Fieldwork is possible all year.')
      : good.length ? tr(`適合野外作業的月份：${good.join('、')}。`, `Field months: ${good.join(', ')}.`)
      : tr('沒有月份符合野外作業條件。', 'No month meets the field rule.')}
      {' '}{tr(`月均溫 ${fmt(Math.min(...temps), 0)}～${fmt(Math.max(...temps), 0)} °C；綠色帶是可作業的 −15～35 °C，另需日雨量 < 5 mm。`, `Monthly means ${fmt(Math.min(...temps), 0)} to ${fmt(Math.max(...temps), 0)} °C; the green band is the workable −15 to 35 °C, with rain < 5 mm/day.`)}</p>
  </div>
}

function TestList({ tests }) {
  const [ref, shown] = useInView()
  return <ul ref={ref} className={`cond-tests ${shown ? 'is-shown' : ''}`}>{tests.map((t, i) => <li key={t.id} className={`is-${t.status}`} style={{ transitionDelay: `${i * 60}ms` }}>
    <b>{pick(t.label)}</b><span>{tr(...STATUS[t.status])}</span>
  </li>)}</ul>
}

function ReadRow({ q, body, value }) {
  const [ref, shown] = useInView()
  return <li ref={ref}>
    <b>{pick(q.label)}</b>
    <div className="read-dual">
      <span className="read-track"><i className="is-query" style={{ left: `${shown ? 100 * q.query_percentile : 0}%` }} /><i className="is-earth" style={{ left: `${shown ? 100 * (value ?? 0) : 0}%` }} /></span>
      <span className="read-legend"><em className="is-query">{tr('查詢地', 'Query')} {fmt(100 * q.query_percentile)}% {body === 'mars' ? tr('（火星窗格內）', 'of Mars windows') : tr('（月球窗格內）', 'of Moon windows')}</em><em className="is-earth">{tr('候選', 'Candidate')} {fmt(100 * (value ?? NaN))}% {tr('（地球窗格內）', 'of Earth windows')}</em></span>
    </div>
    <small>{validationText(q)}</small>
  </li>
}

function CandidateStrip({ data, matches, active, onActive, placeOf }) {
  const rows = matches.filter(m => m.conditions?.available).slice(0, 12)
  const conds = data.conditions?.conditions || []
  if (rows.length < 2) return null
  return <div className="cand-strip">
    <div className="cand-strip-head"><h3>{tr('全部候選一覽', 'All candidates at a glance')}</h3><span>{tr('點一欄切換候選', 'click a column to switch')}</span></div>
    <div className="cand-grid" style={{ gridTemplateColumns: `minmax(7.5em, 13em) repeat(${rows.length}, minmax(26px, 60px))` }} role="table">
      <span className="cand-corner" role="columnheader" />
      {rows.map(m => <button key={m.id} type="button" role="columnheader" className={`cand-col ${m.id === active.id ? 'is-active' : ''}`}
        onClick={() => onActive?.(m.id)} title={placeOf ? placeOf(m) : m.name}>#{data.matches.indexOf(m) + 1}</button>)}
      {conds.map(cd => <React.Fragment key={cd.id}>
        <span className="cand-row-label" role="rowheader" title={pick(cd.label)}>{pick(cd.label)}</span>
        {rows.map(m => {
          const r = m.conditions.rows.find(x => x.id === cd.id)
          const v = r ? r.verdict : -1
          return <button key={m.id} type="button" role="cell" className={`cand-cell ${VERDICT[v][0]} ${m.id === active.id ? 'is-active' : ''}`}
            onClick={() => onActive?.(m.id)} title={`#${data.matches.indexOf(m) + 1} · ${pick(cd.label)}: ${r ? pick(r.earth) : tr('無資料', 'no data')}`}>
            <span aria-hidden="true">{VERDICT[v][1]}</span><span className="sr-only">{tr(...VERDICT[v][2])}</span>
          </button>
        })}
      </React.Fragment>)}
      <span className="cand-row-label is-fit" role="rowheader">{tr('符合度', 'Fit')}</span>
      {rows.map(m => <button key={m.id} type="button" role="cell" className={`cand-cell is-fit ${m.id === active.id ? 'is-active' : ''}`} onClick={() => onActive?.(m.id)}>
        <i style={{ height: `${Math.round(100 * (m.conditions.fit ?? 0))}%` }} /><span className="sr-only">{fmt(100 * (m.conditions.fit ?? 0))}%</span>
      </button>)}
    </div>
  </div>
}

// Conditions v1 for the active candidate, drawn as gauges: what the query asks of an Earth analog, where this place
// sits on each scale, what can be tested there and how to get there. Data sources are listed in the paper, not here.
export function ConditionsPanel({ data, matches, active, place, earthEnvironment, onActive, placeOf }) {
  useLanguage()
  const c = active?.conditions, summary = data.conditions
  if (!c?.available || !summary) return null
  const gate = summary.gate
  return <section className="cond-panel" id="conditions-panel" aria-labelledby="conditions-title">
    <header className="cond-head">
      <FitRing c={c} />
      <div className="cond-head-text">
        <h2 id="conditions-title">{tr('條件對照與場址檔案', 'Conditions and site dossier')}</h2>
        <p><span className="cond-chip is-query">{tr('查詢地', 'Query')}</span>{pick(summary.setting_text)}{summary.unit?.code ? tr(`（${summary.unit.code}）`, ` (${summary.unit.code})`) : ''}</p>
        <p><span className="cond-chip is-earth">{tr('候選', 'Candidate')}</span><b>#{data.matches.findIndex(m => m.id === active.id) + 1}</b> {place}</p>
        <p className="cond-lead">{data.purpose === 'conditions'
          ? tr(`先篩出 ${fmt(gate?.gated_windows)} 個符合條件的地球窗格（符合度 ≥ ${fmt((gate?.gate_level || 0) * 100)}%），再依地形相似度排序。`,
            `${fmt(gate?.gated_windows)} Earth windows met the conditions (fit ≥ ${fmt((gate?.gate_level || 0) * 100)}%) before terrain ranking.`)
          : tr('這個用途不以條件排序；改用「條件優先」可以先篩條件。', 'This purpose does not rank by conditions; the condition-first purpose filters by them first.')}</p>
      </div>
    </header>

    <CandidateStrip data={data} matches={matches || data.matches} active={active} onActive={onActive} placeOf={placeOf} />

    <AnalogySummary rows={c.rows} body={data.window.body} env={earthEnvironment} lat={data.window.lat} lon={data.window.lon} />

    <div className="gauge-list">
      {c.rows.map(r => {
        const [cls, mark, word] = VERDICT[r.verdict] || VERDICT[-1]
        return <article key={r.id} className={`gauge-row ${cls}`}>
          <div className="gauge-head">
            <span className={`cond-cat cat-${r.category}`}>{tr(...CATEGORY[r.category])}</span>
            <h4>{pick(r.label)}</h4>
            <span className="cond-verdict"><span aria-hidden="true">{mark}</span> {tr(...word)}</span>
          </div>
          <div className={`gauge-body ${r.id === 'lithology' ? 'is-wide' : ''}`}>
            <ConditionArt row={r} earthLithology={active.earth_lithology} />
            <div className="gauge-main">
              <p className="gauge-query"><span>{tr('查詢地', 'Query')}</span>{pick(r.query)}<span>{tr('需要', 'needs')}</span>{pick(r.need)}</p>
              <Gauge g={r.gauge} verdict={r.verdict} />
              <p className="gauge-earth">{pick(r.earth)}</p>
            </div>
          </div>
        </article>
      })}
    </div>

    {data.terrain_read?.questions?.length > 0 && active.terrain_read && <div className="cond-read">
      <h3>{tr(`地形＋材質判讀（SysOne-Nano，${fmt(data.terrain_read.parameters)} 個參數）`, `Terrain + material reading (SysOne-Nano, ${fmt(data.terrain_read.parameters)} parameters)`)}</h3>
      <ul>{data.terrain_read.questions.map(q => <ReadRow key={q.id} q={q} body={data.window.body} value={active.terrain_read[q.id]} />)}</ul>
    </div>}

    <div className="cond-grid">
      <div>
        <h3>{tr('能在這裡測什麼', 'What can be tested here')}</h3>
        <TestList tests={c.tests || []} />
      </div>
      <div>
        <h3>{tr('去不去得了', 'Getting there')}</h3>
        {c.access && <AccessBars acc={c.access} />}
        <h3>{tr('野外季節', 'Field season')}</h3>
        <FieldSeason env={earthEnvironment} />
      </div>
    </div>
  </section>
}

const validationText = q => q.validation.map(v => (v.test.startsWith('moon') ? tr('月球地質圖', 'lunar geologic map') : v.test === 'mars_swim' ? tr('SWIM 地下冰', 'SWIM ground ice') : tr('火星地質圖', 'Mars geologic map'))
  + ' AUC ' + v.auc.toFixed(2)).join(' · ')
const readNote = () => tr(
  '以地形形狀與材質軸（反照率、鐵、鎂鐵、含水）判讀，只用 50 萬個地球窗格的開放資料訓練；數字是與同一顆星球的窗格相比的排名，不是機率。只列出通過月球、火星地質圖測試的判讀；不參與排序。',
  'Read from terrain shape and material axes (albedo, iron, mafic, hydrated), trained only on open data for 500,000 Earth windows. Values rank the window against windows of the same body and are not probabilities. Only readings that passed the lunar or Mars geologic-map test are shown; not used for ranking.')

// One-line condition summary for result cards: matched conditions first, then the first gap.
export function conditionReasons(row) {
  const c = row?.conditions
  if (!c?.available) return { ok: [], unknown: [] }
  const ok = c.rows.filter(r => r.verdict === 2).map(r => `${pick(r.label)}${tr('：', ': ')}${pick(r.earth)}`)
  const gaps = c.rows.filter(r => r.verdict !== 2).map(r => `${pick(r.label)}${r.verdict === 1 ? tr('部分相符', ' partly') : r.verdict === 0 ? tr('不符', ' mismatch') : tr('無資料', ' no data')}`)
  return { ok, unknown: gaps }
}
