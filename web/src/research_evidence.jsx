import React from 'react'
import { terrainDiagnostics } from './terrain_diagnostics.js'
import { getLanguage, translate } from './i18n/core.js'

export function evidenceRows(data, active) {
  const target = data.context_ranking?.target
  const condition = (key, label, enabled, value, source) => ({
    key, label, status: !enabled ? '未指定' : !Number.isFinite(value) ? '未知' : value >= (data.context_ranking?.minimum_each_evidence_share ?? .6) ? '支持' : '衝突',
    detail: !enabled ? '本次未指定此條件' : Number.isFinite(value) ? Math.round(value * 100) + '% 區域取樣格點符合指定條件' : '缺少此條件的有效資料',
    source,
  })
  return [
    target?.surface === 'mapped_dunes' ? condition('environment', '指定沙丘地域', true, active.context_match?.dune_positive_sample_share, 'Gunn 2026：0.1° 格網內記錄有沙丘；不等於沙地面積比例') : condition('environment', '指定地球環境', target?.surface === 'desert', active.context_match?.desert_sample_share, 'RESOLVE 生態區；不等於沙地'),
    condition('rock', '指定地球岩性', !!target?.rock && target.rock !== 'any', active.context_match?.rock_sample_share, 'GLiM 0.5° 區域圖；不等於裸露岩層'),
    { key: 'surface', label: '沙丘／裸岩／層理', status: '未知', detail: '尚無經驗證的同尺度跨星球分類', source: '不能由區域岩性或影像顏色推定' },
    { key: 'mission', label: '現場測試適用性', status: '未知', detail: '尚缺現場、力學與操作限制資料', source: '地形類比不等於工程安全' },
  ]
}

// English mode adds *_en display siblings; original fields and values are never replaced.
const englishCheck = c => ({key:c.key,label_en:translate(c.label,'en'),status_en:translate(c.status,'en'),detail_en:translate(c.detail,'en'),source_en:translate(c.source,'en')})
export function buildRunExport(data, activeId, time = new Date().toISOString()) {
  const target = data.context_ranking?.target || {surface:'any',rock:'any'}
  const params = new URLSearchParams({lat:data.window.lat,lon:data.window.lon,size_km:data.window.patch_km,surface:target.surface,rock:target.rock,purpose:data.purpose || 'morphology',limit:data.candidate_groups?.limit || 5})
  return {
    schema_version: 'twinground-run-v1', exported_utc: time,
    interpretation: 'Research screening; scores are not analog probabilities. Unknown is not a match.',
    active_candidate_id: activeId,
    replay_path: (data.window.body === 'mars' ? '/api/mars-search?' : '/api/search?') + new URLSearchParams({...Object.fromEntries(params),...(data.loaded_pages?.[0] || {offset:data.candidate_groups?.offset || 0})}),
    replay_pages: (data.loaded_pages || [{offset:data.candidate_groups?.offset || 0,limit:data.candidate_groups?.limit || 5}]).map(page=>(data.window.body === 'mars' ? '/api/mars-search?' : '/api/search?') + new URLSearchParams({...Object.fromEntries(params),...page})),
    model: {name:data.model,sha256:data.model_sha256},
    index_provenance: data.index_provenance || null,
    reference_coordinate_system: {body:data.window.body,latitude:'degrees north',longitude:'degrees east',note:'Planetary coordinates must not be interpreted as Earth WGS84.'},
    earth_coordinate_system: 'OGC:CRS84, longitude/latitude degrees',
    evidence: data.matches.map(row => getLanguage()==='en' ? {id:row.id,checks:evidenceRows(data,row),checks_en:evidenceRows(data,row).map(englishCheck)} : {id:row.id,checks:evidenceRows(data,row)}),
    ...(getLanguage()==='en' && target.rock_label ? {context_target_en: {rock_label_en: translate(target.rock_label, 'en')}} : {}),
    response: data,
  }
}

export function candidateGeoJSON(data) {
  return {type:'FeatureCollection',
    name:'TwinGround candidate centers',
    description:'Earth sampling footprints where source geometry is verified; otherwise center points. OGC:CRS84. Not surveyed site boundaries or validated analog sites.',
    features:data.matches.map(row => ({type:'Feature',id:row.id,geometry:row.sampling_footprint?.geometry || {type:'Point',coordinates:[row.center.longitude_east,row.center.latitude]},properties:{
      name:row.name,geometry_interpretation:row.sampling_footprint?.interpretation || 'Candidate center only; sampling boundary unavailable',index_sha256:data.index_provenance?.sha256 || null,source_product:row.sampling_footprint?.source_product || null,window_km:data.window.patch_km,geometry_cosine:row.cosine,
      joint_score:row.context_match?.fusion_score ?? null,model_sha256:data.model_sha256,
      source_url:row.source_url,source_resolution:row.resolution_note,...(getLanguage()==='en'?{source_resolution_en:translate(row.resolution_note,'en')}:{}),
      regional_rock:row.earth_lithology?.available ? row.earth_lithology.code : null,
      desert_sample_share:row.context_match?.desert_sample_share ?? null,
      rock_sample_share:row.context_match?.rock_sample_share ?? null,
      dune_positive_sample_share:row.mapped_dunes?.positive_sample_share ?? null,
      dune_source_sha256:row.mapped_dunes?.source_sha256 ?? null,
      dune_presence_interpretation:row.mapped_dunes?.interpretation ?? null,
      evidence_status:'unvalidated research candidate',
      eligibility_policy:row.sampling_support?.version || data.stored_dem_quality_gate?.version || null,
      stored_dem_sampling_support:row.sampling_support || null,
    }}))}
}
const cell = value => '"' + String(value ?? '').replace(/^[=+@\t\r]/, "'$&").replace(/"/g,'""') + '"'
export function candidateCSV(data) {
  const rows=[['id','name','longitude_east','latitude','window_km','geometry_cosine','joint_score','source_url','source_resolution','model_sha256','index_sha256','sampling_footprint_geojson','dune_positive_sample_share','dune_source_sha256','dune_interpretation']]
  for (const m of data.matches) rows.push([m.id,m.name,m.center.longitude_east,m.center.latitude,data.window.patch_km,m.cosine,m.context_match?.fusion_score,m.source_url,m.resolution_note,data.model_sha256,data.index_provenance?.sha256,JSON.stringify(m.sampling_footprint?.geometry ?? null),m.mapped_dunes?.positive_sample_share,m.mapped_dunes?.source_sha256,m.mapped_dunes?.interpretation])
  if (getLanguage()==='en') { rows[0].push('source_resolution_en'); data.matches.forEach((m,i)=>rows[i+1].push(translate(m.resolution_note,'en'))) }
  return rows.map(row => row.map(cell).join(',')).join('\r\n')
}
export function downloadText(name, content, type) {
  const url=URL.createObjectURL(new Blob([content],{type}))
  const link=document.createElement('a');link.href=url;link.download=name
  document.body.appendChild(link);link.click();link.remove()
  window.setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export function RunDownloads({data, activeId, onReport}) {
  const [format,setFormat]=React.useState('report')
  const save=()=>{
    if(format==='report') return onReport()
    const ext=format==='geojson'?'geojson':format
    const content=format==='csv'?candidateCSV(data):JSON.stringify(format==='json'?buildRunExport(data,activeId):candidateGeoJSON(data),null,2)
    downloadText('twinground-'+data.window.body+'-'+data.window.patch_km+'km.'+ext,content,format==='csv'?'text/csv;charset=utf-8':'application/json;charset=utf-8')
  }
  return <div className="run-downloads"><label className="sr-only" htmlFor="run-format">匯出格式</label><select id="run-format" value={format} onChange={e=>setFormat(e.target.value)}><option value="report">目前場址報告</option><option value="json">完整查詢 JSON</option><option value="geojson">候選範圍 GeoJSON</option><option value="csv">地球候選 CSV</option></select><button type="button" className="outline-button" onClick={save}>匯出</button></div>
}
export function TerrainDiagnostics({data,active}) {
  const a=terrainDiagnostics(data.window.terrain,data.window.patch_km),b=terrainDiagnostics(active.terrain,data.window.patch_km)
  if(!a||!b) return <p>地形量測資料不足。</p>
  const low=Math.min(...a.profile,...b.profile), high=Math.max(...a.profile,...b.profile),span=Math.max(high-low,1)
  const path=v=>v.map((h,i)=>(i?'L':'M')+(30+540*i/(v.length-1)).toFixed(2)+','+(170-130*(h-low)/span).toFixed(2)).join(' ')
  return <details className="terrain-diagnostics"><summary>地形剖面與坡度分布</summary>
    <p>使用搜尋時兩側的粗格網，未混用稍後載入的高解析度重建。剖面沿窗格中央由西向東，分別扣除各自高程中位數；不表示海拔基準相同。</p>
    <svg viewBox="0 0 600 205" role="img" aria-label={'中央剖面：長度'+data.window.patch_km+'公里；相對高程'+low.toFixed(0)+'至'+high.toFixed(0)+'公尺'}>
      <line x1="30" y1="170" x2="570" y2="170" stroke="#687c85"/><path d={path(a.profile)} fill="none" stroke="#dfb294" strokeWidth="2.5"/><path d={path(b.profile)} fill="none" stroke="#dedede" strokeWidth="2.5"/>
      <text x="30" y="195">0 km / 西</text><text x="490" y="195">{data.window.patch_km} km / 東</text><text x="30" y="22">相對高程 {low.toFixed(0)}～{high.toFixed(0)} m</text>
    </svg><div className="measurement-legend"><span>● {data.window.body==='mars'?'火星':'月球'}</span><span>● 地球</span></div>
    <table className="slope-table"><caption>坡度格點占比（相同 {a.spacing_m.toFixed(0)} m 分析格距）</caption><thead><tr><th>坡度</th><th>{data.window.body==='mars'?'火星':'月球'}</th><th>地球</th></tr></thead><tbody>{a.percent.map((v,i)=><tr key={i}><th>{a.edges[i]}–{a.edges[i+1]}°</th><td><span className="distribution-bar reference-measure" style={{width:v+'%'}}/>{v.toFixed(1)}%</td><td><span className="distribution-bar earth-measure" style={{width:b.percent[i]+'%'}}/>{b.percent[i].toFixed(1)}%</td></tr>)}</tbody></table><p>比例來自可計算中央差分的內部格點；解析度低於分析格距的來源仍受原生資料限制。這些量測不證明車輛可通行。</p>
  </details>
}
