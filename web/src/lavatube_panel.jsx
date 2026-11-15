import React, { useEffect, useState } from 'react'
import { getLanguage } from './i18n/core.js'

// PitChain-C2F v2: coarse = basaltic-volcano gate + self-trained terrain encoder; fine = F-Net v2 pit/skylight
// detection on the query's own NAC/HiRISE image and lidar pit detection on Earth candidates where 1 m lidar is held.
export function LavaTubePanel({ data, activeId, onActive }) {
  const lt = data.lavatube
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!lt?.fine_job) return undefined
    let stop = false
    let timer
    setJob(null); setError(null)
    const poll = async () => {
      try {
        const response = await fetch(`/api/lavatube/fine?job=${encodeURIComponent(lt.fine_job)}`)
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || String(response.status))
        if (stop) return
        setJob(body)
        if (!body.query_done || body.done < body.total) timer = setTimeout(poll, 2000)
      } catch (e) {
        if (!stop) setError(String(e.message || e))
      }
    }
    poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [lt?.fine_job])
  if (!lt) return null
  const active = data.matches.find(m => m.id === activeId) || data.matches[0]
  const volcano = active?.lavatube_context
  const earth = job?.earth?.[active?.id]
  const q = job?.query_fine
  const ev = lt.evaluation_summary && (getLanguage() === 'en' ? lt.evaluation_summary.en : lt.evaluation_summary.zh)
  return <section className="lavatube-panel" aria-label="熔岩管兩階段檢索">
    <div className="lavatube-head">
      <div>
        <span className="micro-label">PITCHAIN-C2F v2 / TWO-STAGE SEARCH</span>
        <h2>熔岩管／天窗坑兩階段檢索</h2>
        <p>粗檢索：先篩出距離玄武岩全新世火山 {lt.coarse?.gate_km} km 內的地球窗格（熔岩管只在低黏度玄武岩熔岩中形成），再以自訓練的跨星球地形編碼器排序。細檢索：以自訓練的 F-Net v2 在查詢點的 NAC／HiRISE 影像上偵測天窗坑，並在有 1 m 光達的地球候選上列出崩塌坑。</p>
      </div>
    </div>
    {error && <p className="lavatube-error">細檢索暫時無法完成：{error}</p>}
    <div className="lavatube-grid">
      <div className="lavatube-card">
        <span className="micro-label">QUERY / {q ? q.image : 'NO HIGH-RES IMAGE'}</span>
        <h3>查詢點的天窗坑偵測</h3>
        {!job?.query_done ? <p>正在偵測…</p> : q
          ? <><img src={`/api/lavatube/overlay?id=${encodeURIComponent(q.overlay)}`} alt="查詢點附近的天窗坑偵測圖" width="480" height="480" loading="lazy" />
            <p>{q.area_km2} km² 範圍內偵測到 {q.pit_count} 個坑／天窗候選（{q.res_m} m 解析度，樣區 {q.site}）。紅圈是機率最高的偵測。</p>
            {q.split === 'train' ? <p className="lavatube-caveat">此影像樣區曾用於訓練 F-Net v2，這裡只作展示；盲測成績見下方評估摘要。</p>
              : q.split === 'test_zeroshot' ? <p className="lavatube-caveat">火星資料完全沒有參與訓練（零樣本），結果僅供參考。</p> : null}</>
          : <p>查詢點附近沒有我們持有的 NAC／HiRISE 高解析影像，這一步略過；可改選 NASA 介紹過的天窗坑位置。</p>}
      </div>
      <div className="lavatube-card">
        <span className="micro-label">EARTH CANDIDATE / VOLCANIC CONTEXT</span>
        <h3>{active?.name}</h3>
        {volcano && <p>最近的玄武岩全新世火山：<a href={volcano.url} target="_blank" rel="noreferrer">{volcano.name}</a>（{volcano.type}），距離 {volcano.distance_km} km{volcano.distance_km <= (lt.coarse?.gate_km || 60) ? '，在火山背景範圍內。' : '，超出火山背景範圍。'}</p>}
        <p>地形相似度：{active?.score}</p>
        {!job ? <p>正在檢查高解析資料…</p> : earth?.overlay
          ? <><img src={`/api/lavatube/overlay?id=${encodeURIComponent(earth.overlay)}`} alt="地球候選的光達崩塌坑偵測圖" width="480" height="480" loading="lazy" />
            <p>USGS 3DEP 1 m 光達在 {earth.area_km2} km² 內偵測到 {earth.pit_count} 個崩塌坑（深徑比 ≥ 0.25）。</p></>
          : earth?.error ? <p>高解析資料讀取失敗。</p>
          : <p>這個候選沒有我們持有的 1 m 光達，細檢索只顯示火山背景與地形相似度。</p>}
      </div>
    </div>
  </section>
}
