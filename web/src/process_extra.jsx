// More dimensions from the challenge objectives: the life expected at the site, the surface processes at work, and
// sunlight geometry. Display only, like process_dimensions.jsx: nothing here enters retrieval, gating or ranking.
// The expected-life line is inferred from the type of environment; it is not a field observation of this site.
import { getLanguage } from './i18n/core.js'
import { TEMPERATURE, DUST, LIFE, PROCESSES, SUNPATH } from './conditions_scenes2.js'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const num = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—')
const row = (rows, id) => rows.find(r => r.id === id)
const list = items => items.join(getLanguage() === 'en' ? ', ' : '、')

// Adds bare-ground share (the vegetation signal) and the expected microbial niche to the habitability card.
export function withNiche(card, env, rows, mars) {
  const bareRow = row(rows, 'bare'), ice = !!bareRow?.gauge?.ice_cover, bare = ice ? 1 : bareRow?.gauge?.value
  const rain = Number.isFinite(env.precipitation_annual_mean_mm_day) ? env.precipitation_annual_mean_mm_day * 365 : NaN
  const mean = env.temperature_annual_c
  let verdict = card.verdict
  if (Number.isFinite(bare) && verdict >= 0) verdict = bare >= 0.8 ? verdict : bare >= 0.5 ? Math.min(verdict, 1) : 0
  const cover = ice ? tr('冰川或冰原覆蓋，沒有植被', 'glacier or ice sheet, no vegetation')
    : Number.isFinite(bare) ? tr(`裸露或稀疏地表占 ${num(bare * 100)}%`, `${num(bare * 100)}% bare or sparsely vegetated ground`) : ''
  const nicheKey = ice || mean <= -10 ? 'endolith' : rain <= 100 ? 'hypolith' : rain <= 400 ? 'crust' : 'veg'
  const niche = verdict < 0 ? '' : ice || mean <= -10
    ? tr('這類寒冷乾燥環境裡，生命通常躲在岩石內部幾毫米深處（隱石內生菌）以及冰下或凍土中。', 'In cold, dry settings like this, life typically retreats a few millimetres inside rock (cryptoendoliths) and into ice-covered or frozen ground.')
    : rain <= 100 ? tr('這類極乾環境裡，生命通常只在半透明石塊底下（石下藍菌）與鹽殼、石膏內部存活。', 'In hyperarid settings like this, life typically survives only under translucent stones (hypolithic cyanobacteria) and inside salt and gypsum crusts.')
      : rain <= 400 ? tr('這類半乾燥環境通常有生物土壤結皮（藍菌、地衣）。', 'Semi-arid settings like this usually carry biological soil crusts (cyanobacteria, lichens).')
        : tr('這裡生命普遍，沒有特別的極端棲位。', 'Life is widespread here; there is no particular extreme niche.')
  const how = verdict < 0 ? '' : verdict === 0 ? '' : mars
    ? tr('這些棲位就是火星上搜尋生物特徵時優先檢查的位置。', 'These niches are where a search for biosignatures on Mars would look first.')
    : tr('月球沒有生命；這些棲位只用來演練採樣時的污染管制。', 'The Moon has no life; these niches only serve to rehearse contamination control during sampling.')
  return {
    ...card, verdict, niche: nicheKey, here: cover ? `${card.here}${tr('；', '; ')}${cover}` : card.here,
    use: verdict === card.verdict ? card.use : verdict === 1 ? tr('降水少但地表有植被覆蓋，生物量不低：只能當作比較用的對照場址。', 'Little precipitation but the ground is vegetated, so biomass is not low: useful only as a comparison site.')
      : tr('地表多為植被覆蓋、生物活躍，與目標星球差異大。', 'Mostly vegetated ground with active biology: far from the target body.'),
    extra: niche ? `${niche}${how ? tr('', ' ') + how : ''}${tr('（依環境類型推論，不是這個地點的採樣結果）', ' (Inferred from the type of environment, not sampled at this site.)')}` : '',
  }
}

const SHORT = { aeolian: ['風沙', 'wind'], thermal: ['冷熱循環', 'thermal'], freeze: ['凍融', 'freeze–thaw'], glacier: ['冰川', 'glacier'], volcanic: ['火山', 'volcanic'], water: ['流水', 'water'] }

// Which surface processes are at work at the site, and which of them the target body shares, today or in its past.
export function processes(env, rows, mars) {
  const rain = Number.isFinite(env.precipitation_annual_mean_mm_day) ? env.precipitation_annual_mean_mm_day * 365 : NaN
  const months = env.temperature_monthly_c || [], swing = env.temperature_daily_range_max_month_c ?? env.temperature_daily_range_c
  const windy = env.aerosol_optical_depth_peak_month >= 0.3 && env.wind_mean_m_s >= 4
  const found = []
  // [name, shared with the Moon, shared with Mars] where 2 = active there today, 1 = acted there in the past, 0 = absent
  if (row(rows, 'aeolian')?.verdict >= 1 || windy) found.push([['風沙搬運', 'aeolian transport'], 0, 2, 'aeolian'])
  if (swing >= 20) found.push([['冷熱循環使岩石碎裂', 'rock breakdown by thermal cycling'], 2, 2, 'thermal'])
  if (row(rows, 'ground_ice')?.verdict >= 1 || (months.length === 12 && Math.min(...months) < 0 && Math.max(...months) > 0)) found.push([['凍融與地下冰', 'freeze–thaw and ground ice'], 0, 2, 'freeze'])
  if (row(rows, 'bare')?.gauge?.ice_cover) found.push([['冰川流動', 'glacier flow'], 0, 2, 'glacier'])
  if (row(rows, 'volcanic')?.verdict >= 1) found.push([['火山作用留下的地形', 'volcanic landforms'], 1, 1, 'volcanic'])
  if (rain > 400) found.push([['流水侵蝕與沉積', 'erosion and deposition by running water'], 0, 1, 'water'])
  const known = Number.isFinite(rain) && months.length === 12
  const shared = found.filter(f => f[mars ? 2 : 1] > 0)
  const verdict = !known ? -1 : shared.length >= 2 ? 2 : shared.length === 1 ? 1 : 0
  const name = f => tr(...f[0]) + (f[mars ? 2 : 1] === 1 ? tr('（當地過去的過程）', ' (in its past)') : '')
  return {
    id: 'processes', title: ['今日進行中的作用過程', 'Processes active today'], verdict, keys: found.map(f => f[3]), names: found.map(f => tr(...SHORT[f[3]])),
    here: !known ? tr('資料不足', 'not enough data') : found.length ? list(found.map(f => tr(...f[0])))
      : tr('沒有偵測到明顯的作用過程', 'no marked process detected'),
    there: mars ? tr('今日：風沙搬運與沙塵暴、凍融與地下冰、冷熱循環、季節性二氧化碳霜。過去：河流、湖泊、火山', 'today: aeolian transport and dust storms, freeze–thaw and ground ice, thermal cycling, seasonal CO₂ frost; in the past: rivers, lakes, volcanism')
      : tr('今日：隕石撞擊翻攪、太空風化、冷熱循環。過去：玄武岩火山作用', 'today: impact gardening, space weathering, thermal cycling; in the past: basaltic volcanism'),
    use: !known ? '' : shared.length ? tr(`與${mars ? '火星' : '月球'}共有：${list(shared.map(name))}。可在這裡觀察這些過程如何改變地表，再對照${mars ? '火星' : '月球'}影像。`,
      `Shared with ${mars ? 'Mars' : 'the Moon'}: ${list(shared.map(name))}. Their effect on the ground can be watched here and compared with ${mars ? 'Mars' : 'lunar'} imagery.`)
      : tr(`這裡的作用過程在${mars ? '火星' : '月球'}上沒有對應。`, `The processes here have no counterpart on ${mars ? 'Mars' : 'the Moon'}.`),
    extra: mars ? (rain <= 100 ? tr('降水極少，流水侵蝕幾乎停止，地形可長期保存，這一點接近今日的火星。', 'With almost no precipitation, water erosion has nearly stopped and landforms last a long time, as on Mars today.') : '')
      : tr('月球地表的主要過程是撞擊翻攪與太空風化，地球上沒有任何地方有對應。', 'The main lunar surface processes, impact gardening and space weathering, have no counterpart anywhere on Earth.'),
  }
}

const TILT = { earth: 23.44, moon: 1.54, mars: 25.19 }
const noon = (lat, tilt) => ({ lo: 90 - Math.abs(lat) - tilt, hi: Math.min(90, 90 - Math.abs(lat) + tilt), mean: 90 - Math.abs(lat) })

// Sun height at noon through the year, from latitude and axial tilt alone.
export function illumination(env, mars, targetLat) {
  const lat = env.center?.latitude, ok = Number.isFinite(lat) && Number.isFinite(targetLat)
  const e = ok ? noon(lat, TILT.earth) : null, t = ok ? noon(targetLat, mars ? TILT.mars : TILT.moon) : null
  const gap = ok ? Math.abs(e.mean - t.mean) : NaN
  const verdict = !ok ? -1 : gap <= 10 ? 2 : gap <= 25 ? 1 : 0
  const range = r => r.lo < 0 ? tr(`全年最高 ${num(r.hi)}°，冬季有永夜`, `up to ${num(r.hi)}°, with polar night in winter`) : tr(`全年 ${num(r.lo)}° 至 ${num(r.hi)}°`, `${num(r.lo)}° to ${num(r.hi)}° through the year`)
  const flux = Number.isFinite(env.solar_annual_mean_mj_m2_day) ? env.solar_annual_mean_mj_m2_day * 11.574 : NaN
  const low = ok && e.mean <= 30 && t.mean <= 30
  return {
    id: 'illumination', title: ['日照與太陽高度', 'Sunlight and Sun height'], verdict,
    here: !ok ? tr('資料不足', 'not enough data') : tr(`正午太陽仰角${range(e)}；地面年均日射約 ${num(flux)} W/m²`, `noon Sun elevation ${range(e)}; mean sunlight at the ground about ${num(flux)} W/m²`),
    there: !ok ? '' : mars ? tr(`正午太陽仰角${range(t)}；大氣層頂日射約 590 W/m²（地球的 43%）`, `noon Sun elevation ${range(t)}; about 590 W/m² at the top of the atmosphere (43% of Earth's)`)
      : tr(`正午太陽仰角${range(t)}；沒有大氣，日射約 1,361 W/m²；白天約 14 個地球日`, `noon Sun elevation ${range(t)}; no atmosphere, about 1,361 W/m²; daylight lasts about 14 Earth days`),
    use: !ok ? '' : verdict === 2 ? (low ? tr('太陽都很低、影子很長：可測試陰影中的導航、相機曝光與直立式太陽能板。', 'The Sun is low and shadows are long in both places: navigation in shadow, camera exposure and vertical solar panels can be tested.')
      : tr('太陽高度相近，影子長度與受光角度可以直接類比。', 'Sun height is similar, so shadow length and lighting angle are a fair analog.'))
      : verdict === 1 ? tr('只有部分季節的太陽高度接近；光照測試要挑季節。', 'Sun height is close only in part of the year; lighting tests need the right season.')
        : tr('太陽高度差距大；光照測試只能挑清晨或傍晚來補。', 'Sun height differs widely; lighting tests can only use early morning or evening to compensate.'),
  }
}

// The animated illustration for each card, like the condition rows: [scene, params from the candidate's values].
const NICHE_NAME = { hypolith: ['石下藍菌', 'hypoliths'], endolith: ['岩內微生物', 'endoliths'], crust: ['生物土壤結皮', 'soil crust'], veg: ['植被', 'vegetation'] }
export function artFor(card, env, mars, targetLat) {
  if (card.id === 'temperature') return [TEMPERATURE, { lo: env.temperature_min_c, hi: env.temperature_max_c }]
  if (card.id === 'dust') return [DUST, { aod: env.aerosol_optical_depth_peak_month, wind: env.wind_mean_m_s }]
  if (card.id === 'habitability') return [LIFE, { niche: card.niche || 'crust', label: tr(...(NICHE_NAME[card.niche] || NICHE_NAME.crust)) }]
  if (card.id === 'processes') return [PROCESSES, { keys: card.keys || [], names: card.keys?.length ? card.names : [tr('無明顯過程', 'none marked')] }]
  if (card.id === 'illumination') return [SUNPATH, { earth: env.center?.latitude, target: targetLat, mars, earthName: tr('地球', 'Earth'), targetName: mars ? tr('火星', 'Mars') : tr('月球', 'Moon') }]
  return null
}

export const extraNote = () => tr(
  '另外三項的判定規則（僅供顯示，不參與排序）：生物——在降水判定之上，裸露或稀疏地表占比 ≥ 80% 維持原判定，50–80% 最多算部分，低於 50% 為不成立；棲位說明依環境類型推論，不是採樣結果。作用過程——由氣候數值與條件對照推定這個地點的過程，與目標星球共有兩項以上為強類比、一項為部分。日照——以緯度與自轉軸傾角計算正午太陽仰角，兩地年均相差 ≤ 10° 為強類比、≤ 25° 為部分。',
  'Rules for the other three (display only, not used for ranking): biology — on top of the precipitation rule, a bare or sparsely vegetated share ≥ 80% keeps the verdict, 50–80% caps it at partial and below 50% breaks it; the niche text is inferred from the type of environment, not sampled. Processes — the processes at the site are inferred from the climate values and the condition rows; two or more shared with the target body is strong, one is partial. Sunlight — noon Sun elevation is computed from latitude and axial tilt; an annual mean within 10° is strong, within 25° partial.')
