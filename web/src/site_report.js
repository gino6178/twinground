import {translate,message,getLanguage} from './i18n/core.js'
const coord=(v,p,n)=>Math.abs(v).toFixed(1)+'°'+(v>=0?p:n)
const formatCoord=(lat,lon)=>coord(lat,'N','S')+' · '+coord(lon,'E','W')

export function marsImageryEvidence(query,imagery){
  if(query.body!=='mars'||imagery===undefined)return []
  const en=getLanguage()==='en'
  const title=en?'## Mars source imagery':'## 火星來源影像'
  const missing=imagery?.state==='loading'
    ?(en?'Metadata is loading; export again after it is available.':'來源資訊載入中；取得後可重新匯出。')
    :(en?'No verified imagery metadata is available for this query; no image or date is substituted.':'此查詢沒有可用的已核對影像資訊；不以其他影像或日期替代。')
  const samePosition=Number.isFinite(imagery?.lat)&&Number.isFinite(imagery?.lon)
    &&Math.abs(imagery.lat-query.lat)<=0.0000051
    &&Math.abs(((imagery.lon-query.lon+540)%360+360)%360-180)<=0.0000051
  if(!imagery?.available||imagery.body!=='mars'||!samePosition||imagery.size_km!==query.patch_km)
    return ['',title,'',`- ${missing}`]
  const source=imagery.source
  return ['',title,'',
    `- ${imagery.attribution} · ${source.license}`,
    `- ${en?'Source product':'來源產品'}: ${source.id}; ${source.url}`,
    `- SHA-256: ${source.sha256}`,
    `- ${en?'Projected valid pixels':'投影後有效影像格'}: ${(imagery.valid_fraction*100).toFixed(2)}%; ${en?'source grid / display spacing':'來源格距／顯示格距'}: ${source.source_grid_m[0].toFixed(2)} / ${imagery.display_spacing_m.toFixed(2)} m.`,
    ...(source.source_observations?.length?source.source_observations.flatMap(row=>[
      `- ${row.product_id}: ${row.start_utc} – ${row.stop_utc} (UTC); ${row.metadata_url}`,
      `  ${en?'ODE metadata SHA-256':'ODE 中繼資料 SHA-256'}: ${row.metadata_sha256}`,
    ]):[`- ${en?'Source observation dates are unknown.':'來源觀測日期未知。'}`]),
    en?'- Observation times describe the original stereo source images, not per-pixel orthomosaic dates or continuous observation between exposures. PDS ODE metadata was checked; embedded EDR labels were not independently checked.'
      :'- 觀測時間屬於原始立體影像對，不是正射影像逐像元日期，也不是兩次拍攝之間的連續觀測。已核對PDS ODE中繼資料，未獨立核對EDR內嵌標頭。',
    en?'- Missing pixels are not filled. Display uses per-window P2–P98 grayscale stretch; it does not identify material and does not affect ranking. Source-CRS reprojection does not validate physical image/DEM registration.'
      :'- 缺影像處未填補；展示採本窗格P2–P98灰階拉伸，不代表材質辨識，也不參與排序。依來源座標重投影不等於實地影像／DEM配準已驗證。',
  ]
}

// Conditions v1 dossier: condition table, testable activities, access and field season (language chosen at export).
function conditionsSection(active, data, env) {
  const en = getLanguage() === 'en', c = active.conditions, pick = t => (t ? (en ? t.en : t.zh) : '')
  if (!c?.available) return [en ? '- Conditions v1: not available for this candidate.' : '- 條件對照：此候選沒有資料。']
  const verdict = v => ({ 2: en ? 'match' : '相符', 1: en ? 'partial' : '部分', 0: en ? 'mismatch' : '不符' }[v] ?? (en ? 'no data' : '無資料'))
  const status = s => ({ yes: en ? 'yes' : '可測', partly: en ? 'partly' : '部分可測', no: en ? 'not suited' : '不建議' }[s])
  const months = Array.isArray(env?.temperature_monthly_c) ? env.temperature_monthly_c.map((t, i) => [i + 1, t, env.precipitation_monthly_mm_day?.[i]])
    .filter(([, t, p]) => Number.isFinite(t) && t >= -15 && t <= 35 && (!Number.isFinite(p) || p < 5)).map(([m]) => m) : null
  const a = c.access, s = data.conditions || {}
  return [
    '',
    en ? `## Conditions and site dossier (${c.rules})` : `## 條件對照與場址檔案（${c.rules}）`,
    '',
    en ? `- Query setting: ${pick(s.setting_text)}${s.unit?.code ? ` (${s.unit.code})` : ''}; ranking: ${s.ranking || '—'}.` : `- 查詢地：${pick(s.setting_text)}${s.unit?.code ? `（${s.unit.code}）` : ''}；排序：${s.ranking || '—'}。`,
    en ? `- Condition fit ${c.fit ?? '—'}: ${c.matched} match, ${c.partial} partial, ${c.mismatched} mismatch, ${c.unknown} no data.` : `- 條件符合度 ${c.fit ?? '—'}：相符 ${c.matched}、部分 ${c.partial}、不符 ${c.mismatched}、無資料 ${c.unknown}。`,
    ...c.rows.map(r => en ? `- ${pick(r.label)}: query ${pick(r.query)}; needs ${pick(r.need)}; candidate ${pick(r.earth)} -> ${verdict(r.verdict)}.`
      : `- ${pick(r.label)}：查詢地 ${pick(r.query)}；需要 ${pick(r.need)}；地球候選 ${pick(r.earth)} → ${verdict(r.verdict)}。`),
    '',
    en ? '### What can be tested here' : '### 能在這裡測什麼',
    '',
    ...c.tests.map(t => `- ${pick(t.label)}: ${status(t.status)}`),
    '',
    en ? '### Getting there' : '### 去不去得了',
    '',
    en ? `- Nearest major road ${a.road_km} km; nearest town ${a.place.name}, ${a.place.country} (${a.place.distance_km} km); nearest airport ${a.airport.name} (${a.airport.distance_km} km). ${a.source}; ${a.note}`
      : `- 最近主要道路 ${a.road_km} km；最近城鎮 ${a.place.name}，${a.place.country}（${a.place.distance_km} km）；最近機場 ${a.airport.name}（${a.airport.distance_km} km）。資料：${a.source}；只含主要道路。`,
    months ? (en ? `- Field months (NASA POWER monthly mean -15 to 35 C, rain < 5 mm/day): ${months.length ? months.join(', ') : 'none'}.` : `- 適合野外作業的月份（NASA POWER 月均溫 −15～35 °C、日雨量 < 5 mm）：${months.length ? months.map(m => `${m} 月`).join('、') : '無'}。`)
      : (en ? '- Field season: NASA POWER monthly climate not loaded.' : '- 野外季節：NASA POWER 每月氣候未載入。'),
    en ? '- Not assessed: protected-area status, radiation, landing safety.' : '- 尚未評估：保護區、輻射、登陸安全。',
  ]
}

export function candidateDossier({ data, active, rank, status, refinedCandidate, refineStatus, earthEnvironment, mineralMap, materialModel, marsImagery, origin = typeof window === "undefined" ? "" : window.location.origin, exportedAt = new Date().toISOString() }) {
  const isMars = data.window.body === 'mars'
  const names = [translate('高鈣輝石'), translate('低鈣輝石'), translate('橄欖石'), translate('斜長石')]
  const minerals = values => names.map((name, index) => message`${name} ${Number(values[index]).toFixed(1)} wt%`).join('；')
  const landforms = active.earth_landform_context
  const catalogLine = (item, kind) => item
    ? message`${kind}：最近已收錄中心 ${item.name}，距候選中心 ${item.distance_km} km；${item.within_search_radius ? translate('在查詢半徑內') : translate('不在查詢半徑內')}。這是目錄點位距離，不是本窗格的地貌標籤。`
    : message`${kind}：目錄資料未取得。`
  const climate = earthEnvironment?.available
    ? [
        message`- NASA POWER ${earthEnvironment.period} 原生格網：年均 2 m 氣溫 ${earthEnvironment.temperature_annual_c.toFixed(1)} °C；年均每日降水 ${earthEnvironment.precipitation_annual_mean_mm_day.toFixed(2)} mm/day；年均每日短波日照 ${earthEnvironment.solar_annual_mean_mj_m2_day.toFixed(1)} MJ/m²/day。`,
        message`- 格網來源：${earthEnvironment.source_grids.join(' + ')}。這是中心點的長期氣候背景，並非整個窗格的測量，也不參與排名。`,
        message`- POWER 原始請求：${earthEnvironment.source_data_url || earthEnvironment.source_url}`,
      ]
    : [message`- NASA POWER：${earthEnvironment ? earthEnvironment.reason || translate('未取得') : translate('載入中，請稍後重新下載')}；不以缺值推斷當地氣候。`]
  const lithology = active.earth_lithology?.available
    ? message`${active.earth_lithology.label}（${active.earth_lithology.code}）；取樣格點占比 ${(active.earth_lithology.sample_share * 100).toFixed(0)}%，GLiM 0.5° 區域圖層。這不是窗格級礦物含量。`
    : active.earth_lithology?.reason || translate('無區域岩性資料；不可當作缺乏礦物。')
  const published = isMars ? [translate('- 此火星參考區尚無本系統可比較的四礦物圖層。')] : [
    message`- Kaguya MI 已發表軌道反演圖：${mineralMap?.available ? message`${minerals(mineralMap.median_weight_percent)}；共同有效格點 ${(mineralMap.valid_fraction * 100).toFixed(0)}%；四個獨立中位數不必合計 100%` : mineralMap ? mineralMap.reason || translate('此窗格無圖層') : translate('載入中，請稍後重新下載')}。`,
    message`- 自建 ${materialModel?.parameters || '1,420'} 參數月球區域材質模型：${materialModel?.available ? message`${minerals(materialModel.estimated_weight_percent)}；${materialModel.grid_resolution_degrees}° 格網，格心距選點 ${materialModel.source_cell_center_offset_km.toFixed(1)} km` : materialModel ? materialModel.reason || translate('此處無可用估值') : translate('載入中，請稍後重新下載')}。模型以已發表 Kaguya 估值作弱標籤，不是現地真值或窗格內精細材質圖。`,
    translate('- 月球材質圖與研究模型均未進入地球地形排序。'),
  ]
  let queryUrl = (isMars
    ? message`/api/mars-search?lat=${data.window.lat}&lon=${data.window.lon}&size_km=${data.window.patch_km}`
    : message`/api/search?lat=${data.window.lat}&lon=${data.window.lon}&size_km=${data.window.patch_km}`) + message`&surface=${data.context_ranking?.target.surface || 'any'}&rock=${data.context_ranking?.target.rock || 'any'}&purpose=${data.purpose || 'morphology'}&limit=${data.loaded_pages?.[0]?.limit || data.candidate_groups?.limit || 5}&offset=${data.loaded_pages?.[0]?.offset || data.candidate_groups?.offset || 0}`
  if(data.global_visual) queryUrl += `&visual=${data.global_visual.mode || "complete"}`
  const refinedSource = refinedCandidate?.source
  return [
    message`# TwinGround 候選地點證據摘要：${active.name}`,
    '',
    message`- 匯出時間（UTC）：${exportedAt}`,
    message`- 候選 ID：${active.id}；本次排名：${rank}/${data.matches.length}`,
    message`- 參考窗格：${isMars ? translate('火星') : translate('月球')} ${formatCoord(data.window.lat, data.window.lon)}；${data.window.patch_km} × ${data.window.patch_km} km。`,
    message`- 地球候選中心：${formatCoord(active.center.latitude, active.center.longitude_east)}；OpenStreetMap：https://www.openstreetmap.org/#map=10/${active.center.latitude}/${active.center.longitude_east}`,
    '',
    translate('## 幾何檢索與重建'),
    '',
    message`- 模型：${data.model}；${status?.parameters || translate('未提供')} 參數；權重 SHA-256：${data.model_sha256 || status?.model_sha256 || translate('伺服器未提供')}。`,
    message`- 搜尋範圍：${data.search_scope}；同尺度預建窗格 ${data.searched_windows} 個。`,
    message`- 編碼器餘弦分數：${active.cosine.toFixed(4)}。這是幾何排序分數，不是類比成立機率。`,
    message`- 獨立 DEM 量測核對：${active.geometry_audit ? message`七分量未訓練特徵距離 ${active.geometry_audit.feature_distance.toFixed(3)}；參考／地球平均坡度 ${active.geometry_audit.reference_mean_slope_deg.toFixed(2)}°／${active.geometry_audit.earth_mean_slope_deg.toFixed(2)}°；相鄰像元粗糙度 P90 ${active.geometry_audit.reference_roughness_p90_m.toFixed(1)}／${active.geometry_audit.earth_roughness_p90_m.toFixed(1)} m` : translate('舊版伺服器未提供')}。同尺度粗格網診斷，不參與神經排序，也不是類比機率。`,
    getLanguage()==='en' ? `- Earth screening DEM: ${active.dataset_label}; ${translate(active.resolution_note)}; index validity statistic ${(active.valid_fraction*100).toFixed(1)}%; source ${active.source_url}. This is not a live native-pixel coverage measurement.` : `- 地球粗篩高程：${active.dataset_label}；${active.resolution_note}；索引有效比例記錄 ${(active.valid_fraction*100).toFixed(1)}%；來源 ${active.source_url}。此值不是即時計算的原始像元覆蓋率。`,
    ...(data.stored_dem_quality_gate ? [getLanguage()==='en' ? `- Stored local DEM eligibility: ${data.stored_dem_quality_gate.excluded_local_windows}/${data.stored_dem_quality_gate.checked_local_windows} local windows excluded for missing source pixels or edge clamping. Policy: ${data.stored_dem_quality_gate.version}.` : `- 舊局部DEM篩選：${data.stored_dem_quality_gate.checked_local_windows}個窗格中，${data.stored_dem_quality_gate.excluded_local_windows}個因來源缺值或邊界裁切而排除。規則版本：${data.stored_dem_quality_gate.version}。`] : []),
    ...(data.global_dem_quality_gate ? [getLanguage()==='en' ? `- Stored global ETOPO eligibility: ${data.global_dem_quality_gate.excluded_global_windows}/${data.global_dem_quality_gate.checked_global_windows} windows excluded. Policy: ${data.global_dem_quality_gate.version}; audit SHA256: ${data.global_dem_quality_gate.audit_sha256}. Stored pixels and bounds only; original sensor coverage, geolocation and terrain material are not validated.` : `- 全球ETOPO篩選：${data.global_dem_quality_gate.checked_global_windows}個窗格中排除${data.global_dem_quality_gate.excluded_global_windows}個。規則版本：${data.global_dem_quality_gate.version}；稽核SHA256：${data.global_dem_quality_gate.audit_sha256}。僅核對儲存像元及邊界，未驗證原始感測器覆蓋率、定位或地表材質。`] : []),
    message`- 地球高解析重建：${refinedCandidate ? message`${refinedSource?.dataset || 'Copernicus GLO-90'}；${refinedSource?.resolution_note || translate('約 90 m')}；來源 ${refinedSource?.source_url || translate('未提供')}。` : refineStatus === 'loading' || !refineStatus ? translate('載入中；請稍後重新下載。') : translate('未取得，畫面使用粗篩格網。')} 高解析重建不改變粗篩排名。`,
    ...(refinedSource?.attribution ? [
      `- ${refinedSource.attribution}`,
      `- ${getLanguage()==='en'?'Copernicus licence and citation':'Copernicus 授權與引用'}: ${refinedSource.license_url}`,
      getLanguage()==='en' ? `- Processing: ${refinedSource.modifications}` : '- 處理方式：窗格裁切、雙線性重取樣及已揭露的最近高程接縫補值；顯示網格可能使用相對高程與垂直放大。',
    ] : []),
    message`- 參考／地球顯示網格 P90–P10 高程起伏：${data.window.terrain.relief_m.toFixed(1)}／${(refinedCandidate?.terrain || active.terrain).relief_m.toFixed(1)} m；視覺垂直比例經放大。`,
    message`- 索引版本：${data.index_provenance?.sha256 || translate('未提供')}`,
    message`- 已載入分頁（相同查詢搭配 offset／limit 重現）：${JSON.stringify(data.loaded_pages || [])}`,
    ...(data.global_visual ? [`- Global visual index / ranking: ${JSON.stringify(data.global_visual)}`, `- Candidate image sample: ${JSON.stringify(active.visual_similarity || null)}`] : []),
    (getLanguage()==='en' && data.context_ranking?.target?.rock_label ? message`- 聯合評分設定（rock_label 以英文顯示）：${JSON.stringify({...data.context_ranking, target: {...data.context_ranking.target, rock_label: translate(data.context_ranking.target.rock_label, 'en')}})}` : message`- 聯合評分設定：${JSON.stringify(data.context_ranking || null)}`),
    message`- 參考高程來源：${isMars ? data.mars_reference?.source_page || 'USGS MOLA/HRSC' : status?.source_moon || 'https://svs.gsfc.nasa.gov/4720/'}。此處「重建」是 DEM 網格化視圖，不是獨立的高解析攝影測量。`,
    ...(isMars ? [] : [message`- 月球視覺材質：NASA SVS LROC color mosaic（https://svs.gsfc.nasa.gov/4720/），有覆蓋的位置加入 LROC WAC 643 nm 局部亮度細節（https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_HAPKE）。它是軌道反射影像，不是礦物比例。`]),
    message`- 地球視覺材質：Esri World Imagery（https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer）；提供者 Esri、Vantor／Maxar、Earthstar Geographics 與 GIS User Community。影像日期、原生解析度及感測器可隨地點改變。`,
    translate('- Skyfall-GS 的多視角衛星影像 3D Gaussian Splatting 與擴散精修尚未對本候選訓練；目前視圖是衛星影像貼合 DEM，不是已驗證的 3DGS 場景。'),
    '',
    ...marsImageryEvidence(data.window,marsImagery),
    translate('## 地貌與材質脈絡'),
    '',
    message`- 地球已發表沙丘分布：${active.mapped_dunes?.available ? message`${Math.round(active.mapped_dunes.positive_sample_share*100)}% 的 3×3 取樣點落在已記錄有沙丘的0.1°格網；SHA-256 ${active.mapped_dunes.source_sha256}；來源 ${active.mapped_dunes.source_url}` : translate('此快照沒有資料')}。不代表沙地面積比例；未記錄不等於已證實沒有沙丘。`,
    message`- 地球 GLiM 區域岩性：${lithology}`,
    message`- ${catalogLine(landforms?.impact, translate('撞擊構造目錄'))}`,
    message`- ${catalogLine(landforms?.caldera, translate('破火山口目錄'))}`,
    message`- ${catalogLine(landforms?.holocene_volcano, translate('GVP 全新世火山目錄'))} ${landforms?.holocene_volcano?.within_search_radius && landforms.holocene_volcano.major_rock_type ? message`該火山紀錄的主要岩類為 ${landforms.holocene_volcano.major_rock_type}；不代表整個候選窗格的材質。` : ''}`,
    ...(isMars ? [message`- 火星參考區：${data.mars_reference?.name || data.window.site_id}；目前沒有跨星球專家類比標籤。`] : [
      message`- 月球中心坑形態模型：${data.moon_crater_center?.available ? message`${data.moon_crater_center.model_parameters} 參數／${data.window.patch_km} km 窗格／目標坑徑 ${data.moon_crater_center.target_diameter_km} km；${data.moon_crater_center.label}；平衡抽樣形態指數 ${(data.moon_crater_center.score * 100).toFixed(0)}/100` : data.moon_crater_center?.reason || translate('此尺度沒有結果')}。不是任意地點有坑機率，不參與地球排名。`,
      ...(data.moon_crater_center?.external_lunar_validation ? [message`- 月球中心坑形態外部評估：${data.moon_crater_center.external_lunar_validation.sites} 個地點的場址平均 AUROC ${data.moon_crater_center.external_lunar_validation.site_mean_auroc.toFixed(3)}；權重 SHA-256 ${data.moon_crater_center.model_sha256}。這不是地月類比或材質準確率。`] : []),
      message`- USGS 月球地質單元：${data.moon_geology?.available ? message`${data.moon_geology.dominant_unit.code}／${data.moon_geology.dominant_unit.description}；圖示時期 ${data.moon_geology.dominant_unit.period}` : translate('資料不足')}。這是區域地質圖，不是窗格內逐像元材質。`,
      message`- 月球區域 FeO／Ti：${data.moon_geochemistry?.available ? message`${data.moon_geochemistry.feo_weight_percent.toFixed(2)}／${data.moon_geochemistry.titanium_weight_percent.toFixed(2)} wt%` : translate('資料不足')}；這些元素估值與四礦物比例不同。`,
    ]),
    ...published,
    translate('- 地球四礦物窗格向量：目前沒有可靠的地理定位真值與可比較模型輸出；材質相似度未計算，不能把未知值當零。'),
    '',
    translate('## 地球環境背景'),
    '',
    ...climate,
    ...conditionsSection(active, data, earthEnvironment),
    '',
    translate('## 重現與判讀限制'),
    '',
    message`- 查詢同一參考窗格：${origin}${queryUrl}`,
    message`- 模型轉移狀態：${data.model_transfer_status}。`,
    translate('- 目前沒有此地月候選對的獨立專家真值；需以地質圖、原始影像及現地資料進一步核對。'),
    translate('- Copernicus GLO-90 為地表高程，可能包含植被、建物、水面與填補；月球 LOLA 與地球高程的量測物理不同。'),
    message`- GLiM 來源：${active.earth_lithology?.source_url || 'https://doi.org/10.1594/PANGAEA.788537'}；撞擊目錄：${landforms?.source_impact || 'https://impact.uwo.ca/impact-craters/map/'}；GVP 火山與破火山口目錄：${landforms?.source_holocene_volcano || landforms?.source_caldera || 'https://volcano.si.edu/database/webservices.cfm'}。GLiM 的 0.5° 格子與 GVP 的火山點位尺度不同，兩者可同時成立，不宜以區域岩性推斷局部火山材質。`,
    ...(isMars ? [] : [message`- Kaguya MI 四礦物來源：${mineralMap?.source_url || 'https://astrogeology.usgs.gov/search/map/lunar-kaguya-multiband-imager-mosaics'}。`]),
    '',
  ].join('\n')
}

