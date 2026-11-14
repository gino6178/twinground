import React from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'
import './terrain_read_card.css'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const pick = t => (t ? (getLanguage() === 'en' ? t.en : t.zh) : '')
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: d }) : '—')

// Instant reading of the selected window on the selection page (SysOne-Nano), before any search.
export function TerrainReadCard({ read, body }) {
  useLanguage()
  if (!read?.questions?.length) return null
  return <section className="read-card" aria-label={tr('這塊地的即時判讀', 'Instant reading of this window')}>
    <h4>{tr('這塊地的即時判讀', 'Instant reading of this window')}</h4>
    <ul>{read.questions.map(q => <li key={q.id}>
      <span>{pick(q.label)}</span>
      <i aria-hidden="true"><b style={{ width: `${Math.round(100 * q.query_percentile)}%` }} /></i>
      <em>{tr('高於', 'above')} {fmt(100 * q.query_percentile)}% {body === 'mars' ? tr('的火星窗格', 'of Mars') : tr('的月球窗格', 'of Moon')}</em>
    </li>)}</ul>
    <p>{tr(`SysOne-Nano（${fmt(read.parameters)} 個參數）讀地形與材質；以地質圖驗證 AUC ${read.questions.map(q => q.validation.map(v => v.auc.toFixed(2)).join('／')).join('、')}。`, `SysOne-Nano (${fmt(read.parameters)} parameters) reads terrain and material; geologic-map AUC ${read.questions.map(q => q.validation.map(v => v.auc.toFixed(2)).join('/')).join(', ')}.`)}</p>
  </section>
}
