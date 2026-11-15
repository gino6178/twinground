// Conversational analog search (2026-11-12). The user describes the conditions in words; a fine-tuned 1B language
// model on the server turns each message into a search spec (closed vocabulary), and the ranking itself is a fixed
// rule over measured Earth data. The spec is shown as chips the user can remove, and every result lists the measured
// value behind each condition. Follow-up messages edit the current spec.
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X, RotateCcw, MapPin, Copy, Footprints } from 'lucide-react'
import { getLanguage } from './i18n/core.js'
import './chat_search.css'
import { MaxMatchList } from './maxmatch_panel.jsx'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const EMPTY = { target: null, body: null, conditions: {}, region: null, exclude_regions: [], exclude_known: false, top_k: 10 }
const IMP = { must: ['必須', 'must'], prefer: ['偏好', 'prefer'], avoid: ['避開', 'avoid'] }
const EXAMPLES = [
  ['找跟耶澤羅隕石坑很像的地方，一定要很乾，有黏土更好', 'Places like Jezero crater: must be dry, clay would be nice'],
  ['月球南極的類比場址，要冷、太陽角度低，靠近道路', 'Lunar south pole analogs: cold, low sun, near a road'],
  ['美國境內像月海的玄武岩地形，最好在火山旁，排除已知場址', 'Basalt like the lunar maria in the US, ideally near a volcano, skip known sites'],
  ['極度乾燥又沒有植被的地方，不要撒哈拉和阿塔卡馬，給我 20 個', 'Hyper-arid, unvegetated places outside the Sahara and the Atacama, 20 results'],
]
// The 3D explorer needs a lunar or Martian world beside the Earth result: the spec's target when it has one
// (coordinates from scripts/chat_search/spec.py), otherwise a default for the body.
const CandidateExplore = React.lazy(() => import('./candidate_explore.jsx'))
const WORLD_TARGETS = {
  lunar_south_pole: ['moon', -84.6, 31.5, '月球南極', 'the lunar south pole'], shackleton: ['moon', -84.6, 31.5, '月球南極', 'the lunar south pole'],
  mare_tranquillitatis: ['moon', 8.5, 31.4, '靜海', 'Mare Tranquillitatis'], apollo_11: ['moon', 0.67, 23.47, '阿波羅 11 號登陸點', 'the Apollo 11 site'],
  apollo_15: ['moon', 26.1, 3.6, '阿波羅 15 號哈德利溪', 'the Apollo 15 Hadley Rille site'], apollo_17: ['moon', 20.2, 30.8, '阿波羅 17 號陶拉斯-利特羅谷', 'the Apollo 17 Taurus-Littrow valley'],
  marius_hills: ['moon', 13.4, -55.9, '馬利厄斯丘', 'the Marius Hills'], aristarchus: ['moon', 23.7, -47.4, '阿里斯塔克斯高原', 'the Aristarchus plateau'],
  copernicus: ['moon', 9.6, -20.1, '哥白尼隕石坑', 'Copernicus crater'], mare_imbrium: ['moon', 32.8, -15.6, '雨海', 'Mare Imbrium'],
  tranquillitatis_pit: ['moon', 8.34, 33.22, '靜海坑洞', 'the Mare Tranquillitatis pit'],
  jezero: ['mars', 18.4, 77.5, '耶澤羅隕石坑', 'Jezero crater'], gale: ['mars', -5.4, 137.8, '蓋爾隕石坑', 'Gale crater'],
  utopia_planitia: ['mars', 46.7, 117.5, '烏托邦平原', 'Utopia Planitia'], arcadia_planitia: ['mars', 47.2, -176.6, '阿卡迪亞平原', 'Arcadia Planitia'],
  olympus_mons: ['mars', 18.65, -133.8, '奧林帕斯山', 'Olympus Mons'], valles_marineris: ['mars', -13.9, -59.2, '水手號峽谷', 'Valles Marineris'],
  meridiani: ['mars', -1.95, -5.5, '子午線高原', 'Meridiani Planum'], hellas: ['mars', -42.4, 70.5, '希臘平原', 'Hellas Planitia'],
  elysium: ['mars', 3.0, 154.7, '埃律西昂平原', 'Elysium Planitia'], olympia_undae: ['mars', 81.4, 180.0, '奧林匹亞沙海', 'Olympia Undae'],
  phlegra_montes: ['mars', 40.4, 163.7, '弗萊格拉山脈', 'Phlegra Montes'], mawrth_vallis: ['mars', 22.6, -16.5, '馬沃斯谷', 'Mawrth Vallis'],
  mars_north_pole: ['mars', 85.0, 0.0, '火星北極', 'the Martian north pole'],
}
function worldSite(spec, x) {
  const [body, lat, lon, zh, en] = WORLD_TARGETS[spec.target] || WORLD_TARGETS[spec.body === 'mars' ? 'jezero' : 'marius_hills']
  const place = x.place ? `${x.place.name}, ${x.place.country}` : null
  const at = `${x.lat.toFixed(2)}°, ${x.lon.toFixed(2)}°`
  return { earth: { lat: x.lat, lon: x.lon, name: { zh: place ? `${place} · ${at}` : at, en: place ? `${place} · ${at}` : at } }, target: { body, lat, lon, name: [zh, titleName(en)] } }
}
// "the lunar south pole" reads as a sentence fragment when it heads a label: drop the article and capitalise.
const titleName = en => { const t = en.replace(/^the /, ''); return t.charAt(0).toUpperCase() + t.slice(1) }
const EXPLORE_KM = 20  // candidate_explore.jsx opens a 20 x 20 km scene (high-resolution DEM for the central 16 km)
// The server reply lists conditions as "must cold, must low sun, prefer clay" and names the target in lower case
// ("Target: the lunar south pole"). Rewrite that part from the structured spec so it reads as a sentence.
function tidyReply(res) {
  let text = res.reply || ''
  if (getLanguage() !== 'en') return text
  const lab = c => res.labels?.[c] || c
  const groups = { must: [], prefer: [], avoid: [] }
  Object.entries(res.applied || {}).forEach(([c, imp]) => groups[imp]?.push(lab(c)))
  const parts = [['Required', groups.must], ['Preferred', groups.prefer], ['Avoided', groups.avoid]].filter(([, l]) => l.length).map(([k, l]) => `${k}: ${l.join(', ')}`)
  const region = text.match(/Your conditions: (region: [^,.]+)/)?.[1]
  if (parts.length || region) text = text.replace(/Your conditions: [^.]*\./, `${[region && region[0].toUpperCase() + region.slice(1), ...parts].filter(Boolean).join('. ')}.`)
  return text.replace(/Target: the ([a-z])/, (_, ch) => `Target: ${ch.toUpperCase()}`)
}
const GRADE = { 2: 'is-match', 1: 'is-partial', 0: 'is-miss', [-1]: 'is-unknown' }

function postJson(body, signal) {
  return fetch('/api/chat-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j })
}

// Equirectangular Earth with the result dots; the active result is ringed.
function ResultMap({ results, active, onPick }) {
  const ref = useRef(null)
  const img = useMemo(() => { const i = new Image(); i.src = '/earth-color.jpg'; return i }, [])
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    let raf = 0, t0 = performance.now()
    const draw = now => {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, devicePixelRatio || 1)
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0)
      x.fillStyle = '#0b0b0b'; x.fillRect(0, 0, w, h)
      if (img.complete && img.naturalWidth) { x.globalAlpha = 0.55; x.filter = 'grayscale(1) contrast(1.1)'; x.drawImage(img, 0, 0, w, h); x.filter = 'none'; x.globalAlpha = 1 }
      const t = (now - t0) / 1000
      results.forEach((r, i) => {
        const px = (r.lon + 180) / 360 * w, py = (90 - r.lat) / 180 * h, on = i === active
        if (on) { const k = (t % 1.6) / 1.6; x.strokeStyle = `rgba(255,255,255,${1 - k})`; x.lineWidth = 1.5; x.beginPath(); x.arc(px, py, 5 + 14 * k, 0, Math.PI * 2); x.stroke() }
        x.fillStyle = on ? '#ffffff' : '#bdbdbd'; x.beginPath(); x.arc(px, py, on ? 4.5 : 3.2, 0, Math.PI * 2); x.fill()
        x.strokeStyle = '#000'; x.lineWidth = 1; x.stroke()
        if (on || results.length <= 12) { x.fillStyle = on ? '#fff' : '#cfcfcf'; x.font = `${on ? 700 : 600} 14px Manrope, "Noto Sans TC", system-ui, -apple-system, "Segoe UI", sans-serif`; x.fillText(String(i + 1), px + 6, py - 6) }
      })
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [results, active, img])
  const click = e => {
    const b = ref.current.getBoundingClientRect(), w = b.width, h = b.height
    let best = -1, dist = 18
    results.forEach((r, i) => { const d = Math.hypot((r.lon + 180) / 360 * w - (e.clientX - b.left), (90 - r.lat) / 180 * h - (e.clientY - b.top)); if (d < dist) { dist = d; best = i } })
    if (best >= 0) onPick(best)
  }
  return <canvas ref={ref} className="cs-map" onClick={click} role="img" aria-label={tr('結果位置地圖', 'Map of the results')} />
}

function Chips({ data, onSpec }) {
  if (!data) return null
  const { spec, applied, implied } = data
  const lab = c => data.labels?.[c] || c
  const drop = patch => onSpec({ ...spec, ...patch })
  const chips = []
  if (spec.target) chips.push(['target', titleName(data.target_label || spec.target), () => drop({ target: null })])
  else if (spec.body) chips.push(['body', spec.body === 'moon' ? tr('月球', 'Moon') : tr('火星', 'Mars'), () => drop({ body: null })])
  Object.entries(applied).forEach(([c, imp]) => {
    const fromTarget = implied.includes(c)
    chips.push([c, `${tr(...IMP[imp])} · ${lab(c)}${fromTarget ? tr('（目標）', ' (target)') : ''}`,
      fromTarget ? null : () => { const n = { ...spec.conditions }; delete n[c]; drop({ conditions: n }) }, imp])
  })
  if (spec.region) chips.push(['region', `${tr('範圍', 'in')} · ${data.region_labels?.[spec.region] || spec.region}`, () => drop({ region: null })])
  spec.exclude_regions.forEach(r => chips.push(['x' + r, `${tr('排除', 'not')} · ${data.region_labels?.[r] || r}`, () => drop({ exclude_regions: spec.exclude_regions.filter(x => x !== r) }), 'avoid']))
  if (spec.exclude_known) chips.push(['known', tr('排除已知場址', 'no known sites'), () => drop({ exclude_known: false })])
  return <div className="cs-chips" aria-label={tr('目前的搜尋條件', 'Current search conditions')}>
    {chips.map(([k, text, remove, imp]) => <span key={k} className={`cs-chip ${imp ? 'imp-' + imp : ''}`}>{text}
      {remove && <button type="button" onClick={remove} aria-label={tr('移除', 'Remove') + ' ' + text}><X size={12} /></button>}</span>)}
  </div>
}

export default function ChatSearch() {
  const [turns, setTurns] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState(null)
  const [world, setWorld] = useState(null)
  const abort = useRef(null)
  const log = useRef(null)
  const spec = data?.spec || EMPTY
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }) }, [turns, busy])

  const send = (payload, userText) => {
    abort.current?.abort(); const ctl = new AbortController(); abort.current = ctl
    setBusy(true); setError(null)
    if (userText) setTurns(t => [...t, { who: 'user', text: userText }])
    postJson({ lang: getLanguage() === 'en' ? 'en' : 'zh', previous: spec, ...payload }, ctl.signal)
      .then(res => {
        if (res.available === false) { setError(res.reason); setTurns(t => [...t, { who: 'bot', text: res.reason, failed: true }]); return }
        if (res.chat_only) { setTurns(t => [...t, { who: 'bot', text: res.reply }]); return }  // small talk: keep the current results
        setData(res); setActive(0)
        setTurns(t => [...t, { who: 'bot', text: tidyReply(res), ms: res.model_ms }])
      })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setTurns(t => [...t, { who: 'bot', text: tr('搜尋失敗：', 'Search failed: ') + e.message, failed: true }]) } })
      .finally(() => { if (abort.current === ctl) setBusy(false) })
  }
  const submit = e => { e?.preventDefault(); const text = input.trim(); if (!text || busy) return; setInput(''); send({ message: text }, text) }
  const reset = () => { abort.current?.abort(); setTurns([]); setData(null); setError(null); setBusy(false) }
  const results = data?.results || []
  const r = results[active]

  return <main className="cs-page">
    <section className="cs-chat" aria-labelledby="cs-title">
      <header className="cs-head">
        <h1 id="cs-title">{tr('對話搜尋', 'Search by conversation')}</h1>
        <p>{tr('用一句話描述需要的條件，例如目標、乾燥、寒冷、岩性、地區。之後可以接著說「改成火星」「不要南極」「多給幾個」。',
          'Describe the conditions in a sentence: target, dryness, cold, rock type, region. Then keep going: "switch to Mars", "not Antarctica", "show more".')}</p>
        {turns.length > 0 && <button type="button" className="cs-reset" onClick={reset}><RotateCcw size={14} /> {tr('重新開始', 'Start over')}</button>}
      </header>
      <div className="cs-log" ref={log} aria-live="polite">
        {turns.length === 0 && <div className="cs-examples">
          <span>{tr('試試看', 'Try')}</span>
          {EXAMPLES.map(([zh, en]) => <button key={zh} type="button" onClick={() => send({ message: tr(zh, en) }, tr(zh, en))}>{tr(zh, en)}</button>)}
        </div>}
        {turns.map((t, i) => <div key={i} className={`cs-turn is-${t.who} ${t.failed ? 'is-failed' : ''}`}><p>{t.text}</p>
          {t.ms != null && <small>{tr(`語言模型 ${t.ms} ms`, `language model ${t.ms} ms`)}</small>}</div>)}
        {busy && <div className="cs-turn is-bot is-busy" aria-label={tr('搜尋中', 'Searching')}><i /><i /><i /></div>}
      </div>
      <Chips data={data} onSpec={next => send({ spec: next }, null)} />
      <form className="cs-input" onSubmit={submit}>
        <textarea value={input} rows={2} maxLength={600} placeholder={turns.length ? tr('接著說…（例如：改成火星、不要南極、多給幾個）', 'Keep going… (e.g. switch to Mars, not Antarctica, show more)') : tr('描述你要找的環境…', 'Describe the environment you need…')}
          onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e) }} aria-label={tr('搜尋條件', 'Search conditions')} />
        <button type="submit" disabled={busy || !input.trim()} aria-label={tr('送出', 'Send')}><ArrowUp size={18} /></button>
      </form>
    </section>

    <section className="cs-results" aria-label={tr('搜尋結果', 'Results')}>
      <ResultMap results={results} active={active} onPick={setActive} />
      {!data && <p className="cs-empty">{tr('結果會出現在這裡。', 'Results appear here.')}</p>}
      {data && !results.length && <p className="cs-empty">{tr('沒有符合的地點，請放寬條件。', 'Nothing qualifies; relax a condition.')}</p>}
      {data && results.length > 0 && <p className="cs-pool">{tr(`符合條件的窗格 ${data.pool.toLocaleString()} 個，挑出彼此相距 150 km 以上的前 ${results.length} 個`, `${data.pool.toLocaleString()} windows qualify; the top ${results.length} at least 150 km apart`)}</p>}
      <ol className="cs-list">
        {results.map((x, i) => <li key={x.id} className={i === active ? 'is-active' : ''}>
          <button type="button" className="cs-item" onClick={() => setActive(i)} aria-pressed={i === active}>
            <span className="cs-rank">{i + 1}</span>
            <span className="cs-where"><b>{x.place ? `${x.place.name}, ${x.place.country}` : tr('偏遠地區', 'Remote area')}</b>
              <small>{x.lat.toFixed(2)}°, {x.lon.toFixed(2)}° · {tr(`${x.patch_km} km 搜尋窗格`, `${x.patch_km} km search window`)}{x.patch_km !== EXPLORE_KM ? tr(`（3D 漫步為中央 ${EXPLORE_KM} km）`, ` (3D walk: central ${EXPLORE_KM} km)`) : ''}{x.place ? ` · ${tr('距', '')}${x.place.name} ${x.place.km} km` : ''}</small></span>
            {x.known_analog && <span className="cs-known">{tr('已知類比地附近', 'near a known analog')}</span>}
          </button>
          {i === active && <div className="cs-detail">
            {x.measured && <MaxMatchList block={x.measured} />}
            <ul>{x.conditions.map(c => <li key={c.id} className={GRADE[c.grade]}><span>{data.labels?.[c.id] || c.id}</span><b>{c.text}</b><em>{c.grade === 2 ? tr('符合', 'match') : c.grade === 1 ? tr('部分', 'partial') : c.grade === 0 ? tr('不符', 'miss') : tr('無資料', 'no data')}</em></li>)}</ul>
            <p>{tr('距最近道路', 'Nearest road')} {x.road_km} km{x.known_analog ? ` · ${tr('附近已知類比地：', 'known analog nearby: ')}${(getLanguage() === 'en' ? x.known_analog.name : x.known_analog.name_zh || x.known_analog.name)}${tr(`（${x.known_analog.distance_km} km）`, ` (${x.known_analog.distance_km} km)`)}` : ''}</p>
            <div className="cs-actions">
              <button type="button" onClick={() => setWorld(worldSite(spec, x))}><Footprints size={13} /> {tr('走進 3D 世界', 'Walk in 3D')}</button>
              <button type="button" onClick={() => navigator.clipboard?.writeText(`${x.lat}, ${x.lon}`)}><Copy size={13} /> {tr('複製座標', 'Copy coordinates')}</button>
              <a href={`https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lon}#map=9/${x.lat}/${x.lon}`} target="_blank" rel="noreferrer"><MapPin size={13} /> {tr('在地圖上看', 'Open in a map')}</a>
            </div>
          </div>}
        </li>)}
      </ol>
      {r && data.relaxed && <p className="cs-note">{tr('符合所有必要條件的地點太少，結果已改為依符合程度排序。', 'Too few places met every required condition, so results are ranked by how well they match.')}</p>}
    </section>
    {world && <Suspense fallback={null}><CandidateExplore site={world} onClose={() => setWorld(null)} /></Suspense>}
  </main>
}
