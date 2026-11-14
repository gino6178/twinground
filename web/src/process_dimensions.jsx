// Further dimensions named in the challenge objectives: temperature extremes, dust and wind, biology and
// habitability. Each compares the candidate's 2001–2025 climate normals with fixed values for the Moon or Mars.
// Display only: none of this enters retrieval, gating or ranking. The thresholds are stated in the note.
import React from 'react'
import { getLanguage } from './i18n/core.js'
import { withNiche, processes, illumination, extraNote, artFor } from './process_extra.jsx'
import { useBiology, BioRows } from './offcat_ui.jsx'
import './offcat_ui.css'
import { SceneCanvas } from './conditions_art.jsx'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const num = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—')
const CHIP = {
  2: ['is-strong', '✓', ['強類比', 'strong']],
  1: ['is-partial', '~', ['部分', 'partial']],
  0: ['is-break', '✗', ['不成立', 'breaks down']],
  [-1]: ['is-unknown', '?', ['無資料', 'no data']],
}
const has = (...v) => v.every(Number.isFinite)

function temperature(env, mars) {
  const mean = env.temperature_annual_c, lo = env.temperature_min_c, hi = env.temperature_max_c, swing = env.temperature_daily_range_c
  let verdict = -1
  if (has(mean, lo, hi, swing)) {
    verdict = mars ? (mean <= -20 && lo <= -45 ? 2 : mean <= 0 || lo <= -30 || swing >= 20 ? 1 : 0) : (swing >= 20 || hi - lo >= 70 ? 1 : 0)
  }
  return {
    id: 'temperature', title: ['溫度與極端環境', 'Temperature and extremes'], verdict,
    here: tr(`年均 ${num(mean, 1)} °C；紀錄最低 ${num(lo, 0)} °C、最高 ${num(hi, 0)} °C；平均日夜溫差 ${num(swing, 0)} °C`,
      `annual mean ${num(mean, 1)} °C; lowest ${num(lo, 0)} °C, highest ${num(hi, 0)} °C on record; mean day–night swing ${num(swing, 0)} °C`),
    there: mars ? tr('平均約 −63 °C，日夜溫差約 60–80 °C', 'mean about −63 °C, day–night swing about 60–80 °C')
      : tr('赤道日夜溫差約 250 °C，永久陰影區低於 −200 °C', 'equatorial day–night swing about 250 °C; permanently shadowed regions below −200 °C'),
    use: verdict === 2 ? tr('可在接近火星白天的低溫下測試電池、潤滑與取樣機構。', 'Batteries, lubricants and sampling mechanisms can be tested at temperatures close to a Martian day.')
      : verdict === 1 ? tr('可測試硬體承受冷熱循環的能力，但溫度範圍只涵蓋一部分。', 'Hardware can be tested for thermal cycling, but only part of the range is covered.')
        : verdict === 0 ? tr('這裡的溫度不能代表目標星球；熱控測試需要環境艙。', 'Temperatures here do not represent the target body; thermal tests need a chamber.') : '',
  }
}

function dust(env, mars) {
  const aod = env.aerosol_optical_depth, peak = env.aerosol_optical_depth_peak_month, wind = env.wind_mean_m_s, gust = env.wind_max_m_s
  const ok = has(aod, peak, wind, gust)
  const dusty = ok && peak >= 0.3
  const verdict = !ok ? -1 : !mars ? 0 : dusty && wind >= 4 ? 2 : peak >= 0.15 || wind >= 5 ? 1 : 0
  return {
    id: 'dust', title: ['沙塵、風與大氣過程', 'Dust, wind and atmospheric processes'], verdict,
    here: tr(`氣膠光學厚度年均 ${num(aod, 2)}、最高月份 ${num(peak, 2)}；10 m 風速平均 ${num(wind, 1)} m/s、最大 ${num(gust, 0)} m/s`,
      `aerosol optical depth ${num(aod, 2)} on average, ${num(peak, 2)} in the peak month; 10 m wind ${num(wind, 1)} m/s on average, ${num(gust, 0)} m/s at most`),
    there: mars ? tr('平時塵埃光學厚度約 0.3–1，全球沙塵暴時超過 5；風速多為 2–10 m/s，風沙搬運仍在進行', 'dust optical depth about 0.3–1 in clear seasons and above 5 in global storms; winds mostly 2–10 m/s; aeolian transport is active today')
      : tr('沒有大氣也沒有風；月塵靠撞擊與靜電移動', 'no atmosphere and no wind; lunar dust moves by impacts and electrostatic charging'),
    use: !ok ? '' : !mars ? (dusty ? tr('風吹沙塵是月球沒有的過程，類比在這裡不成立；但空氣中的塵量足以測試硬體的耐塵與密封。', 'Wind-blown dust does not exist on the Moon, so the analogy breaks here; the dust load is still enough to test seals and dust tolerance of hardware.')
      : tr('風吹沙塵是月球沒有的過程，類比在這裡不成立；耐塵測試需要月壤模擬物。', 'Wind-blown dust does not exist on the Moon, so the analogy breaks here; dust tests need a regolith simulant.'))
      : verdict === 2 ? tr('可研究沙塵對太陽能板、光學儀器與能見度的影響，並觀察進行中的風沙搬運。', 'Dust effects on solar panels, optics and visibility can be studied here, with aeolian transport in progress.')
        : verdict === 1 ? tr('有風或有塵其中一項，可做部分風沙過程觀察。', 'Either wind or dust is present, so some aeolian processes can be observed.')
          : tr('空氣乾淨、風弱，不適合研究沙塵過程。', 'Clean air and weak wind: not suited to dust-process studies.'),
  }
}

function habitability(env, mars) {
  const rain = Number.isFinite(env.precipitation_annual_mean_mm_day) ? env.precipitation_annual_mean_mm_day * 365 : NaN
  const mean = env.temperature_annual_c, uv = env.uv_index, rh = env.relative_humidity_pct
  const verdict = !has(rain, mean) ? -1 : rain <= 100 ? 2 : rain <= 400 ? 1 : 0
  return {
    id: 'habitability', title: ['生物與適居性', 'Biology and habitability'], verdict,
    here: tr(`年降水約 ${num(rain, 0)} mm；相對濕度 ${num(rh, 0)}%；年均氣溫 ${num(mean, 1)} °C；紫外線指數 ${num(uv, 1)}`,
      `about ${num(rain, 0)} mm of precipitation a year; relative humidity ${num(rh, 0)}%; annual mean ${num(mean, 1)} °C; UV index ${num(uv, 1)}`),
    there: mars ? tr('地表沒有穩定的液態水；紫外線含 UVC 直達地表；尚未發現生命', 'no stable liquid water at the surface; ultraviolet light including UVC reaches the ground; no life found so far')
      : tr('沒有液態水、沒有已知生命', 'no liquid water and no known life'),
    use: verdict === 2 ? (mars ? tr('水極少、生物量低，接近生命的乾燥極限：適合測試生命偵測儀器的靈敏度與生物特徵的保存。', 'Very little water and low biomass, near the dry limit of life: suited to testing the sensitivity of life-detection instruments and the preservation of biosignatures.')
      : tr('生物背景低：適合演練樣本處理與污染管制流程。', 'Low biological background: suited to rehearsing sample handling and contamination control.'))
      : verdict === 1 ? tr('半乾燥，生物量中等：只能當作比較用的對照場址。', 'Semi-arid with moderate biomass: useful only as a comparison site.')
        : verdict === 0 ? tr('降水充足、生物活躍，與目標星球差異大。', 'Ample precipitation and active biology: far from the target body.') : '',
  }
}

export function ProcessDimensions({ env, body, rows = [], lat, lon }) {
  const mars = body === 'mars'
  const bio = useBiology(env?.available ? env : null, body, lat, lon)
  if (!env) return <p className="cond-note">{tr('正在讀取氣候資料…', 'Loading climate data…')}</p>
  if (!env.available) return <p className="cond-note">{tr('氣候資料暫時無法讀取，這五個面向沒有判定。', 'Climate data is unavailable right now, so these five dimensions have no verdict.')}</p>
  const cards = [temperature(env, mars), dust(env, mars), withNiche(habitability(env, mars), env, rows, mars), processes(env, rows, mars), illumination(env, mars, lat)]
  return <>
    <div className="analogy-dims is-five">
      {cards.map(card => {
        const [cls, mark, word] = CHIP[card.verdict]
        const art = artFor(card, env, mars, lat)
        return <article key={card.id} className={`analogy-dim ${cls}`}>
          <header><h4>{tr(...card.title)}</h4><span className="analogy-chip"><span aria-hidden="true">{mark}</span> {tr(...word)}</span></header>
          <div className="analogy-dim-body">
          {art && <div className={`cart ${card.verdict === -1 ? 'is-unknown' : ''}`}><SceneCanvas scene={art[0]} params={art[1]} /></div>}
          <dl>
            <div><dt>{tr('這個地點', 'This site')}</dt><dd>{card.here}</dd></div>
            <div><dt>{mars ? tr('火星', 'Mars') : tr('月球', 'Moon')}</dt><dd>{card.there}</dd></div>
          </dl>
          </div>
          {card.use && <p>{card.use}</p>}
          {card.extra && <p className="analogy-dim-extra">{card.extra}</p>}
          {card.id === 'habitability' && <BioRows bio={bio} mars={mars} />}
        </article>
      })}
    </div>
  </>
}
