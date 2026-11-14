// i18n v2: display-string helpers from /i18n/static-i18n.js (identity fallback keeps the Chinese page working without it)
var __t = (typeof window !== 'undefined' && window.__t) || (s => s), __m = (typeof window !== 'undefined' && window.__m) || ((p, ...v) => p.map((x, i) => x + (i < v.length ? String(v[i]) : '')).join(''))
const steps = [
  {title:__t('取得地形'),copy:__t('由月球 LOLA／LROC、火星 MOLA／HRSC 或 Jezero／Olympus CTX 立體 DTM，以及地球 DEM 取得高程。每筆窗格記錄來源、原始解析度與有效像元；影像僅用於展示和獨立地質證據。'),evidence:__t('STATUS / 六份月球 LROC 與兩份火星 CTX DTM 已接入；高解析資料僅局部覆蓋。')},
  {title:__t('統一實際尺度'),copy:__t('將兩個世界的選區投影到相同的公尺座標，對齊窗格寬度與格網。比較 200 m 時，必須檢查兩側原生 DEM 是否真的足夠細。'),evidence:__t('QUALITY GATE / 200 m 月地用 5 m 格網，火地用 20 m；舊版 31.25 m 保留對照。')},
  {title:__t('轉為地貌特徵'),copy:__t('大尺度 TinyTerrainEncoder 把 DEM 編碼成 24 維向量；微地形有 55 維 geomorphon 共現基線，另訓練 30,024 參數、32 維 TinyMorphEncoder。'),evidence:__t('TRAINING / 小模型保留三處完整場址，只評估同窗格變換一致性，沒有跨天體專家真值。')},
  {title:__t('搜尋預建地球窗格'),copy:__t('地球窗格先離線建索引。微地形頁可選 2014 modified Wave-Hedges 或實驗小模型的向量餘弦，在同一高解析候選池粗排，再比較 D4 形狀。'),evidence:__t('SCOPE / 大尺度可作全球粗篩；小尺度目前只有八個約 3 km 地球研究區。')},
  {title:__t('精排與證據'),copy:__t('小尺度候選做八種旋轉與鏡像疊合。可選原本各窗格獨立正規化的形狀差，或補入起伏相近候選，再用中位高度對齊後的真實公尺 RMSE 精排；兩側採同一公尺格距。地球窗格另外顯示州地質圖單元相交比例、2024 年 30 m 土地覆蓋比例與 NASA POWER 區域氣候；氣候不參與排名；地質圖與土地覆蓋可用於選擇性排除雙重衝突窗格，但不改變幾何分數，實測岩性與跨天體專家真值仍缺。'),evidence:__t('EVALUATION / 真實高差只能修正幾何尺度錯配；人工評分已取消；目前仍無獨立跨天體窗格相關性標籤。')}
]
const buttons = [...document.querySelectorAll('[data-step]')]
function selectStep(index){
  const step = steps[index]
  document.getElementById('step-index').textContent = `${String(index+1).padStart(2,'0')} / 05`
  document.getElementById('step-title').textContent = step.title
  document.getElementById('step-copy').textContent = step.copy
  document.getElementById('step-evidence').textContent = step.evidence
  buttons.forEach((button,i)=>{button.classList.toggle('active',i===index);button.setAttribute('aria-selected',String(i===index));button.tabIndex=i===index?0:-1})
}
buttons.forEach((button,index)=>{
  button.addEventListener('click',()=>selectStep(index))
  button.addEventListener('keydown',event=>{
    if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return
    event.preventDefault()
    const next=(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length
    selectStep(next)
    buttons[next].focus()
  })
})
selectStep(0)

async function loadResearchRecord(){
  const set=(id,value)=>{document.getElementById(id).textContent=value}
  try{
    const result=await fetch('/technology/research/method_manifest.json',{cache:'no-cache'})
    if(!result.ok)throw new Error(`HTTP ${result.status}`)
    const record=await result.json(),model=record.tiny_morph,coverage=record.coverage,index=record.candidate_index
    set('record-model',__m`${model.parameter_count.toLocaleString('en-US')} 參數 · ${model.embedding_dimensions} 維向量`)
    set('record-evaluation',__m`${model.heldout_examples} 個保留窗格，整場址排除 ${model.heldout_site_ids.join('、')}；同窗格變換檢索 Recall@1 ${(model.same_window_recall_at_1*100).toFixed(1)}%、Recall@5 ${(model.same_window_recall_at_5*100).toFixed(1)}%。`)
    set('record-limits',__m`評估目標：${model.evaluation_target}。跨天體類比相關性：${model.cross_body_analog_relevance==null?__t('尚無專家標註'):__t('已有紀錄')}；材質模型驗證：${model.material_validation==null?__t('尚無可部署結果'):__t('已有紀錄')}。`)
    set('record-coverage',__m`${coverage.moon_reference_count} 份月球 LROC（${coverage.moon_3km_crop_count} 個 3 km 裁切） · ${coverage.mars_reference_count} 份火星 CTX（${coverage.mars_3km_crop_count} 個 3 km 裁切） · ${coverage.earth_site_count} 處地球`)
    set('record-index',__m`200／500／1000 m：月地候選 ${[200,500,1000].map(m=>index.rows_by_body_and_size[`earth_moon_${m}m`].toLocaleString('en-US')).join('／')} 個；火地候選數相同。兩種粗排共用同一候選池。`)
    const audit=record.development_audit
    set('record-audit',__m`${coverage.earth_site_count}區開發集、每模式 ${audit.top_five_results_per_comparison} 筆顯示結果：起伏比例超出 0.5–2 倍者，形狀模式 ${(audit.shape_relief_mismatch_fraction*100).toFixed(2)}%、真實高差模式 ${(audit.meter_relief_mismatch_fraction*100).toFixed(2)}%。月球純幾何結果中的雙重地表證據衝突為 ${audit.raw_moon_screen_conflicts} 筆，選用篩選後為 ${audit.screened_moon_conflicts} 筆。這些是開發集與規則效果，不是類比或材質準確率。`)
    const latency=record.public_latency_sample
    set('record-latency',__m`外網暖態搜尋樣本：${latency.sample_count} 次完整 HTTP 回應，中位數 ${latency.median_ms.toFixed(0)} ms、樣本 P95 ${latency.p95_ms.toFixed(0)} ms、最慢 ${latency.max_ms.toFixed(0)} ms。這只來自台灣一個用戶端與短時間量測，未包含 3D 貼圖、手機首屏或冷啟動，不能作服務保證。`)
    const material=record.material_pilot, auroc=material.held_site_aggregate_auroc
    set('record-material-pilot',__m`${material.parameters} 參數 · ${material.valid_specimens} 個有效標本 · 未部署`)
    set('record-material-evaluation',__m`整個野外地點留出後，第一輪聚合 AUROC：綠泥石 ${auroc.XRD_Chlorite_pct.toFixed(3)}、方解石 ${auroc.XRD_Calcite_pct.toFixed(3)}、白雲母 ${auroc.XRD_Muscovite_pct.toFixed(3)}。樣本只有 ${material.valid_specimens} 筆，方解石明顯失敗；這些跨折聚合數字不是族群準確率。`)
    set('record-version',__m`研究快照 ${new Date(record.generated_at_utc).toLocaleString(window.ATLAS_I18N?.lang==='en'?'en-US':'zh-TW',{timeZone:'Asia/Taipei'})}（台灣時間）；模型 SHA-256 ${model.model_sha256.slice(0,16)}… 。下方可下載完整來源報告與摘要雜湊。`)
  }catch(error){
    set('record-model',__t('研究紀錄暫時無法載入'))
    set('record-evaluation',__t('請使用下方原始 JSON 連結檢查模型與評估資料。'))
    set('record-coverage',__t('資料清單暫時無法載入'))
    set('record-index',__t('請使用下方索引 manifest。'))
    set('record-audit',__t('開發集稽核暫時無法載入。'))
    set('record-latency',__t('公開搜尋延遲樣本暫時無法載入。'))
    set('record-material-pilot',__t('材質研究紀錄暫時無法載入'))
    set('record-material-evaluation',__t('請使用下方凍結協定與第一次評估 JSON 查核。'))
    set('record-version',__m`無法載入版本化快照：${error.message}`)
  }
}
loadResearchRecord()
