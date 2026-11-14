import React from 'react'
import { getLanguage } from './i18n/core.js'
// One summary line under the results heading: how this list was ranked, plus the optional image re-ranking when the
// selection has indexed imagery. (The background index build status is internal and is no longer polled here.)
export function GlobalVisualPanel({ data, onVisual, onTerrain, busy }) {
  const m = data.global_visual, c = data.context_ranking
  if (!c && !m) return null
  const mode = m?.applied ? '地形＋中心影像樣本聯合評分' : c?.context_applied ? '地形＋地表條件聯合評分' : '純地形搜尋'
  const surface = !c ? null : c.target.surface === 'desert' ? '沙漠與乾燥灌叢地域' : c.target.surface === 'mapped_dunes' ? '已記錄沙丘的地域（0.1°）' : '不限地域'
  return <section className="fusion-summary search-summary" aria-label="排序方式">
    <strong>{mode}</strong>
    {c && <span>{surface} · {c.target.rock_label}</span>}
    {c && <span>{getLanguage() === 'en' ? `${c.eligible_windows.toLocaleString()} of ${c.indexed_windows.toLocaleString()} indexed windows meet the criteria` : `全索引 ${c.indexed_windows.toLocaleString()} 筆中，${c.eligible_windows.toLocaleString()} 筆符合條件`}</span>}
    {m?.applied
      ? <button type="button" className="outline-button" disabled={busy} onClick={onTerrain}>改回純地形排序</button>
      : m?.reference?.available ? <button type="button" className="outline-button" disabled={busy} onClick={onVisual}>加入影像樣本比對</button> : null}
    {m?.applied && <small>{getLanguage() === 'en' ? `Image matching covers only the ${m.compared_windows?.toLocaleString()} windows that already have image features (Sentinel-2 cloudless · EOX, CC BY 4.0).` : `影像比對只涵蓋 ${m.compared_windows?.toLocaleString()} 個已有影像特徵的窗格（Sentinel-2 cloudless · EOX，CC BY 4.0）。`}</small>}
    <small>地表條件以區域圖層取樣判定，不等於沙粒、岩層結構或材質已確認相同。</small>
  </section>
}
