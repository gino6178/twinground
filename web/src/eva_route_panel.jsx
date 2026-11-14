import React, { useEffect, useState } from 'react'

// B2 route planner and B1 two-site comparison: one route in window coordinates, measured on the Moon or Mars selection
// and on the Earth candidate at once (same positions in both windows), with the estimates from eva_route.js.
// B6 (phase 3): the first legs can be driven by the rover (terramechanics.js), the rest walked.
const dist = v => v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${Math.round(v)} m`
const duration = s => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`
const pct = v => `${Math.round(v * 100)}%`
const SIM = { meanGradeDeg: ['平均坡度', 'Mean slope', v => `${v.toFixed(1)}°`], p90GradeDeg: ['陡坡（P90）', 'Steep parts (P90)', v => `${v.toFixed(1)}°`],
  ascentPerKm: ['每公里爬升', 'Climb per km', v => `${Math.round(v)} m`], share15: ['坡度 >15° 比例', 'Share >15°', v => pct(v)], sdGradeDeg: ['坡度起伏', 'Slope variation', v => `${v.toFixed(1)}°`] }

function Profile({ a, b, tr, colorA }) {
  const W = 340, H = 92, pad = 4
  const all = [...(a?.profile || []), ...(b?.profile || [])]
  if (all.length < 2) return null
  const maxD = Math.max(...all.map(p => p[0])) || 1, ys = all.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(1, hi - lo)
  const line = m => m.profile.map(([d, h]) => `${(pad + d / maxD * (W - 2 * pad)).toFixed(1)},${(H - pad - (h - lo) / span * (H - 2 * pad)).toFixed(1)}`).join(' ')
  return <figure className="eva-route-profile">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('沿路線的相對高程剖面', 'Relative elevation along the route')}>
      <line x1={pad} x2={W - pad} y1={H - pad - (0 - lo) / span * (H - 2 * pad)} y2={H - pad - (0 - lo) / span * (H - 2 * pad)} stroke="#ffffff26" strokeDasharray="3 3" />
      {a?.profile && <polyline points={line(a)} fill="none" stroke={colorA} strokeWidth="2" />}
      {b?.profile && <polyline points={line(b)} fill="none" stroke="#ececec" strokeWidth="2" />}
    </svg>
    <figcaption>{tr('步行段相對起點的高程', 'Walking leg, elevation relative to its start')} · {Math.round(lo)} … +{Math.round(hi)} m</figcaption>
  </figure>
}

export default function RoutePanel({ engine, stats, target, tr, points, setPoints, load, setLoad, onClose }) {
  const [report, setReport] = useState(null)
  const [driveUntil, setDriveUntil] = useState(0)
  const hourKey = Math.round((stats?.time?.hour || 0) * 2)
  const k = Math.min(driveUntil, Math.max(0, points.length - 1))
  useEffect(() => { engine.current?.setRoute(points) }, [engine, points])
  useEffect(() => { engine.current?.setLoad(load) }, [engine, load])
  useEffect(() => { engine.current?.setDriveUntil?.(k) }, [engine, k])
  useEffect(() => { setReport(engine.current?.getRouteReport() || null) }, [engine, points, load, k, stats?.world, hourKey])
  const following = !!stats?.route?.follow
  const mars = target.body === 'mars'
  const tName = tr(mars ? '火星選區' : '月球選區', mars ? 'Mars selection' : 'Moon selection')
  const colorA = mars ? '#f4a37f' : '#c9d1d9'
  const a = report?.target, b = report?.earth, c = report?.compare
  const walkRows = [
    [tr('水平距離', 'Distance'), m => dist(m.length)],
    [tr('爬升／下降', 'Climb / descent'), m => `${Math.round(m.ascent)} / ${Math.round(m.descent)} m`],
    [tr('最陡處', 'Steepest'), m => `${m.maxGradeDeg.toFixed(1)}°`],
    [tr('坡度 >15° 的路段', 'Steeper than 15°'), m => pct(m.share15)],
    [tr('預估時間', 'Time'), m => duration(m.time)],
    [tr('體力消耗', 'Energy'), m => `${Math.round(m.energy / 4184)} kcal · ${Math.round(m.avgPower)} W`],
    [tr('O₂ 用量', 'O₂ used'), m => `${m.o2.toFixed(1)}%`],
    [tr('最小返回餘裕', 'Lowest walk-back margin'), m => m.walkbackMargin == null ? '—' : `${m.walkbackMargin.toFixed(0)}%`],
    [tr('日照路段（此刻）', 'In sunlight (now)'), m => m.sunLit == null ? '—' : pct(m.sunLit)],
  ]
  const driveRows = [
    [tr('車程', 'Drive'), d => `${dist(d.length)} · ${duration(d.time)}`],
    [tr('車用電量', 'Rover energy'), d => `${(d.energyWh / 1000).toFixed(1)} kWh · ${Math.round(d.whPerKm)} Wh/km`],
    [tr('電池用量（60 kWh）', 'Battery used (60 kWh)'), d => `${d.batteryPct.toFixed(1)}%`],
    [tr('最大打滑', 'Peak wheel slip'), d => pct(d.maxSlip)],
    [tr('爬不上去的路段', 'Too steep to drive'), d => d.blocked > 0 ? dist(d.blocked) : tr('無', 'none')],
    [tr('此土壤的爬坡極限', 'Climb limit in this soil'), d => `${d.limitDeg.toFixed(0)}°`],
  ]
  const hasDrive = !!a?.drive, hasWalk = a && !a.driveOnly
  const lowMargin = hasWalk && a.walkbackMargin != null && a.walkbackMargin < 10
  return <section className="eva-route" aria-label={tr('出艙路線規劃', 'EVA route planner')}>
    <header><strong>{tr('出艙路線規劃', 'EVA route planner')}</strong><button type="button" onClick={onClose} aria-label={tr('關閉', 'Close')}>✕</button></header>
    <p className="eva-route-hint">{points.length < 2
      ? tr('在右下小地圖上依序點選路線點，或走到某處再按「加入目前位置」。兩個場址用同一條路線（相同的窗格內位置）。', 'Click route points on the minimap, or walk somewhere and press “Add my position”. Both sites use the same route (same positions in the window).')
      : tr(`${points.length} 個路線點 · 同一條路線在兩地同時計算`, `${points.length} route points · measured on both sites at once`)}</p>
    <div className="eva-route-buttons">
      <button type="button" onClick={() => { const p = engine.current?.playerXZ(); if (p) setPoints(v => v.length >= 40 ? v : [...v, p]) }}>{tr('加入目前位置', 'Add my position')}</button>
      <button type="button" disabled={!points.length} onClick={() => setPoints(v => v.slice(0, -1))}>{tr('復原', 'Undo')}</button>
      <button type="button" disabled={!points.length} onClick={() => setPoints([])}>{tr('清除', 'Clear')}</button>
      <button type="button" className="is-primary" disabled={points.length < 2 || stats?.driving} aria-pressed={following}
        onClick={() => engine.current?.followRoute(!following)}>{following ? tr('停止行走', 'Stop walking') : tr('沿路線行走', 'Walk the route')}</button>
    </div>
    <label className="eva-route-load">{tr('負重', 'Load carried')}
      <select value={load} onChange={e => setLoad(Number(e.target.value))}>
        {[0, 30, 60].map(v => <option key={v} value={v}>{v} kg</option>)}
      </select></label>
    {points.length >= 2 && <label className="eva-route-load">{tr('交通方式', 'Getting there')}
      <select value={k} onChange={e => setDriveUntil(Number(e.target.value))}>
        <option value={0}>{tr('全程步行', 'Walk all the way')}</option>
        {points.slice(1, -1).map((_, i) => <option key={i + 1} value={i + 1}>{tr(`開車到第 ${i + 2} 點，再步行`, `Drive to point ${i + 2}, then walk`)}</option>)}
        <option value={points.length - 1}>{tr('全程開車', 'Drive all the way')}</option>
      </select></label>}
    {a && b && <>
      <table className="eva-compare eva-route-table">
        <thead><tr><th scope="col" /><th scope="col">{tName}</th><th scope="col">{tr('地球候選', 'Earth candidate')}</th></tr></thead>
        <tbody>
          {hasDrive && <tr className="eva-route-group"><th scope="rowgroup" colSpan={3}>{tr('探測車段（估算）', 'Rover leg (estimate)')}</th></tr>}
          {hasDrive && driveRows.map(([label, get]) => <tr key={label}><th scope="row">{label}</th><td>{get(a.drive)}</td><td>{b.drive ? get(b.drive) : '—'}</td></tr>)}
          {hasDrive && hasWalk && <tr className="eva-route-group"><th scope="rowgroup" colSpan={3}>{tr('步行段', 'Walking leg')}</th></tr>}
          {hasWalk && walkRows.map(([label, get]) => <tr key={label}><th scope="row">{label}</th><td>{get(a)}</td><td>{b.driveOnly ? '—' : get(b)}</td></tr>)}
          {hasDrive && <tr><th scope="row">{tr('車故障時走回起點的 O₂ 餘裕', 'O₂ margin if the rover fails at the end')}</th><td>{a.failMargin.toFixed(0)}%</td><td>{b.failMargin != null ? `${b.failMargin.toFixed(0)}%` : '—'}</td></tr>}
        </tbody>
      </table>
      {hasDrive && a.failMargin < 10 && <p className="eva-route-warn">{tr(`在${tName}，探測車若在終點故障，剩餘 O₂ 不夠走回起點。這是車程上限的主要依據（步行返回限制）。`, `On the ${tName}, if the rover fails at the far end the O₂ left does not cover the walk back; this walk-back limit is what caps how far the rover may go.`)}</p>}
      {lowMargin && <p className="eva-route-warn">{tr(`返回餘裕低於 10%：在${tName}走到最遠處時，剩餘的 O₂ 可能不夠直接走回起點。`, `Walk-back margin below 10%: at the far end of the route on the ${tName}, the O₂ left may not be enough to walk straight back.`)}</p>}
      {hasWalk && <Profile a={a} b={b.driveOnly ? null : b} tr={tr} colorA={colorA} />}
      <p className="eva-route-legend"><i style={{ background: colorA }} />{tName} <i style={{ background: '#ececec' }} />{tr('地球候選', 'Earth candidate')}</p>
      {c && <div className="eva-route-score">
        <div><b>{c.score}</b><span>{tr('地形相似度（滿分 100，估算）', 'Terrain similarity (out of 100, estimate)')}</span></div>
        <ul>{c.items.map(it => <li key={it.key}><span className={`eva-chip ${it.sim > 0.7 ? 'ok' : it.sim > 0.4 ? 'mid' : 'bad'}`}>{tr(SIM[it.key][0], SIM[it.key][1])}</span> {SIM[it.key][2](it.a)} · {SIM[it.key][2](it.b)}</li>)}</ul>
        {c.effortRatio && <p>{tr(`在地球候選走同一條路線，體力消耗約為${tName}的 ${c.effortRatio.toFixed(1)} 倍，時間 ${c.timeRatio.toFixed(1)} 倍；差異主要來自重力，地球上無法重現。`, `Walking the same route at the Earth candidate costs about ${c.effortRatio.toFixed(1)}× the energy and ${c.timeRatio.toFixed(1)}× the time of the ${tName}; the gap comes mostly from gravity, which Earth cannot reproduce.`)}</p>}
      </div>}
    </>}
    <small>{tr('估算方法：步速用 Tobler（1993）步行函數，並依各天體的步行速度縮放（月球 0.9、火星 1.1、地球 1.4 m/s）；體力用 Pandolf 等（1977）負重公式，負重與上坡項依重力比例縮小，平地步行項依 Farley 與 McMahon（1992）在 0.25 g 只降約三分之一；下坡不計節省。O₂ 以「300 W 連續 8 小時＝100%」為設計假設。探測車段用 Bekker 壓陷與 Mohr–Coulomb 牽引估算下陷、滾動阻力與打滑（車重 3 噸、12 輪、巡航 2.5 m/s、電池 60 kWh 為設計假設；地球候選用一般砂質壤土參數），乘坐時太空衣以 150 W 計。地形相似度只比較步行段的坡度與起伏，不含重力、溫度或材質。僅供篩選與教學，不是任務規劃工具。',
      'Method: pace from Tobler’s hiking function (1993), scaled by each body’s walking speed (Moon 0.9, Mars 1.1, Earth 1.4 m/s); energy from the Pandolf et al. (1977) load-carriage equation, with the load and uphill terms scaled by gravity and the level-walking term reduced by only about a third at 0.25 g (Farley & McMahon 1992); no downhill savings. O₂: 300 W for 8 hours = 100% (design assumption). The rover leg uses Bekker pressure–sinkage and Mohr–Coulomb traction for sinkage, rolling resistance and slip (3 t, 12 wheels, 2.5 m/s cruise and a 60 kWh battery are design assumptions; the Earth candidate uses a generic sandy loam); the seated suit is counted at 150 W. Terrain similarity compares only the walking leg’s slope and relief, not gravity, temperature or materials. For screening and teaching, not a mission planning tool.')}</small>
  </section>
}
