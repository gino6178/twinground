// "At a glance" summary at the top of the results page: what was searched, how the index was narrowed down, the top
// three candidates with why they match (and what is unknown), and what to do next. Text is paired zh/en in place.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { getLanguage, translate } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import { PURPOSES } from './purposes.js'
import { conditionReasons } from './conditions_panel.jsx'
import { RunDownloads } from './research_evidence.jsx'
import { SKYLIGHT_PRESETS } from './skylight_presets.jsx'
import { formatCoord } from './planet_geo.js'
import { planetPlace } from './planet_names.js'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—')
// Known-analog type from the catalogue tags (scripts/known_analogs); mission_ops only when nothing else applies.
const ANALOG_TAGS = {
  lava_tube: ['熔岩管', 'lava tube'], basaltic_volcanism: ['玄武岩火山', 'basaltic volcanism'], impact: ['撞擊', 'impact'],
  aeolian: ['風成', 'aeolian'], hyperarid: ['極乾', 'hyperarid'], evaporite_brine: ['蒸發岩／鹵水', 'evaporite / brine'],
  ice_periglacial: ['冰／凍原', 'ice / periglacial'], fluvial_lacustrine: ['河湖', 'fluvial / lacustrine'], hydrothermal: ['熱液', 'hydrothermal'],
  pyroclastic: ['火山碎屑', 'pyroclastic'], biosignature: ['生物跡證', 'biosignature'], regolith_isru: ['風化層／ISRU', 'regolith / ISRU'],
  mission_ops: ['任務演練', 'mission operations'],
}
// Upstream typo in the PAAD analog catalogue ("mega-ripple filed"); fixed for display until the server data is corrected.
export const analogName = n => (typeof n === 'string' ? n.replace(/ripple filed/i, 'ripple field') : n)
// Name, type label and (lava-tube searches only) whether the analog's type fits the query.
export function knownAnalogInfo(k, purpose) {
  const en = getLanguage() === 'en'
  const tags = (k.tags || []).filter(t => ANALOG_TAGS[t])
  const shown = (tags.some(t => t !== 'mission_ops') ? tags.filter(t => t !== 'mission_ops') : tags).slice(0, 2)
  const type = shown.map(t => ANALOG_TAGS[t][en ? 1 : 0]).join(en ? ', ' : '、')
  let fit = null
  if (purpose === 'lavatube') fit = tags.includes('lava_tube') ? 'match' : tags.includes('basaltic_volcanism') ? 'partial' : 'other'
  const fitText = fit === 'match' ? tr('類型相符', 'same type') : fit === 'partial' ? tr('部分相關', 'related') : fit === 'other' ? tr('類型不同', 'different type') : ''
  return { name: analogName(en ? k.name : k.name_zh || k.name), type, fit, fitText }
}

const AXIS = {
  albedo: ['亮度', 'brightness'], ferric: ['鐵氧化物', 'ferric oxide'], mafic: ['鐵鎂', 'mafic'],
  hydroxyl: ['含水', 'hydration'], dryness: ['乾燥度', 'aridity'],
}

// Small shaded relief of the query window (64 x 64 search grid).
function DemThumb({ terrain }) {
  const canvas = useRef(null)
  useEffect(() => {
    const h = terrain?.heights_m
    const c = canvas.current
    if (!h?.length || !c) return
    const n = Math.round(Math.sqrt(h.length)), ctx = c.getContext('2d'), img = ctx.createImageData(n, n)
    let lo = Infinity, hi = -Infinity
    for (const v of h) { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
    const span = Math.max(1, hi - lo), at = (r, col) => h[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, col))]
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        const dx = (at(r, col + 1) - at(r, col - 1)) / span * n * 0.35, dy = (at(r + 1, col) - at(r - 1, col)) / span * n * 0.35
        const shade = Math.max(0, Math.min(1, 0.62 + (-dx * 0.7 + dy * 0.7) / Math.sqrt(1 + dx * dx + dy * dy) * 0.5))
        const t = (at(r, col) - lo) / span, v = 70 + 150 * shade * (0.75 + 0.25 * t), i = (r * n + col) * 4
        img.data[i] = v * 0.93; img.data[i + 1] = v; img.data[i + 2] = v * 0.98; img.data[i + 3] = 255
      }
    }
    c.width = c.height = n
    ctx.putImageData(img, 0, 0)
  }, [terrain])
  return <canvas ref={canvas} className="glance-thumb" aria-hidden="true" />
}

function queryPreset(data) {
  // A free selection comes back as id 'global' with the generic name "freely selected Mars region": name it from the
  // IAU gazetteer instead (planetPlace below), like Moon queries.
  if (data.mars_reference?.name && data.mars_reference.id !== 'global') return { name: data.mars_reference.name, zh: null }
  const list = SKYLIGHT_PRESETS[data.window.body] || []
  const hit = list.find(p => Math.abs(p.lat - data.window.lat) < 0.02 && Math.abs(p.lon - data.window.lon) < 0.02)
  return hit ? { name: translate(hit.name, 'en'), zh: hit.name } : null
}

function queryTraits(data) {
  const out = []
  const g = data.moon_geology
  if (g?.available && g.dominant_unit) {
    const d = g.dominant_unit.description || ''
    // Same wording as the Conditions panel (server setting text for this unit code) so the unit reads the same everywhere.
    const st = data.conditions?.setting_text
    const kind = st && data.conditions?.unit?.code === g.dominant_unit.code ? (getLanguage() === 'en' ? st.en : st.zh) : /mare/i.test(d) ? tr('月海玄武岩', 'mare basalt') : /crater/i.test(d) ? tr('撞擊坑物質', 'crater material') : /plateau/i.test(d) ? tr('高原單元', 'plateau unit') : /dome/i.test(d) ? tr('穹丘', 'dome') : /terra|highland|plains/i.test(d) ? tr('高地', 'highland') : d
    out.push(tr(`${kind}（${g.dominant_unit.code}）`, `${kind} (${g.dominant_unit.code})`))
  }
  const q = data.material?.query
  if (q?.raw?.feo_wt != null) out.push(`FeO ${fmt(q.raw.feo_wt, 1)} wt%`)
  if (q?.body === 'mars') {
    if (q.dusty) out.push(tr('沙塵覆蓋', 'dust-covered'))
    if (q.hydrated) out.push(tr('有含水礦物偵測', 'hydrated minerals detected'))
    if (q.axes?.mafic != null) out.push(tr(`鐵鎂第 ${Math.round(q.axes.mafic * 100)} 百分位`, `mafic ${Math.round(q.axes.mafic * 100)}th pct.`))
  }
  const audit = data.matches[0]?.geometry_audit
  if (audit) {
    out.push(tr(`平均坡度 ${fmt(audit.reference_mean_slope_deg, 1)}°`, `mean slope ${fmt(audit.reference_mean_slope_deg, 1)}°`))
    out.push(tr(`起伏 P90 ${fmt(audit.reference_roughness_p90_m)} m`, `relief roughness P90 ${fmt(audit.reference_roughness_p90_m)} m`))
  }
  const spacing = data.window.sampling?.source_grid_north_south_spacing_m
  if (spacing) out.push(tr(`搜尋格網格距約 ${fmt(spacing)} m（3D 場景另用較細的 DEM）`, `search-grid spacing ≈ ${fmt(spacing)} m (the 3D scene uses a finer DEM)`))
  return out
}

function funnel(data) {
  const steps = [[data.searched_windows, tr('個地球窗格', 'Earth windows')]]
  if (data.purpose === 'conditions' && data.conditions?.gate?.gated_windows != null) steps.push([data.conditions.gate.gated_windows, tr('個符合環境、地質與資源條件', 'meet the environment, geology and resource conditions')])
  if (data.lavatube?.coarse?.gated_windows != null) steps.push([data.lavatube.coarse.gated_windows, tr(`個在玄武岩火山 ${fmt(data.lavatube.coarse.gate_km)} km 內`, `within ${fmt(data.lavatube.coarse.gate_km)} km of a basaltic volcano`)])
  const eligible = data.context_ranking?.eligible_windows
  if (data.context_ranking?.context_applied && eligible != null && eligible !== data.searched_windows) steps.push([eligible, tr('個符合地域與岩性條件', 'meet the regional criteria')])
  if (data.candidate_groups?.group_count != null) steps.push([data.candidate_groups.group_count, tr('個地點群組', 'place groups')])
  steps.push([data.matches.length, tr('名顯示中', 'shown')])
  return steps
}

function basis(data) {
  if (data.purpose === 'conditions') return tr('先篩條件（環境、地質、資源），再依地形相似度排序', 'conditions first (environment, geology, resources), then terrain similarity')
  if (data.lavatube) return tr('先篩玄武岩火山背景，再依地形相似度排序', 'volcanic setting first, then terrain similarity')
  if (data.material) return tr('地形與材質各占一半', 'terrain and material weighted equally')
  if (data.global_visual?.applied) return tr('地形＋中心影像樣本', 'terrain + centre-image sample')
  if (data.context_ranking?.context_applied) return tr('地形 65%＋地域與岩性條件 35%', 'terrain 65% + regional criteria 35%')
  return tr('只依地形形狀', 'terrain shape only')
}

// ✓ / ? reasons for one candidate, at most four.
function reasons(data, row) {
  const ok = [], unknown = []
  const cond = conditionReasons(row)
  ok.push(...cond.ok.slice(0, data.purpose === 'conditions' ? 2 : 1))
  if (cond.unknown.length) unknown.push(cond.unknown[0])
  const a = row.geometry_audit
  const close = (x, y) => Number.isFinite(x) && Number.isFinite(y) && (Math.max(x, y) < 1.5 || Math.max(x, y) / Math.max(1e-6, Math.min(x, y)) <= 1.6)
  if (row.material_context?.axes) {
    const axes = Object.entries(row.material_context.axes)
    const good = axes.filter(([, v]) => v.verdict === 'support').map(([k]) => tr(AXIS[k]?.[0] || k, AXIS[k]?.[1] || k))
    const part = axes.filter(([, v]) => v.verdict !== 'support').map(([k, v]) => `${tr(AXIS[k]?.[0] || k, AXIS[k]?.[1] || k)}${v.verdict === 'partial' ? tr('部分相符', ' partial') : tr('不符', ' mismatch')}`)
    if (good.length) ok.push(tr(`材質相符：${good.join('、')}`, `material matches: ${good.join(', ')}`))
    if (part.length) unknown.push(part.join(tr('、', ', ')))
    if (row.material_context.low_confidence) unknown.push(tr('地面多被遮蔽，推估信心低', 'ground mostly covered; low confidence'))
  }
  if (row.lavatube_context) ok.push(tr(`距 ${row.lavatube_context.name} ${fmt(row.lavatube_context.distance_km, 0)} km（玄武岩火山）`, `${fmt(row.lavatube_context.distance_km, 0)} km from ${row.lavatube_context.name} (basaltic volcano)`))
  if (a) {
    const slope = tr(`坡度 ${fmt(a.reference_mean_slope_deg, 1)}° ↔ ${fmt(a.earth_mean_slope_deg, 1)}°`, `slope ${fmt(a.reference_mean_slope_deg, 1)}° ↔ ${fmt(a.earth_mean_slope_deg, 1)}°`)
    ;(close(a.reference_mean_slope_deg, a.earth_mean_slope_deg) ? ok : unknown).push(slope)
    if (ok.length < 3) {
      const rough = tr(`起伏 P90 ${fmt(a.reference_roughness_p90_m)} ↔ ${fmt(a.earth_roughness_p90_m)} m`, `relief roughness P90 ${fmt(a.reference_roughness_p90_m)} ↔ ${fmt(a.earth_roughness_p90_m)} m`)
      ;(close(a.reference_roughness_p90_m, a.earth_roughness_p90_m) ? ok : unknown).push(rough)
    }
  }
  if (!row.material_context && row.earth_lithology?.available && ok.length < 3) {
    const mafic = row.earth_lithology.code === 'vb' || row.earth_lithology.code === 'pb'
    const mare = /mare/i.test(data.moon_geology?.dominant_unit?.description || '')
    const lith = translate(row.earth_lithology.label, getLanguage())
    if (mare && mafic) ok.push(tr(`${lith}，對應月海玄武岩`, `${lith}, like mare basalt`))
    else unknown.push(tr(`岩性：${lith}`, `lithology: ${lith}`))
  }
  if (!row.material_context && !data.material && !row.conditions?.available) unknown.push(tr('未比對材質（可改用「地形＋材質」）', 'material not compared (try terrain + material)'))
  return { ok: ok.slice(0, 3), unknown: unknown.slice(0, 2) }
}

function Bar({ label, value }) {
  const v = Math.max(0, Math.min(100, value))
  return <span className="glance-bar"><span className="glance-bar-label">{label}</span><span className="glance-bar-track"><i style={{ width: `${v}%` }} /></span><b>{fmt(value)}</b></span>
}

export function ResultsGlance({ data, active, places, headingRef, onBack, onReport, onCompare, onExplore, onShowAll, onConditions }) {
  useLanguage()
  const isMars = data.window.body === 'mars'
  const [named, setNamed] = useState(null)
  const preset = queryPreset(data)
  useEffect(() => {
    let alive = true
    setNamed(null)
    if (!preset) planetPlace(data.window.body, data.window.lat, data.window.lon).then(p => { if (alive) setNamed(p) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.window.body, data.window.lat, data.window.lon])
  const en = getLanguage() === 'en'
  const bodyName = isMars ? tr('火星', 'Mars') : tr('月球', 'Moon')
  const place = preset ? (en ? preset.name : preset.zh || preset.name)
    : named ? (en ? `near ${named.name}` : `${named.zh ? `${named.zh}（${named.name}）` : named.name}附近`) : formatCoord(data.window.lat, data.window.lon)
  const purpose = translate((PURPOSES[data.purpose] || PURPOSES.morphology).label, getLanguage())
  const top = data.matches.slice(0, 3)
  // Badges only when the known-analog catalogue was applied; otherwise null would wrongly read as "new candidate".
  const hasKnownField = data.known_analog_catalogue?.available === true
  const known = hasKnownField ? data.matches.map((m, i) => [m, i]).filter(([m]) => m.known_analog) : []
  const knownText = k => {
    const info = knownAnalogInfo(k, data.purpose)
    const detail = [info.type, info.fitText].filter(Boolean).join(tr('，', ', '))
    return detail ? `${info.name}${tr('（', ' (')}${detail}${tr('）', ')')}` : info.name
  }
  return <section className="glance" aria-label={tr('搜尋結果摘要', 'Search summary')}>
    <div className="glance-query">
      <DemThumb terrain={data.window.terrain} />
      <div className="glance-query-text">
        <span className="glance-kicker">{tr('你搜尋的是', 'You searched')}</span>
        <h1 ref={headingRef} tabIndex={-1}>{bodyName} · {place}</h1>
        <p className="glance-meta">{formatCoord(data.window.lat, data.window.lon)} · {data.window.patch_km} × {data.window.patch_km} km · {tr('用途：', 'Purpose: ')}{purpose}</p>
        <p className="glance-traits">{queryTraits(data).join(' · ')}</p>
      </div>
      <div className="glance-actions">
        <RunDownloads data={data} activeId={active.id} onReport={onReport} places={places} />
        <button className="outline-button" type="button" onClick={onBack}><ArrowLeft size={16} /> {tr('重新選區', 'New selection')}</button>
      </div>
    </div>

    <div className="glance-funnel">
      <ol>{funnel(data).map(([n, label], i) => <li key={i}><b>{fmt(n)}</b> {label}</li>)}</ol>
    </div>

    <div className="glance-cards">
      {top.map((row, i) => {
        const why = reasons(data, row)
        const name = places[row.id] ? places[row.id][en ? 1 : 0] : formatCoord(row.center.latitude, row.center.longitude_east)
        return <article key={row.id} className={`glance-card ${row.id === active.id ? 'is-active' : ''}`}>
          <header>
            <span className="glance-rank">#{i + 1}</span>
            <div>
              <strong>{name}</strong>
              <small>{formatCoord(row.center.latitude, row.center.longitude_east)}</small>
            </div>
            {hasKnownField && <span className={`glance-badge ${row.known_analog ? 'is-known' : 'is-new'}`}>{row.known_analog ? tr('既有類比', 'Known analog') : row.catalogue_nearest?.off_catalogue ? tr('目錄外候選', 'Off-catalogue') : tr('新候選', 'New candidate')}</span>}
          </header>
          {hasKnownField && row.known_analog?.name && <p className={`glance-known fit-${knownAnalogInfo(row.known_analog, data.purpose).fit || 'none'}`}>{tr('附近的既有類比：', 'Near known analog: ')}{knownText(row.known_analog)}{Number.isFinite(row.known_analog.distance_km) ? ` · ${fmt(row.known_analog.distance_km)} km` : ''}</p>}
          {hasKnownField && !row.known_analog && row.catalogue_nearest && <p className="glance-offcat">{tr('最近的已知類比：', 'Nearest known analog: ')}{analogName(en ? row.catalogue_nearest.name : (row.catalogue_nearest.name_zh || row.catalogue_nearest.name))} · {fmt(row.catalogue_nearest.distance_km)} km</p>}
          <div className="glance-bars">
            <Bar label={tr('地形', 'Terrain')} value={row.score} />
            {row.material_context?.similarity != null && <Bar label={tr('材質', 'Material')} value={row.material_context.similarity * 100} />}
          </div>
          <ul className="glance-why">
            {why.ok.map((t, k) => <li key={'o' + k} className="is-ok">{t}</li>)}
            {why.unknown.map((t, k) => <li key={'u' + k} className="is-unknown">{t}</li>)}
          </ul>
          <div className="glance-card-actions">
            <button type="button" className="outline-button" onClick={() => onCompare(row.id)}>{tr('3D 對照', '3D compare')}</button>
            <button type="button" className="glance-explore" onClick={() => onExplore(row.id)}>{tr('太空人探索', 'Explore on foot')}</button>
            {row.conditions?.available && onConditions && <button type="button" className="glance-dossier" onClick={() => onConditions(row.id)}>{tr('條件與場址檔案', 'Conditions & dossier')}</button>}
          </div>
        </article>
      })}
    </div>

    <div className="glance-foot">
      {known.length > 0 && <span>{tr('既有類比也在名單中：', 'Known analogs in the list: ')}{known.map(([m, i]) => `#${i + 1} ${knownText(m.known_analog)}`).join(tr('；', '; '))}</span>}
      <button type="button" className="glance-all" onClick={onShowAll}>{tr(`看全部 ${data.matches.length} 個候選與 3D 對照 ↓`, `All ${data.matches.length} candidates and 3D comparison ↓`)}</button>
    </div>
  </section>
}
