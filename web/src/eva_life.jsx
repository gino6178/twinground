// Explorer phase 2 readouts (2026-10-20): suit consumables (B3), radio and Earth line of sight (B5), and daylight and
// surface temperature over a full day (B4). Every number is a model estimate and is labelled as one.
import React, { useEffect, useState } from 'react'

const num = (v, d = 0) => Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'
export const duration = (s, tr) => !Number.isFinite(s) ? '—' : s >= 48 * 3600 ? `${num(s / 86400, 1)} ${tr('天', 'd')}` : s >= 3600 ? `${num(s / 3600, 1)} h` : `${Math.max(1, Math.round(s / 60))} min`
const distance = d => d < 1000 ? `${num(d)} m` : `${num(d / 1000, 1)} km`
// The base is the NASA model placed beside the start for scale (engine PROPS), not a real landing site, so Mars says
// "the base" rather than naming Perseverance (it would read as Jezero even at Gale).
const BASE = { moon: ['登月艙', 'the lander'], mars: ['基地', 'the base'], earth: ['棲地模組', 'the habitat'] }
const BODY = { moon: ['月球', 'Moon'], mars: ['火星', 'Mars'], earth: ['地球', 'Earth'] }

export function LifeSupport({ stats, tr, clock }) {
  const life = stats.life
  const items = [['o2', 'O₂'], ['water', tr('冷卻水', 'Water')], ['battery', tr('電池', 'Battery')]]
  const base = BASE[stats.body] || BASE.moon, limited = Number.isFinite(life.remaining), limitName = items.find(i => i[0] === life.limit)?.[1]
  return <>
    <ul className="eva-life">{items.map(([k, n]) => <li key={k} className={limited && life.limit === k ? 'is-limit' : ''}>
      <span>{n}</span><div className="eva-bar"><i style={{ width: `${Math.max(0, Math.min(100, life[k]))}%` }} /></div><b>{num(life[k], k === 'o2' ? 1 : 0)}%</b></li>)}</ul>
    <small>{tr('剩餘', 'Left')} {duration(life.remaining, tr)}{limited ? tr(`（${limitName}先用完）`, ` (${limitName} first)`) : ''} · EVA {clock(stats.elapsed)}</small>
    <small>{tr('熱負荷', 'Heat')} {num(life.heatW)} W{life.heaterW > 1 ? tr(` · 加熱 ${num(life.heaterW)} W`, ` · heater ${num(life.heaterW)} W`) : ''} · {tr('外層', 'outer')} {num(life.outerC)}°C</small>
    {life.back && <small>{tr(`走回${base[0]}`, `Back to ${base[1]}`)} {distance(life.back.dist)} · {duration(life.back.time, tr)} · O₂ {num(life.back.o2, 1)}%</small>}
    {life.warn && <p className="eva-life-warn" role="alert">{tr(`剩餘資源可能不夠走回${base[0]}，請返回`, `Consumables may not cover the walk back to ${base[1]}; head back`)}</p>}
  </>
}

export function CommLine({ stats, tr }) {
  const c = stats.comm
  if (!c) return null
  const base = BASE[stats.body] || BASE.moon, e = c.earth
  const earthText = !e ? null : e.elevation <= 0 ? tr('地球在地平線下', 'Earth below the horizon')
    : e.visible ? tr(`地球可見 · 仰角 ${num(e.elevation)}°`, `Earth in view · ${num(e.elevation)}° up`)
      : tr(`地球被地形擋住 · 仰角 ${num(e.elevation)}°，山脊 ${num(e.horizon)}°`, `Earth behind terrain · ${num(e.elevation)}° vs ridge ${num(e.horizon)}°`)
  return <p className="eva-comm">
    <span className={c.base.los ? 'ok' : 'bad'}>{tr(`${base[0]}無線電`, `Radio to ${base[1]}`)} {c.base.los ? tr('直視', 'clear') : tr('被擋，需中繼', 'blocked, relay needed')} · {distance(c.base.dist)}</span>
    {c.rover && <span className={c.rover.los ? 'ok' : 'bad'}>{tr('探測車', 'Rover')} {c.rover.los ? tr('直視', 'clear') : tr('被擋', 'blocked')} · {distance(c.rover.dist)}</span>}
    {earthText && <span className={e.visible ? 'ok' : 'bad'}>{earthText}{e.visible && e.elevation - e.horizon < 7 ? tr('（天平動 ±7° 可能短暫遮住）', ' (±7° libration may hide it at times)') : ''}</span>}
  </p>
}

export function DaySection({ engine, stats, target, tr }) {
  const [day, setDay] = useState(null)
  useEffect(() => {
    const run = () => { try { setDay(engine.current?.dayProfiles() || null) } catch { setDay(null) } }
    run()
    const id = setInterval(run, 3000)
    return () => clearInterval(id)
  }, [engine])
  if (!day?.target) return null
  const tName = tr(BODY[target.body][0], BODY[target.body][1])
  const series = [['target', day.target, '#ececec', tName], ['earth', day.earth, '#f3c27a', tr('地球候選', 'Earth candidate')]].filter(s => s[1])
  const all = series.flatMap(s => s[1].temp), lo = Math.floor(Math.min(...all) / 25) * 25, hi = Math.ceil(Math.max(...all) / 25) * 25
  const W = 360, H = 150, L = 34, R = 8, T = 8, B = 44
  const x = h => L + h / 24 * (W - L - R), y = v => T + (hi - v) / Math.max(1, hi - lo) * (H - T - B)
  const cell = x(0.25) - x(0) + 0.3, now = (day.here === 'earth' ? day.earth : day.target)?.nowHour
  const speed = stats.time.speed, lapse = speed >= 2
  const dayLen = p => p.body === 'moon' ? tr(`${num(p.dayHours / 24, 1)} 地球日`, `${num(p.dayHours / 24, 1)} Earth days`) : `${num(p.dayHours, 1)} h`
  const ticks = [lo, lo < 0 && hi > 0 ? 0 : null, hi].filter(v => v !== null)
  return <section className="eva-day" aria-label={tr('一整天的日照與溫度', 'Daylight and temperature over a full day')}>
    <h3>{tr('一整天的日照與溫度', 'Daylight and temperature over a full day')}</h3>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('地表溫度曲線與日照時段', 'Surface temperature curve and sunlit hours')}>
      {ticks.map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#ffffff1c" /><text x={L - 4} y={y(v) + 3} textAnchor="end">{v}°</text></g>)}
      {[0, 6, 12, 18, 24].map(h => <text key={h} x={x(h)} y={H - 2} textAnchor="middle">{h}</text>)}
      {series.map(([k, p, c], j) => <g key={k}>
        <polyline points={p.hours.map((h, i) => `${x(h).toFixed(1)},${y(p.temp[i]).toFixed(1)}`).join(' ')} fill="none" stroke={c} strokeWidth="1.8" strokeDasharray={k === 'earth' ? '5 3' : undefined} />
        <rect x={L} y={H - B + 8 + j * 11} width={W - L - R} height="7" rx="2" fill="#ffffff10" />
        {p.lit.slice(0, -1).map((on, i) => on ? <rect key={i} x={x(p.hours[i])} y={H - B + 8 + j * 11} width={cell} height="7" fill={c} opacity="0.75" /> : null)}
      </g>)}
      {Number.isFinite(now) && <line x1={x(now)} x2={x(now)} y1={T} y2={H - 14} stroke="#ffffff" strokeWidth="1" strokeDasharray="2 3" />}
    </svg>
    <p className="eva-day-legend">{series.map(([k, , c, n]) => <span key={k}><i style={{ background: c }} />{n}</span>)}<span>{tr('橫軸：當地時 0–24；下方色帶＝直接日照', 'Axis: local time 0–24; bands = direct sunlight')}</span></p>
    <ul className="eva-day-sum">{series.map(([k, p, c, n]) => <li key={k}><b style={{ color: c }}>{n}</b>
      {tr('日照', 'Sunlit')} {num(p.litShare * 100)}%{p.sunUpShare - p.litShare > 0.015 ? tr(`（地形遮去 ${num((p.sunUpShare - p.litShare) * 100)}%）`, ` (terrain hides ${num((p.sunUpShare - p.litShare) * 100)}%)`) : ''}
      {' · '}{tr('最長黑暗', 'Longest dark')} {duration(p.longestDarkHours * 3600, tr)} · {num(p.tMin)}{tr('～', '–')}{num(p.tMax)} °C · {tr('一天', 'One day')} {dayLen(p)}</li>)}</ul>
    <button type="button" className="eva-day-lapse" aria-pressed={lapse} onClick={() => engine.current?.setTime({ speed: lapse ? 0 : 2 })}>{lapse ? tr('停止縮時', 'Stop time-lapse') : tr('縮時播放一整天（2 小時／秒）', 'Time-lapse a full day (2 h / s)')}</button>
    <small>{tr('依太陽軌跡與 DEM 地平線每 15 分鐘（當地時）估算，地點為太空人所在處，地球候選取同一相對位置；溫度為模型推估。',
      'Estimated every 15 minutes of local time from the sun’s path and the DEM horizon at the astronaut’s spot (the same relative spot on the Earth candidate); temperatures are model estimates.')}</small>
  </section>
}
