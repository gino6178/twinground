// Conversational analog search (2026-11-12). The user describes the conditions in words; a fine-tuned 1B language
// model on the server turns each message into a search spec (closed vocabulary), and the ranking itself is a fixed
// rule over measured Earth data. The spec is shown as chips the user can remove, and every result lists the measured
// value behind each condition. Follow-up messages edit the current spec.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X, RotateCcw, MapPin, Copy } from 'lucide-react'
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
        if (on || results.length <= 12) { x.fillStyle = on ? '#fff' : '#cfcfcf'; x.font = `${on ? 700 : 600} 11px Manrope, system-ui, sans-serif`; x.fillText(String(i + 1), px + 6, py - 6) }
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
  if (spec.target) chips.push(['target', data.target_label || spec.target, () => drop({ target: null })])
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
        setTurns(t => [...t, { who: 'bot', text: res.reply, ms: res.model_ms }])
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
      <p className="cs-note">{tr('語言模型只把文字轉成條件；排序依實測資料的固定規則，不是模型的判斷。每個結果都列出條件背後的數值。',
        'The language model only turns words into conditions; ranking follows fixed rules on measured data, not the model. Every result shows the values behind each condition.')}</p>
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
              <small>{x.lat.toFixed(2)}°, {x.lon.toFixed(2)}° · {x.patch_km} km {tr('窗格', 'window')}{x.place ? ` · ${tr('距', '')}${x.place.name} ${x.place.km} km` : ''}</small></span>
            {x.known_analog && <span className="cs-known">{tr('已知類比地附近', 'near a known analog')}</span>}
          </button>
          {i === active && <div className="cs-detail">
            {x.measured && <MaxMatchList block={x.measured} />}
            <ul>{x.conditions.map(c => <li key={c.id} className={GRADE[c.grade]}><span>{data.labels?.[c.id] || c.id}</span><b>{c.text}</b><em>{c.grade === 2 ? tr('符合', 'match') : c.grade === 1 ? tr('部分', 'partial') : c.grade === 0 ? tr('不符', 'miss') : tr('無資料', 'no data')}</em></li>)}</ul>
            <p>{tr('距最近道路', 'Nearest road')} {x.road_km} km{x.known_analog ? ` · ${tr('附近已知類比地：', 'known analog nearby: ')}${(getLanguage() === 'en' ? x.known_analog.name : x.known_analog.name_zh || x.known_analog.name)}（${x.known_analog.distance_km} km）` : ''}</p>
            <div className="cs-actions">
              <button type="button" onClick={() => navigator.clipboard?.writeText(`${x.lat}, ${x.lon}`)}><Copy size={13} /> {tr('複製座標', 'Copy coordinates')}</button>
              <a href={`https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lon}#map=9/${x.lat}/${x.lon}`} target="_blank" rel="noreferrer"><MapPin size={13} /> {tr('在地圖上看', 'Open in a map')}</a>
            </div>
          </div>}
        </li>)}
      </ol>
      {r && data.relaxed && <p className="cs-note">{tr('符合所有必要條件的地點太少，結果已改為依符合程度排序。', 'Too few places met every required condition, so results are ranked by how well they match.')}</p>}
    </section>
  </main>
}
