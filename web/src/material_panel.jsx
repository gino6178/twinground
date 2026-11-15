import React, { useEffect, useState } from 'react'
import { getLanguage } from './i18n/core.js'

// Terrain + material search: the query's surface material (Mars OMEGA / Moon LP+WAC) and, for each Earth candidate,
// the material inferred from geology, dryness, soil and nearby observations (works under vegetation), plus the
// Sentinel-2 observation where the ground is visible.
const AXIS_LABEL = { albedo: '亮度（反照率）', ferric: '鐵氧化物（紅土、赤鐵礦）', mafic: '鐵鎂礦物（玄武岩質）', hydroxyl: '含水／黏土礦物', dryness: '乾燥程度' }
const VERDICT = { support: '相符', partial: '部分相符', conflict: '不符' }

function Bar({ value }) {
  return <span className="mat-bar"><span style={{ width: `${Math.round((value ?? 0) * 100)}%` }} /></span>
}

function AxisRows({ axes }) {
  return <table className="mat-table"><thead><tr><th /><th>選區</th><th>地球</th><th>判定</th></tr></thead><tbody>
    {Object.entries(axes).map(([k, a]) => <tr key={k}>
      <th>{AXIS_LABEL[k] || k}</th>
      <td><Bar value={a.query} /><small>{Math.round(a.query * 100)}</small></td>
      <td><Bar value={a.earth} /><small>{Math.round(a.earth * 100)}</small></td>
      <td><span className={`mat-chip mat-${a.verdict}`}>{VERDICT[a.verdict]}</span></td>
    </tr>)}
  </tbody></table>
}

export function MaterialPanel({ data, activeId, onActive }) {
  const mat = data.material
  const [job, setJob] = useState(null)
  useEffect(() => {
    if (!mat?.fine_job) return undefined
    let stop = false
    let timer
    setJob(null)
    const poll = async () => {
      try {
        const r = await fetch(`/api/material/fine?job=${encodeURIComponent(mat.fine_job)}`)
        const b = await r.json()
        if (stop || !r.ok) return
        setJob(b)
        if (b.done < b.total) timer = setTimeout(poll, 2500)
      } catch { /* the inferred material stays on screen */ }
    }
    poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [mat?.fine_job])
  if (!mat) return null
  const q = mat.query
  const active = data.matches.find(m => m.id === activeId) || data.matches[0]
  const inf = active?.material_context
  const obs = job?.results?.[active?.id]
  const ev = mat.evaluation_summary && (getLanguage() === 'en' ? mat.evaluation_summary.en : mat.evaluation_summary.zh)
  return <section className="material-search-panel" aria-label="地形與材質比對">
    <div className="lavatube-head">
      <span className="micro-label">TERRAIN + MATERIAL / OCCLUSION-ROBUST INFERENCE</span>
      <h2>地形＋材質比對</h2>
      <p>排序同時看地形相似度與材質相似度（各半）。地球的材質不只看衛星影像：模型用地質岩性、乾燥度、氣候、土壤組成與附近已觀測地點推估，因此被植被、雲或積雪遮住的地方也能估計；看得到地面的候選再用 Sentinel-2 光譜實測確認。</p>
    </div>
    <div className="lavatube-grid">
      <div className="lavatube-card">
        <span className="micro-label">{q.body === 'mars' ? 'MARS / OMEGA + CRISM' : 'MOON / LUNAR PROSPECTOR + LROC WAC'}</span>
        <h3>選區的表面材質</h3>
        <table className="mat-table"><tbody>
          {Object.entries(q.axes).filter(([, v]) => v != null).map(([k, v]) => <tr key={k}><th>{AXIS_LABEL[k]}</th><td><Bar value={v} /><small>{Math.round(v * 100)}</small></td></tr>)}
          {q.body === 'mars' && <tr><th>{AXIS_LABEL.hydroxyl}</th><td>{q.hydrated ? '有含水礦物偵測' : '未偵測到'}</td></tr>}
        </tbody></table>
        {q.dusty && <p className="lavatube-caveat">此區表面被亮色含鐵沙塵覆蓋；底下岩石的鐵鎂程度由附近沒有沙塵的地區推估{q.inferred?.bedrock_mafic != null ? <>（{Math.round(q.inferred.bedrock_mafic * 100)}）</> : null}。</p>}
        <small>數值是該星球內的百分位（0＝最低，100＝最高），跨星球比較的是相對位置，不是絕對含量。地球端的鐵鎂程度來自地質圖（GLiM 基性岩比例），因為衛星光譜無法可靠量測。</small>
      </div>
      <div className="lavatube-card">
        <span className="micro-label">EARTH CANDIDATE / MATERIAL</span>
        <h3>{active?.name}</h3>
        <p>地形相似度 {active?.score} · 推估材質相似度 {inf?.similarity != null ? Math.round(inf.similarity * 100) : '—'}{obs?.state === 'observed' ? <> · 實測材質相似度 {Math.round(obs.similarity * 100)}</> : null}</p>
        {inf && <><h4>推估（地質＋氣候＋土壤＋鄰近觀測）</h4><AxisRows axes={inf.axes} />
          {inf.low_confidence ? <p className="lavatube-caveat">低信心：森林、冰雪或水體覆蓋 {Math.round(inf.occluding_cover * 100)}%，超出訓練資料範圍（{Math.round(inf.occluding_cover_limit * 100)}%），推估材質已降權。</p> : null}</>}
        {!job ? <p>正在讀取衛星光譜…</p> : obs?.state === 'observed'
          ? <><h4>Sentinel-2 實測（{obs.date}，地面可見 {Math.round((obs.fractions?.mineral || 0) * 100)}%）</h4><AxisRows axes={obs.axes} /></>
          : obs?.state === 'not_visible' ? <p>地面被遮蔽（植被 {Math.round((obs.fractions?.vegetation || 0) * 100)}%），以推估材質為準。</p>
          : obs ? <p>這個候選的衛星光譜暫時無法讀取，以推估材質為準。</p> : <p>正在讀取衛星光譜…</p>}
      </div>
    </div>
  </section>
}
