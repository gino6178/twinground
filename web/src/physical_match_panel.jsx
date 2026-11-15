import React, { useEffect, useRef, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import './physical_match_panel.css'

// Physical match v5 on the results page: the query window and the active Earth candidate compared property by
// property in the same units (orbital chemistry, albedo, roughness). Each property is a ComparisonToken from the API;
// the tile animates the two values (gamma-ray spectrum, reflected light, terrain profile, thermometer) and a gauge
// shows the tolerance band. Use rings show the candidate's use score against Earth's measured ceiling (C_meas).
// Display only: verdicts and scores come from the server. Motion is off under prefers-reduced-motion.
const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const pick = t => (t ? (getLanguage() === 'en' ? t.en : t.zh) : '')
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: d }) : '—')
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const USE_TEXT = {
  isru: [['原地資源利用', 'ISRU'], ['FeO、TiO₂、K、Th', 'FeO, TiO₂, K, Th']],
  mobility: [['車輛與步行移動', 'Mobility'], ['粗糙度', 'roughness']],
  thermal: [['熱環境', 'Thermal'], ['日夜溫度、反照率', 'day/night temperature, albedo']],
  base: [['基地選址', 'Base siting'], ['粗糙度、夜溫、反照率', 'roughness, night temperature, albedo']],
}
const VERDICT = {
  met: ['is-match', '✓', ['相符', 'within tolerance']],
  partial: ['is-partial', '~', ['可能相符', 'possibly']],
  not_met: ['is-miss', '✗', ['不符', 'outside tolerance']],
  earth_cannot_supply: ['is-cannot', '⊘', ['地球無此值', 'Earth cannot supply']],
  not_scored: ['is-unknown', '…', ['估計值，未計分', 'estimate, not scored']],
  unknown: ['is-unknown', '?', ['地球無資料', 'no Earth data']],
}
const SOURCE = { measured: ['實測', 'measured'], estimated: ['估計', 'estimated'], missing: ['無資料', 'no data'] }
const DIGITS = { feo: 1, tio2: 2, k: 2, th: 1, albedo: 3, roughness: 2, t_day: 0, t_night: 0 }

function useInView() {
  const [el, ref] = useState(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!el || shown) return
    if (typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setShown(true); io.disconnect() } }, { rootMargin: '0px 0px -10% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el, shown])
  return [ref, shown]
}

const PROP_NAME = { feo: ['FeO', 'FeO'], tio2: ['TiO₂', 'TiO₂'], k: ['K', 'K'], th: ['Th', 'Th'], roughness: ['粗糙度', 'roughness'],
  albedo: ['反照率', 'albedo'], t_day: ['日間溫度', 'day temperature'], t_night: ['夜間溫度', 'night temperature'] }

function UseRing({ use, score, ceiling, props }) {
  const [ref, shown] = useInView()
  const R = 34, L = 2 * Math.PI * R
  const s = shown && Number.isFinite(score) ? score : 0
  const c = Number.isFinite(ceiling) ? ceiling : null
  const tick = c == null ? null : (c * 360 - 90) * Math.PI / 180
  return <figure ref={ref} className="pm-ring" aria-label={tr(`${USE_TEXT[use][0][0]} ${fmt(score * 100, 0)}%，地球上限 ${fmt((c ?? 0) * 100, 0)}%`, `${USE_TEXT[use][0][1]} ${fmt(score * 100, 0)}%, Earth ceiling ${fmt((c ?? 0) * 100, 0)}%`)}>
    <svg viewBox="0 0 88 88" aria-hidden="true">
      <circle cx="44" cy="44" r={R} className="pm-ring-track" />
      {c != null && <circle cx="44" cy="44" r={R} className="pm-ring-ceiling" strokeDasharray={`${L * c} ${L}`} transform="rotate(-90 44 44)" />}
      <circle cx="44" cy="44" r={R} className="pm-ring-score" strokeDasharray={`${L * s} ${L}`} transform="rotate(-90 44 44)" />
      {tick != null && <line x1={44 + (R - 8) * Math.cos(tick)} y1={44 + (R - 8) * Math.sin(tick)} x2={44 + (R + 8) * Math.cos(tick)} y2={44 + (R + 8) * Math.sin(tick)} className="pm-ring-tick" />}
      <text x="44" y="47" className="pm-ring-value">{fmt(score * 100, 0)}%</text>
    </svg>
    <figcaption><b>{tr(...USE_TEXT[use][0])}</b><small>{props?.length ? props.map(p => tr(...(PROP_NAME[p] || [p, p]))).join(getLanguage() === 'en' ? ', ' : '、') : tr(...USE_TEXT[use][1])}</small>
      <small className="pm-ceiling">{c == null ? '' : tr(`地球上限 ${fmt(c * 100, 0)}%`, `Earth ceiling ${fmt(c * 100, 0)}%`)}</small></figcaption>
  </figure>
}

// ---------------------------------------------------------------- animated scenes (canvas, 160 x 64 logical units)
const LINE_MEV = { k: 1.46, th: 2.61, feo: 7.63, tio2: 6.76 }
function drawSpectrum(ctx, t, q, e, tok) {
  // gamma-ray spectrum: a continuum falling with energy and the element's line; line height follows the value
  const top = Math.max(q, e ?? 0, 1e-6) * 1.25
  const peak = LINE_MEV[tok.id] / 9
  const halves = [[q, '#9db7ff', 0], [e, '#ececec', 80]]
  ctx.fillStyle = '#07161a'; ctx.fillRect(0, 0, 160, 64)
  for (const [v, col, x0] of halves) {
    ctx.fillStyle = col
    for (let b = 0; b < 38; b++) {
      const en = b / 38
      const cont = 0.55 * Math.exp(-3 * en)
      const line = v == null ? 0 : (v / top) * Math.exp(-((en - peak) ** 2) / 0.0012)
      const n = 1 + 0.12 * Math.sin(t * 7 + b * 2.3) + 0.08 * Math.sin(t * 13 + b * 5.1)
      const h = Math.max(0.5, 52 * (cont + 0.8 * line) * n)
      ctx.globalAlpha = v == null ? 0.25 : 0.9
      ctx.fillRect(x0 + 4 + b * 1.9, 60 - h, 1.4, h)
    }
    ctx.globalAlpha = 1
  }
  ctx.fillStyle = '#284a50'; ctx.fillRect(79.5, 4, 1, 56)
}
function drawAlbedo(ctx, t, q, e) {
  // sunlight hitting the ground; reflected rays and ground brightness follow albedo (0.5 drawn as full white)
  ctx.fillStyle = '#050d10'; ctx.fillRect(0, 0, 160, 64)
  for (const [v, x0] of [[q, 0], [e, 80]]) {
    const a = v == null ? 0 : Math.min(1, v / 0.5)
    const g = Math.round(30 + 200 * a)
    ctx.fillStyle = `rgb(${g},${g},${Math.round(g * 0.96)})`; ctx.fillRect(x0 + 2, 50, 76, 12)
    for (let r = 0; r < 4; r++) {
      const ph = (t * 0.8 + r * 0.25) % 1
      const x = x0 + 10 + r * 16, y = 4 + ph * 46
      ctx.strokeStyle = 'rgba(255,214,120,.85)'; ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.moveTo(x - 10, y - 10); ctx.lineTo(x, y); ctx.stroke()
      if (v != null) {
        const ph2 = (t * 0.8 + r * 0.25 + 0.5) % 1
        ctx.strokeStyle = `rgba(255,236,190,${0.15 + 0.8 * a})`
        ctx.beginPath(); ctx.moveTo(x + 6, 50 - ph2 * 40); ctx.lineTo(x + 14, 42 - ph2 * 40); ctx.stroke()
      }
    }
  }
  ctx.fillStyle = '#284a50'; ctx.fillRect(79.5, 4, 1, 56)
}
function drawRoughness(ctx, t, q, e) {
  // two scrolling terrain profiles; amplitude follows the median slope
  ctx.fillStyle = '#07161a'; ctx.fillRect(0, 0, 160, 64)
  for (const [v, col, x0] of [[q, '#9db7ff', 0], [e, '#ececec', 80]]) {
    const amp = v == null ? 0 : Math.min(22, 2 + v * 3.2)
    ctx.beginPath(); ctx.moveTo(x0 + 2, 62)
    for (let x = 0; x <= 76; x += 1) {
      const u = x * 0.11 + t * 0.6
      const y = 40 - amp * (0.55 * Math.sin(u) + 0.3 * Math.sin(u * 2.7 + 1.3) + 0.15 * Math.sin(u * 6.1 + 0.4))
      ctx.lineTo(x0 + 2 + x, y)
    }
    ctx.lineTo(x0 + 78, 62); ctx.closePath()
    ctx.fillStyle = col; ctx.globalAlpha = v == null ? 0.2 : 0.75; ctx.fill(); ctx.globalAlpha = 1
  }
  ctx.fillStyle = '#284a50'; ctx.fillRect(79.5, 4, 1, 56)
}
function drawThermo(ctx, t, q, e) {
  // two thermometers, 100-350 K, with a faint heat shimmer above warm ones
  ctx.fillStyle = '#07161a'; ctx.fillRect(0, 0, 160, 64)
  for (const [v, col, x0] of [[q, '#9db7ff', 0], [e, '#ececec', 80]]) {
    const f = v == null ? 0 : Math.min(1, Math.max(0, (v - 100) / 250))
    const cx = x0 + 40
    ctx.fillStyle = '#1d3a40'; ctx.fillRect(cx - 4, 6, 8, 48); ctx.beginPath(); ctx.arc(cx, 56, 6, 0, 7); ctx.fill()
    ctx.fillStyle = col; const h = 44 * f * (0.98 + 0.02 * Math.sin(t * 3))
    ctx.fillRect(cx - 2, 52 - h, 4, h); ctx.beginPath(); ctx.arc(cx, 56, 4.4, 0, 7); ctx.fill()
    if (f > 0.55) for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = `rgba(255,190,140,${0.25 * (f - 0.5)})`; ctx.beginPath()
      for (let y = 0; y < 20; y++) ctx.lineTo(cx + 12 + k * 6 + 2 * Math.sin(y * 0.6 + t * 3 + k), 26 - y)
      ctx.stroke()
    }
  }
  ctx.fillStyle = '#284a50'; ctx.fillRect(79.5, 4, 1, 56)
}
const SCENE = { feo: drawSpectrum, tio2: drawSpectrum, k: drawSpectrum, th: drawSpectrum, albedo: drawAlbedo, roughness: drawRoughness, t_day: drawThermo, t_night: drawThermo }

function TokenScene({ tok }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current, ctx = cv?.getContext('2d')
    if (!ctx) return
    const draw = SCENE[tok.id]
    const fit = () => { const dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.round((cv.clientWidth || 160) * dpr); cv.height = Math.round((cv.clientHeight || 64) * dpr) }
    fit()
    const paint = t => { ctx.setTransform(cv.width / 160, 0, 0, cv.height / 64, 0, 0); draw(ctx, t, tok.query_value, tok.earth_value, tok) }
    if (reduced()) { paint(1.2); return }
    let raf = 0, visible = true, t0 = performance.now()
    const frame = now => { paint((now - t0) / 1000); if (visible) raf = requestAnimationFrame(frame) }
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => { visible = e.isIntersecting; cancelAnimationFrame(raf); if (visible) raf = requestAnimationFrame(frame) })
    if (io) io.observe(cv); else raf = requestAnimationFrame(frame)
    window.addEventListener('resize', fit)
    return () => { cancelAnimationFrame(raf); io?.disconnect(); window.removeEventListener('resize', fit) }
  }, [tok.id, tok.query_value, tok.earth_value])
  return <canvas ref={ref} className="pm-scene" aria-hidden="true" />
}

function ToleranceGauge({ tok }) {
  const [ref, shown] = useInView()
  const q = tok.query_value, e = tok.earth_value, tau = tok.tolerance
  const iv = tok.earth_interval90
  const vals = [q - 2 * tau, q + 2 * tau, e, ...(iv || [])].filter(Number.isFinite)
  const lo = tok.unit === '°C' ? Math.min(...vals) : Math.max(0, Math.min(...vals)), hi = Math.max(...vals), span = hi - lo || 1   // non-negative except °C
  const x = v => Math.min(100, Math.max(0, 100 * (v - lo) / span))
  const unit = tok.unit === '1' ? '' : tok.unit === 'deg' ? '°' : ` ${tok.unit}`
  return <div ref={ref} className="pm-gauge">
    <div className="pm-gauge-track">
      <span className="pm-band" style={{ left: `${x(q - tau)}%`, width: `${x(q + tau) - x(q - tau)}%` }} />
      {iv && <span className="pm-interval" style={{ left: `${x(iv[0])}%`, width: `${Math.max(0.5, x(iv[1]) - x(iv[0]))}%`, opacity: shown ? 1 : 0 }} />}
      <i className="pm-mark is-query" style={{ left: `${x(q)}%` }} />
      {Number.isFinite(e) && <i className={`pm-mark is-earth ${tok.earth_source === 'estimated' ? 'is-est' : ''}`} style={{ left: `${shown ? x(e) : x(q)}%` }} />}
    </div>
    <div className="pm-gauge-scale"><span>{fmt(lo, DIGITS[tok.id])}</span><span>±{fmt(tau, DIGITS[tok.id])}{unit}</span><span>{fmt(hi, DIGITS[tok.id])}</span></div>
  </div>
}

// What each property actually is on the query side, where the short label would mislead. The lunar "albedo" is the
// LROC WAC 643 nm Hapke-normalised reflectance (I/F at 60° incidence), not normal albedo (mare about 0.07–0.10); the
// Earth value is GLASS broadband snow-free albedo. Roughness is the median absolute slope at about 1.9 km baselines.
const LABEL_NOTE = {
  albedo: { moon: [['反射率（WAC 643 nm）', 'Reflectance (WAC 643 nm)'], ['月球：LROC WAC 643 nm Hapke 正規化反射率（入射角 60° 的 I/F），不是正規反照率；地球：GLASS 寬波段無雪反照率。兩者量的不是同一物理量。', 'Moon: LROC WAC 643 nm Hapke-normalised reflectance (I/F at 60° incidence), not normal albedo; Earth: GLASS broadband snow-free albedo. The two are not the same quantity.']],
    mars: [null, ['火星：TES 熱輻射光譜儀反照率；地球：GLASS 寬波段無雪反照率。', 'Mars: TES bolometric albedo; Earth: GLASS broadband snow-free albedo.']] },
  roughness: { any: [['粗糙度（坡度中位數）', 'Roughness (median slope)'], ['約 1.9 km 基線的坡度絕對值中位數（度），與結果卡片上的「起伏 P90（公尺）」不是同一個量。', 'Median absolute slope (degrees) over about 1.9 km baselines; not the relief P90 in metres shown on the result cards.']] },
}
// Temperatures come in kelvin; show °C like the rest of the site (the tolerance is a difference, same number).
const asCelsius = tok => {
  if (tok.unit !== 'K') return tok
  const c = v => (Number.isFinite(v) ? v - 273.15 : v)
  return { ...tok, unit: '°C', query_value: c(tok.query_value), earth_value: c(tok.earth_value), earth_interval90: tok.earth_interval90?.map(c), kelvin: tok }
}
function TokenTile({ tok: raw, body }) {
  const tok = asCelsius(raw)
  const [cls, mark, word] = VERDICT[tok.verdict] || VERDICT.unknown
  const note = LABEL_NOTE[tok.id]?.[body] || LABEL_NOTE[tok.id]?.any
  const noEarth = !Number.isFinite(tok.earth_value)
  const u = tok.unit === '1' ? '' : tok.unit === 'deg' ? '°' : ` ${tok.unit}`
  const d = DIGITS[tok.id]
  return <article className={`pm-tile ${cls}`}>
    <header><h4>{note?.[0] ? tr(...note[0]) : pick(tok.label)}</h4><span className="pm-verdict"><span aria-hidden="true">{mark}</span> {tr(...word)}</span></header>
    <TokenScene tok={raw} />
    <ToleranceGauge tok={tok} />
    <dl className="pm-values">
      <div><dt>{tr('查詢地', 'Query')}</dt><dd title={tok.kelvin ? `${fmt(raw.query_value, 0)} K` : undefined}>{fmt(tok.query_value, d)}{u}</dd></div>
      <div><dt>{tr('地球', 'Earth')}</dt><dd>{Number.isFinite(tok.earth_value) ? `${fmt(tok.earth_value, d)}${u}` : '—'}
        <small>{tr(...SOURCE[tok.earth_source])}{tok.earth_interval90 ? ` ${fmt(tok.earth_interval90[0], d)}–${fmt(tok.earth_interval90[1], d)}` : ''}</small></dd></div>
      <div><dt>{tr('相符機率', 'P(match)')}</dt><dd>{tok.scored ? `${fmt(tok.p_match * 100, 0)}%` : '—'}</dd></div>
    </dl>
    {Number.isFinite(tok.earth_measured) && <p className="pm-share">{noEarth
      ? tr(`這個候選沒有地球實測值；全球有實測的 ${fmt(tok.earth_measured, 0)} 個窗格中，${fmt(tok.earth_within, 0)} 個在容差內。`, `No Earth measurement at this candidate. Of the ${fmt(tok.earth_measured, 0)} Earth windows that have one, ${fmt(tok.earth_within, 0)} are within tolerance.`)
      : tr(`全球 ${fmt(tok.earth_measured, 0)} 個實測窗格中，${fmt(tok.earth_within, 0)} 個在容差內`, `Across Earth, ${fmt(tok.earth_within, 0)} of ${fmt(tok.earth_measured, 0)} windows with a measurement are within tolerance`)}</p>}
    {note && <p className="pm-share">{tr(...note[1])}</p>}
  </article>
}

export function PhysicalMatchPanel({ data, active }) {
  useLanguage()
  const summary = data?.physical_match, pm = active?.physical_match
  if (!summary || !pm?.available) return null
  const uses = Object.keys(summary.ceilings?.uses || {}).filter(u => pm.uses?.[u])
  const NAMES = { feo: 'FeO', tio2: 'TiO₂', k: 'K', th: 'Th' }
  const scoredList = Object.entries(summary.estimates_in_scoring || {}).filter(([, v]) => v).map(([k]) => NAMES[k] || k).join(getLanguage() === 'en' ? ', ' : '、')
  const scoredEst = scoredList.length > 0
  return <section className="pm-panel" id="physical-match-panel" aria-labelledby="physical-match-title">
    <header className="pm-head">
      <h2 id="physical-match-title">{tr('物理相符：同單位性質逐項比較', 'Physical match: same-unit properties')}</h2>
      <p>{data.purpose === 'physical'
        ? tr('此用途依下方性質的相符機率排序；地形只用來排同分的候選。', 'This purpose ranks by the match probabilities below; terrain only breaks ties.')
        : tr('此用途不以這些性質排序；改用「物理相符」可直接依性質排序。', 'This purpose does not rank by these properties; the physical-match purpose does.')}</p>
    </header>
    {uses.length > 0 && <div className="pm-uses">
      {uses.map(u => <UseRing key={u} use={u} score={pm.uses[u].score} ceiling={summary.ceilings.uses[u].C_meas} props={summary.ceilings.uses[u].properties} />)}
    </div>}
    <div className="pm-grid">
      {pm.tokens.map(t => <TokenTile key={t.id} tok={t} body={data.window?.body === 'mars' ? 'mars' : 'moon'} />)}
    </div>
  </section>
}
