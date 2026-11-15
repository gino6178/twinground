import React from 'react'
import {useLanguage} from './i18n/language.jsx'

export function TerrainSampling({sampling}) {
 const language=useLanguage()
 const en=language==='en'
 if(!sampling)return null
 const s=sampling
 const metric=v=>Number(v).toLocaleString(en?'en-US':'zh-TW',{maximumFractionDigits:1})
 return <details className="selection-details sampling-evidence">
  <summary>{en?'Search-grid DEM detail limit':'搜尋格網 DEM 細節上限'} · {metric(s.source_grid_north_south_spacing_m)} m</summary>
  <p>{s.model_upsamples_source
   ? (en?'The model samples an interpolated grid finer than the source. It does not gain measured detail.':'模型使用比來源更密的插值網格，並未增加實測細節。')
   : (en?'The model uses a coarser analysis grid than the source. Fine surface recognition is unavailable.':'模型使用較粗的分析網格；目前不提供細部地表辨識。')}</p>
  <dl><dt>{en?'Stored source grid (north–south, approximate)':'實際來源格網（南北向約值）'}</dt><dd>{metric(s.source_grid_north_south_spacing_m)} m</dd>
   <dt>{en?'Model / display spacing':'模型／顯示格距'}</dt><dd>{metric(s.model_grid_spacing_m)} / {metric(s.display_grid_spacing_m)} m</dd>
   <dt>{en?'Approximate source intervals across the window':'窗格跨越的來源格距約數'}</dt><dd>{metric(s.source_intervals_across_window_approx)}</dd></dl>
  <small>{en?'Grid spacing is not positional accuracy. Finite interpolated samples do not prove complete native coverage.':'格距不等於定位精度；插值樣本有效不代表原始資料完整覆蓋。'}</small>
 </details>
}
