// Explorer phase 3 (2026-10-20): B7 field-science mission (stations, seismometer, crater-wall photo; scored by time,
// distance and energy on each site), B8 base-site check and habitat placement, and in-situ resource estimates.
// Every number is a model estimate; thresholds are illustrative screening values.
import React, { useState } from 'react'
import { EN } from './i18n/catalog.js'

const num = (v, d = 0) => Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const dist = v => !Number.isFinite(v) ? '—' : v >= 1000 ? `${num(v / 1000, 2)} km` : `${num(v)} m`
const minutes = s => !Number.isFinite(s) ? '—' : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`
const MINERAL = { Clinopyroxene: ['單斜輝石', 'clinopyroxene'], Orthopyroxene: ['斜方輝石', 'orthopyroxene'], Olivine: ['橄欖石', 'olivine'], Plagioclase: ['斜長石', 'plagioclase'] }
const KIND = { flat: ['平地', 'level ground'], slope: ['坡面', 'slope'], hollow: ['窪地／坑底', 'hollow or crater floor'], other: ['其他', 'other'] }
const BASE = { moon: ['登月艙', 'the lander'], mars: ['基地', 'the base'], earth: ['棲地模組', 'the habitat'] }
// Regional lithology arrives as the Chinese GLiM class name; English mode shows the catalogue's translation.
const lithologyName = (v, tr) => (v ? tr(v, EN[v] || v) : v)
const O2_PER_PERSON_DAY = 0.84   // kg, a common life-support planning value

function mineralAt(minerals, u, v) {
  const g = minerals?.grid
  if (!g?.length) return null
  // the grid's first row is the window's north edge, like the minimap
  const idx = g[Math.round(clamp(v, 0, 1) * (g.length - 1))]?.[Math.round(clamp(u, 0, 1) * (g[0].length - 1))]
  return idx >= 0 ? minerals.order[idx] : null
}

export function emptyMission() { return { start: null, samples: [], seis: null, photo: null, done: null } }

function Mission({ engine, stats, target, earth, tr, mission, setMission }) {
  const key = stats.world, m = mission[key] || emptyMission(), base = BASE[stats.body] || BASE.moon
  const [note, setNote] = useState('')
  const update = patch => setMission(all => {
    const cur = { ...(all[key] || emptyMission()), ...patch }
    const kinds = new Set(cur.samples.map(s => s.kind))
    if (!cur.done && cur.start && ['flat', 'slope', 'hollow'].every(k => kinds.has(k)) && cur.seis && cur.photo) cur.done = engine.current?.missionMark() || null
    return { ...all, [key]: cur }
  })
  const kinds = new Set(m.samples.map(s => s.kind))
  const sample = () => {
    const st = engine.current?.stationHere()
    if (!st) return
    const mineral = st.body === 'moon' ? mineralAt(target.minerals, st.u, st.v) : null
    const entry = { ...st, mineral, lithology: st.body === 'earth' ? earth.lithology || null : null }
    update({ samples: [...m.samples, entry].slice(-12) })
    setNote(st.kind === 'other' ? tr(`這裡坡度 ${num(st.slope, 1)}°，不屬於三種採樣站；換個地方再試。`, `Slope here is ${num(st.slope, 1)}°, not one of the three station types; try elsewhere.`)
      : tr(`已記錄：${KIND[st.kind][0]}（坡度 ${num(st.slope, 1)}°）`, `Logged: ${KIND[st.kind][1]} (slope ${num(st.slope, 1)}°)`))
  }
  const seismometer = () => {
    const r = engine.current?.deploySeismometer()
    if (!r) return
    if (r.ok) { update({ seis: r }); setNote(tr(`地震儀已放置，距${base[0]} ${dist(r.dist)}，地面坡度 ${num(r.slope, 1)}°。`, `Seismometer deployed ${dist(r.dist)} from ${base[1]} on a ${num(r.slope, 1)}° surface.`)) }
    else setNote(r.reason === 'near' ? tr(`離${base[0]}只有 ${dist(r.dist)}，需要 50 m 以上，避免設備振動干擾。`, `Only ${dist(r.dist)} from ${base[1]}; it needs at least 50 m to stay clear of equipment vibration.`)
      : tr(`地面坡度 ${num(r.slope, 1)}°，太斜無法調平（需 ≤ 8°）。`, `Ground slope ${num(r.slope, 1)}° is too steep to level (needs ≤ 8°).`))
  }
  const photo = () => {
    const r = engine.current?.photoWall()
    if (!r) return
    if (r.ok) { update({ photo: r }); setNote(tr(`拍到 ${dist(r.dist)} 外的陡壁：坡度 ${num(r.slope)}°、高差 ${num(r.relief, 1)} m。`, `Captured a wall ${dist(r.dist)} ahead: ${num(r.slope)}° and ${num(r.relief, 1)} m high.`)) }
    else setNote(tr(`畫面前方最陡只有 ${num(r.slope)}°（需 ≥ 20°、高差 ≥ 1 m）；轉向坑壁或陡坡再拍。`, `The steepest ground ahead is only ${num(r.slope)}° (needs ≥ 20° and ≥ 1 m of relief); face a crater wall or scarp and try again.`))
  }
  const score = s => s?.start && s?.done ? { t: s.done.t - s.start.t, d: s.done.dist - s.start.dist, kcal: (s.done.energyJ - s.start.energyJ) / 4184 } : null
  const a = score(mission.target), b = score(mission.earth)
  const tName = tr(target.body === 'mars' ? '火星選區' : '月球選區', target.body === 'mars' ? 'Mars selection' : 'Moon selection')
  return <div className="eva-mission-body">
    <p className="eva-route-hint">{tr('仿類比任務的野外科學工作：在目前的場址完成三件事。兩個場址各做一次，就能比較所需時間、走過的距離與體力。',
      'A field-science task set like analogue missions run: finish three tasks at this site. Do it at both sites to compare time, distance and energy.')}</p>
    {!m.start ? <div className="eva-route-buttons"><button type="button" className="is-primary" onClick={() => { update({ ...emptyMission(), start: engine.current?.missionMark() || null }); engine.current?.resetMission(); setNote('') }}>{tr('開始任務', 'Start the mission')}</button></div>
      : <>
        <ol className="eva-mission-tasks">
          <li className={['flat', 'slope', 'hollow'].every(k => kinds.has(k)) ? 'is-done' : ''}>{tr('三種採樣站：平地（<5°）、坡面（≥12°）、窪地或坑底', 'Three sampling stations: level ground (<5°), a slope (≥12°), a hollow or crater floor')}
            <span>{['flat', 'slope', 'hollow'].map(k => <i key={k} className={kinds.has(k) ? 'on' : ''}>{tr(KIND[k][0], KIND[k][1])}</i>)}</span></li>
          <li className={m.seis ? 'is-done' : ''}>{tr(`在距${base[0]} 50 m 以上、坡度 ≤ 8° 處放置地震儀`, `Deploy a seismometer at least 50 m from ${base[1]} on ground ≤ 8°`)}{m.seis ? ` · ${dist(m.seis.dist)}` : ''}</li>
          <li className={m.photo ? 'is-done' : ''}>{tr('拍攝坑壁或陡坡剖面（≥ 20°、高差 ≥ 1 m）', 'Photograph a crater wall or scarp (≥ 20°, ≥ 1 m high)')}</li>
        </ol>
        <div className="eva-route-buttons">
          <button type="button" onClick={sample} disabled={!!m.done}>{tr('在此採樣', 'Sample here')}</button>
          <button type="button" onClick={seismometer} disabled={!!m.done}>{tr('放置地震儀', 'Deploy seismometer')}</button>
          <button type="button" onClick={photo} disabled={!!m.done}>{tr('拍攝前方陡壁', 'Photograph the wall ahead')}</button>
          <button type="button" onClick={() => { update(emptyMission()); engine.current?.resetMission(); setNote('') }}>{tr('重來', 'Restart')}</button>
        </div>
        {note && <p className="eva-mission-note" role="status">{note}</p>}
        {(m.samples.length > 0 || m.photo) && <ul className="eva-mission-log">
          {m.samples.map((s, i) => <li key={i}><b>{tr(`樣本 ${i + 1}`, `Sample ${i + 1}`)}</b> {tr(KIND[s.kind][0], KIND[s.kind][1])} · {num(s.slope, 1)}° · {num(s.elevation)} m
            {s.mineral ? tr(` · 軌道礦物圖此區以${MINERAL[s.mineral]?.[0] || s.mineral}為主`, ` · orbital map: ${MINERAL[s.mineral]?.[1] || s.mineral}-dominated`) : ''}
            {s.lithology ? tr(` · 區域岩性：${s.lithology}`, ` · regional lithology: ${lithologyName(s.lithology, tr)}`) : ''}</li>)}
          {m.photo?.thumb && <li className="eva-mission-photo"><img src={m.photo.thumb} alt={tr('坑壁照片', 'Crater-wall photo')} /><span>{num(m.photo.slope)}° · {num(m.photo.relief, 1)} m</span></li>}
        </ul>}
        {m.done && <p className="eva-mission-done">{tr('任務完成', 'Mission complete')} · {minutes(m.done.t - m.start.t)} · {dist(m.done.dist - m.start.dist)} · {num((m.done.energyJ - m.start.energyJ) / 4184)} kcal</p>}
      </>}
    {(a || b) && <table className="eva-compare eva-route-table">
      <thead><tr><th scope="col" /><th scope="col">{tName}</th><th scope="col">{tr('地球候選', 'Earth candidate')}</th></tr></thead>
      <tbody>
        <tr><th scope="row">{tr('完成時間（模擬）', 'Time (simulated)')}</th><td>{a ? minutes(a.t) : '—'}</td><td>{b ? minutes(b.t) : '—'}</td></tr>
        <tr><th scope="row">{tr('走過距離', 'Distance')}</th><td>{a ? dist(a.d) : '—'}</td><td>{b ? dist(b.d) : '—'}</td></tr>
        <tr><th scope="row">{tr('體力消耗', 'Energy')}</th><td>{a ? `${num(a.kcal)} kcal` : '—'}</td><td>{b ? `${num(b.kcal)} kcal` : '—'}</td></tr>
      </tbody></table>}
    <small>{tr('採樣站依太空人位置的坡度（3 m 基線）與相對 12 m、60 m 圓周的高差分類；礦物為軌道礦物圖在約 2.5 km 格的主要成分，岩性為整個區域的分類，都不是樣本實測。時間用模擬時鐘計算。',
      'Stations are classed by the slope at the astronaut (3 m baseline) and the height relative to 12 m and 60 m rings; the mineral is the main component of the orbital mineral map in its ~2.5 km cell and the lithology is a regional class, neither is a sample measurement. Time uses the simulation clock.')}</small>
  </div>
}

const THRESH = [
  ['meanSlope', ['平均坡度 ≤ 5°', 'Mean slope ≤ 5°'], v => v <= 5, v => `${num(v, 1)}°`],
  ['maxSlope', ['最大坡度 ≤ 10°', 'Steepest ≤ 10°'], v => v <= 10, v => `${num(v, 1)}°`],
  ['relief', ['20 m 內高差 ≤ 1 m', 'Relief within 20 m ≤ 1 m'], v => v <= 1, v => `${num(v, 2)} m`],
  ['litShare', ['一天中日照 ≥ 30%', 'Sunlit ≥ 30% of a day'], v => v >= 0.3, v => `${num(v * 100)}%`],
  ['landing', ['距著陸點 200 m – 2 km', '200 m – 2 km from landing'], v => v >= 200 && v <= 2000, v => dist(v)],
]

function Site({ engine, stats, target, tr }) {
  const [check, setCheck] = useState(null)
  const tName = tr(target.body === 'mars' ? '火星選區' : '月球選區', target.body === 'mars' ? 'Mars selection' : 'Moon selection')
  const cell = (s, [k, , ok, fmt]) => s && s[k] != null ? <td><span className={`eva-chip ${ok(s[k]) ? 'ok' : 'bad'}`}>{fmt(s[k])}</span></td> : <td>—</td>
  const earthRow = s => !s ? <td>—</td> : s.earth ? <td><span className={`eva-chip ${s.earth.visible ? 'ok' : 'bad'}`}>{s.earth.visible ? tr(`可見 ${num(s.earth.elevation)}°`, `in view ${num(s.earth.elevation)}°`) : tr('看不到', 'hidden')}</span></td> : <td>{tr('不適用', 'n/a')}</td>
  const passes = s => s ? THRESH.filter(t => s[t[0]] != null && t[2](s[t[0]])).length + (s.earth ? (s.earth.visible ? 1 : 0) : 0) : 0
  const total = s => THRESH.length + (s?.earth ? 1 : 0)
  return <div className="eva-mission-body">
    <p className="eva-route-hint">{tr('評估畫面前方約 14 m、20 m × 20 m 的棲地佔地：坡度與起伏、一整天的日照、對地球通訊與到著陸點的距離。兩個場址用同一個窗格內位置。',
      'Checks a 20 m × 20 m habitat footprint about 14 m ahead of the view: slope and relief, sunlight over a full day, Earth in view and the distance to the landing site. Both sites use the same position in the window.')}</p>
    <div className="eva-route-buttons">
      <button type="button" className="is-primary" onClick={() => setCheck(engine.current?.siteCheck() || null)}>{tr('評估此處', 'Check this spot')}</button>
      <button type="button" disabled={!check} onClick={() => engine.current?.placeBase()}>{tr('在前方放置棲地模組', 'Place the habitat ahead')}</button>
    </div>
    {check && <table className="eva-compare eva-route-table">
      <thead><tr><th scope="col" /><th scope="col">{tName}</th><th scope="col">{tr('地球候選', 'Earth candidate')}</th></tr></thead>
      <tbody>
        {THRESH.map(t => <tr key={t[0]}><th scope="row">{tr(t[1][0], t[1][1])}</th>{cell(check.target, t)}{cell(check.earth, t)}</tr>)}
        <tr><th scope="row">{tr('可直視地球', 'Earth in view')}</th>{earthRow(check.target)}{earthRow(check.earth)}</tr>
        <tr><th scope="row">{tr('符合項目', 'Criteria met')}</th><td><b>{passes(check.target)} / {total(check.target)}</b></td><td><b>{passes(check.earth)} / {total(check.earth)}</b></td></tr>
      </tbody></table>}
    <small>{tr('門檻為篩選用的示意值：棲地需要接近水平的地基；著陸點至少 200 m，因為下降噴流會把表土噴射到數百公尺外；日照依 DEM 地平線與太陽軌跡計算。地球候選沒有著陸點，距離以起點計。',
      'Thresholds are illustrative screening values: a habitat needs a near-level foundation; at least 200 m from the landing site because the descent plume blasts regolith hundreds of metres; sunlight from the DEM horizon and the sun’s path. The Earth candidate has no landing site, so the distance is to the start point.')}</small>
  </div>
}

function Resources({ engine, target, earth, tr }) {
  const [ice, setIce] = useState(undefined)
  const g = target.geochem
  if (target.body === 'mars') return <div className="eva-mission-body">
    <ul className="eva-isru">
      <li><b>{tr('大氣產氧', 'Oxygen from the air')}</b>{tr('火星大氣約 95% 是 CO₂，可用固態氧化物電解產氧；毅力號上的試驗裝置已在火星上做到。', 'The Martian air is about 95% CO₂, which solid-oxide electrolysis splits into oxygen; a test unit on Perseverance has done it on Mars.')}</li>
      <li><b>{tr('水', 'Water')}</b>{Math.abs(target.lat) >= 40 ? tr(`此窗格在緯度 ${num(Math.abs(target.lat))}°，淺層地下冰可能存在（實際深度與含量需探測）。`, `At latitude ${num(Math.abs(target.lat))}°, shallow ground ice is possible (depth and amount need measurement).`)
        : tr(`此窗格在緯度 ${num(Math.abs(target.lat))}°，地下冰不太可能接近地表；可從含水礦物與土壤加熱取得少量水。`, `At latitude ${num(Math.abs(target.lat))}°, ground ice is unlikely near the surface; small amounts of water can be baked out of hydrated minerals and soil.`)}</li>
    </ul>
    <small>{tr('定性估算，不是資源量。地球候選只作訓練場，不估算資源。', 'Qualitative estimate, not a resource figure. The Earth candidate is a training site; no resources are estimated there.')}</small>
  </div>
  const tio2 = g ? g.titanium_weight_percent * 1.668 : null, ilmenite = tio2 != null ? tio2 * 1.9 : null
  const low = ilmenite != null ? ilmenite * 0.1055 * 10 : null, high = g ? g.feo_weight_percent * 0.2227 * 10 : null    // kg O2 per tonne
  const perDay = v => v > 0 ? O2_PER_PERSON_DAY / (v / 1000) : null
  return <div className="eva-mission-body">
    {g ? <ul className="eva-isru">
      <li><b>{tr('表土成分（區域平均）', 'Regolith chemistry (regional)')}</b>FeO {num(g.feo_weight_percent, 1)} wt% · TiO₂ {num(tio2, 1)} wt%{tr(`（若鈦全在鈦鐵礦中，鈦鐵礦約 ${num(ilmenite, 1)} wt%）`, ` (ilmenite about ${num(ilmenite, 1)} wt% if all Ti sits in it)`)}</li>
      <li><b>{tr('氫還原產氧', 'Oxygen by hydrogen reduction')}</b>{tr(`每噸表土約 ${num(low)}–${num(high)} kg O₂`, `about ${num(low)}–${num(high)} kg O₂ per tonne of regolith`)}
        <span>{tr(`下限只還原鈦鐵礦，上限把 FeO 的氧全部取出。一人一天約需 ${O2_PER_PERSON_DAY} kg O₂，相當於處理 ${num(perDay(high))}–${num(perDay(low))} kg 表土。`, `The low end reduces only ilmenite; the high end takes all the oxygen in FeO. One person needs about ${O2_PER_PERSON_DAY} kg O₂ a day, i.e. ${num(perDay(high))}–${num(perDay(low))} kg of regolith processed.`)}</span></li>
      <li><b>{tr('水冰', 'Water ice')}</b>{ice === undefined ? <button type="button" className="eva-isru-check" onClick={() => setIce(engine.current?.iceCheck() ?? null)}>{tr('檢查此處是否永久陰影', 'Check for permanent shadow here')}</button>
        : ice ? tr('此處在太陽赤緯兩端都照不到陽光（永久陰影），溫度可能低到能保存水冰；含量需實地探測。', 'No direct sun at either extreme of the solar declination: permanent shadow, cold enough that water ice may survive; the amount needs measurement.')
          : ice === false ? tr('此處一年中會被照到，表土含水極低（主要是太陽風植入的氫，換算水約 0.05 wt% 以下）。', 'This spot is sunlit during the year; the regolith holds very little water (mostly implanted solar-wind hydrogen, below about 0.05 wt% as water).')
            : tr('無法判斷（不在月球場景）。', 'Cannot tell here (not in the Moon scene).')}</li>
    </ul> : <p className="eva-route-hint">{tr('這個選區沒有區域元素豐度資料，無法估算產氧量。', 'No regional element abundances for this selection, so oxygen yield cannot be estimated.')}</p>}
    {earth.lithology && <p className="eva-route-hint">{tr(`地球候選的區域岩性是「${earth.lithology}」；訓練時可用來練習採樣與描述，但不代表月壤成分。`, `The Earth candidate’s regional lithology is “${lithologyName(earth.lithology, tr)}”; useful for practising sampling and description, not a stand-in for lunar regolith chemistry.`)}</p>}
    <small>{tr('化學計量估算：TiO₂ = Ti × 1.668，氫還原可從鈦鐵礦 FeTiO₃ 取出約其質量 10.6% 的氧，FeO 含氧 22.3%；不含提取效率與設備能耗。只供篩選與教學。',
      'Stoichiometric estimate: TiO₂ = Ti × 1.668, ilmenite FeTiO₃ is 10.6% recoverable oxygen, FeO is 22.3% oxygen; extraction efficiency and plant energy are not included. For screening and teaching only.')}</small>
  </div>
}

export default function MissionPanel({ engine, stats, target, earth, tr, mission, setMission, onClose }) {
  const [tab, setTab] = useState('mission')
  const tabs = [['mission', tr('野外任務', 'Field mission')], ['site', tr('基地選址', 'Base site')], ['isru', tr('現地資源', 'Resources')]]
  return <section className="eva-route eva-mission" aria-label={tr('任務與基地', 'Mission and base')}>
    <header><strong>{tr('任務與基地', 'Mission and base')}</strong><button type="button" onClick={onClose} aria-label={tr('關閉', 'Close')}>✕</button></header>
    <div className="eva-mission-tabs" role="tablist">{tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}</div>
    {tab === 'mission' && <Mission engine={engine} stats={stats} target={target} earth={earth} tr={tr} mission={mission} setMission={setMission} />}
    {tab === 'site' && <Site engine={engine} stats={stats} target={target} tr={tr} />}
    {tab === 'isru' && <Resources engine={engine} target={target} earth={earth} tr={tr} />}
  </section>
}
