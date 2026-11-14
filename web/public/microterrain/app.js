// i18n v2: display-string helpers from /i18n/static-i18n.js (identity fallback keeps the Chinese page working without it)
var __t = (typeof window !== 'undefined' && window.__t) || (s => s), __m = (typeof window !== 'undefined' && window.__m) || ((p, ...v) => p.map((x, i) => x + (i < v.length ? String(v[i]) : '')).join(''))
const $ = id => document.getElementById(id)
let metadata = null, mapData = null, response = null, selected = 0
let site = 'MARIUS3', size = 500, east = 0, north = 0, mode = 'native', ranker = 'geomorphon', comparison = 'meter', overlayMode = 'shared', evidenceFilter = 'screen'
let coverageBody = 'moon', coverageZoom = 1, marsRegionParent = 'JEZERO_HIRISE_023524', moonRegionParent = 'MARIUS3'
function bodyName(body){return body === 'mars' ? __t('火星') : __t('月球')}
function coordinates(lat,lon){return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}°${lon < 0 ? 'W' : 'E'}`}

function color(t, theme='gray') {
  const x = Math.max(0, Math.min(1, (t + 1.4) / 2.8))
  if (theme === 'moon') return [Math.round(20 + 95*x), Math.round(40 + 205*x), Math.round(51 + 183*x)]
  if (theme === 'mars') return [Math.round(70 + 160*x), Math.round(33 + 127*x), Math.round(25 + 88*x)]
  if (theme === 'earth') return [Math.round(67 + 185*x), Math.round(33 + 185*x), Math.round(18 + 107*x)]
  const c = Math.round(25 + 225*x); return [c,c,c]
}
function paint(id, grid, theme='gray') {
  const canvas = $(id), ctx = canvas.getContext('2d'), h=grid.length, w=grid[0].length
  const img = ctx.createImageData(w,h)
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=(y*w+x)*4, rgb=color(grid[y][x],theme)
    img.data[i]=rgb[0];img.data[i+1]=rgb[1];img.data[i+2]=rgb[2];img.data[i+3]=255
  }
  const buffer=document.createElement('canvas');buffer.width=w;buffer.height=h
  buffer.getContext('2d').putImageData(img,0,0)
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=false
  ctx.drawImage(buffer,0,0,canvas.width,canvas.height)
}
function drawMap() {
  if(!mapData) return
  paint('map',mapData.grid)
  const ctx=$('map').getContext('2d'), px=$('map').width
  const side=size/3000*px, cx=(east/3000+.5)*px, cy=(.5-north/3000)*px
  ctx.strokeStyle='#82f0d2';ctx.lineWidth=3;ctx.strokeRect(cx-side/2,cy-side/2,side,side)
  ctx.fillStyle='#7df2cf3d';ctx.fillRect(cx-side/2,cy-side/2,side,side)
}
async function json(url) {const r=await fetch(url);const data=await r.json();if(!r.ok)throw Error(data.error||__t('資料載入失敗'));return data}
function coverageRows(){return coverageBody==='mars'?metadata.mars_sites:metadata.moon_sites}
function tileParent(id){return id?.includes('_FREE_E')?id.split('_FREE_E')[0]:[...(metadata?.mars_tiles||[]),...(metadata?.moon_tiles||[])].find(row=>row.id===id)?.tile_parent_id||id}
function freeOffset(id){const match=id?.match(/_FREE_E(-?\d+)_N(-?\d+)$/);return match?[Number(match[1]),Number(match[2])]:null}
function addFreeSiteOption(id,body,center){
  if([...$('site').options].some(option=>option.value===id))return
  let group=$('free-select-group')
  if(!group){group=document.createElement('optgroup');group.id='free-select-group';group.label=__t('原始 DTM 自由選框');$('site').appendChild(group)}
  const option=document.createElement('option');option.value=id
  option.textContent=`${bodyName(body)} · ${tileParent(id)} · ${center?coordinates(...center):__t('按需裁切')}`
  group.appendChild(option)
}
function regionalCurrent(rows,parent){
  const listed=rows.find(row=>row.id===site)
  if(listed)return listed
  const offset=freeOffset(site)
  if(offset&&tileParent(site)===parent&&mapData)return {label:$('site').selectedOptions[0]?.textContent||__t('原始 DTM 自由選框'),center_lat_lon:mapData.center_lat_lon,tile_offset_east_north_m:offset}
  return rows[0]
}
function renderRegionalSelection(body){
  const parent=body==='moon'?moonRegionParent:marsRegionParent
  const map=$(body==='moon'?'moon-tile-map':'mars-tile-map')
  map.querySelector('.regional-selection')?.remove()
  if(!metadata||tileParent(site)!==parent)return
  const overview=metadata[body==='moon'?'moon_overviews':'mars_overviews']?.[parent]
  const row=[...(body==='moon'?metadata.moon_sites:metadata.mars_sites),
    ...(body==='moon'?metadata.moon_tiles:metadata.mars_tiles)].find(item=>item.id===site)
  if(!overview||(!row&&!freeOffset(site)))return
  const [tileEast,tileNorth]=row?.tile_offset_east_north_m||freeOffset(site)||[0,0]
  const x=tileEast+east,y=tileNorth+north
  const box=document.createElement('div');box.className='regional-selection';box.setAttribute('aria-hidden','true')
  box.style.left=`${100*(x-overview.west_m)/(overview.east_m-overview.west_m)}%`
  box.style.top=`${100*(overview.north_m-y)/(overview.north_m-overview.south_m)}%`
  box.style.width=`${100*size/(overview.east_m-overview.west_m)}%`
  box.style.height=`${100*size/(overview.north_m-overview.south_m)}%`
  map.appendChild(box)
}
function syncCoverageSize(){
  const view=$('coverage-map'),content=$('coverage-content')
  content.style.width=`${view.clientWidth*coverageZoom}px`
  content.style.height=`${view.clientHeight*coverageZoom}px`
  $('coverage-zoom-label').textContent=`${coverageZoom}×`
}
function centerCoverage(row){
  if(!row)return
  const view=$('coverage-map'),lon=((Number(row.center_lat_lon[1])+180)%360+360)%360-180
  view.scrollLeft=(lon+180)/360*view.scrollWidth-view.clientWidth/2
  view.scrollTop=(90-Number(row.center_lat_lon[0]))/180*view.scrollHeight-view.clientHeight/2
}
function renderCoverage(){
  if(!metadata)return
  const image=$('coverage-image');image.src=coverageBody==='mars'?'/mars-viking.jpg':'/moon-color.webp'
  image.alt=coverageBody==='mars'?__t('火星全球 Viking 影像'):__t('月球全球 LRO 影像')
  document.querySelectorAll('[data-coverage-body]').forEach(button=>button.classList.toggle('active',button.dataset.coverageBody===coverageBody))
  $('coverage-pins').replaceChildren()
  coverageRows().forEach(row=>{
    const [lat,sourceLon]=row.center_lat_lon,lon=((Number(sourceLon)+180)%360+360)%360-180
    const pin=document.createElement('button');pin.type='button';pin.className=`coverage-pin${row.id===tileParent(site)?' active':''}${(lon+180)/360>.65?' edge-right':''}`
    pin.style.left=`${(lon+180)/360*100}%`;pin.style.top=`${(90-Number(lat))/180*100}%`
    pin.setAttribute('aria-label',__m`${row.label}，${coordinates(Number(lat),lon)}，原始 DEM 格距約 ${row.source_resolution_m} 公尺`)
    const label=document.createElement('span');label.textContent=__t(row.label);pin.appendChild(label)
    pin.addEventListener('click',async()=>{$('site').value=row.id;await changeSite();setMapView('local');document.querySelector('.map-workspace').scrollIntoView({behavior:'smooth',block:'start'})})
    $('coverage-pins').appendChild(pin)
  })
  syncCoverageSize()
  $('coverage-caption').textContent=coverageBody==='mars'?__m`全球圖標出 ${metadata.mars_sites.length} 份火星立體高程來源（HiRISE 1 m 與 CTX）；下方可選 ${(metadata.mars_tiles||[]).length+metadata.mars_sites.length} 個已建立的 3 km 裁切中心。點外區域仍不能視為可搜尋。`:__m`全球圖標出六份 LROC 來源的研究錨點；下方可選 ${(metadata.moon_tiles||[]).length+6} 個已建立的 3 km 高解析裁切中心。點外區域仍不能視為可搜尋。`
  renderMoonRegion()
  renderMarsRegion()
}
function renderMoonRegion(){
  const panel=$('moon-region');panel.classList.toggle('hidden',coverageBody!=='moon')
  if(coverageBody!=='moon'||!metadata)return
  const actions=$('moon-parent-actions')
  if(!actions.children.length)metadata.moon_sites.forEach(row=>{
    const button=document.createElement('button');button.type='button';button.dataset.moonParent=row.id
    button.textContent=__t(row.label.split(' · ')[0]);actions.appendChild(button)
  })
  actions.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.moonParent===moonRegionParent))
  const parent=metadata.moon_sites.find(row=>row.id===moonRegionParent)
  const rows=[{...parent,tile_offset_east_north_m:[0,0]},...(metadata.moon_tiles||[]).filter(row=>row.tile_parent_id===moonRegionParent)]
  const east=rows.map(row=>Number(row.tile_offset_east_north_m[0])),north=rows.map(row=>Number(row.tile_offset_east_north_m[1]))
  const minE=Math.min(...east),maxE=Math.max(...east),minN=Math.min(...north),maxN=Math.max(...north)
  const map=$('moon-tile-map'),overview=metadata.moon_overviews?.[moonRegionParent]
  map.replaceChildren()
  if(overview){
    map.style.aspectRatio=`${overview.east_m-overview.west_m}/${overview.north_m-overview.south_m}`
    const image=document.createElement('img');image.src=`${overview.url}?v=${overview.sha256.slice(0,12)}`
    image.alt=__m`${parent.label} LROC DEM 相對高程及地形陰影；透明處沒有有效高程`
    map.appendChild(image)
  }
  rows.forEach(row=>{
    const [x,y]=row.tile_offset_east_north_m,button=document.createElement('button')
    button.type='button';button.className=`regional-tile${row.id===site?' active':''}`
    button.style.left=`${overview?100*(x-overview.west_m)/(overview.east_m-overview.west_m):6+88*(x-minE)/Math.max(maxE-minE,1)}%`
    button.style.top=`${overview?100*(overview.north_m-y)/(overview.north_m-overview.south_m):6+88*(maxN-y)/Math.max(maxN-minN,1)}%`
    button.setAttribute('aria-label',__m`${row.label}，${coordinates(...row.center_lat_lon)}，3 公里 LROC 高程裁切`)
    button.title=__t(row.label)
    button.addEventListener('click',async()=>{$('site').value=row.id;await changeSite();setMapView('local');document.querySelector('.map-workspace').scrollIntoView({behavior:'smooth',block:'start'})})
    map.appendChild(button)
  })
  $('moon-axis').textContent=__m`原始 DTM 外接範圍：東西 ${(overview?.west_m/1000).toFixed(1)}～${(overview?.east_m/1000).toFixed(1)} km、南北 ${(overview?.south_m/1000).toFixed(1)}～${(overview?.north_m/1000).toFixed(1)} km；${rows.length} 個預建 3 km 裁切中心。`
  const current=regionalCurrent(rows,moonRegionParent)
  $('moon-tile-detail').textContent=__m`目前選擇：${current.label}，${coordinates(...current.center_lat_lon)}。${current.native_grid_valid_fraction!=null?__m`此 3 km 的 5 m 比較格網有效像元 ${(current.native_grid_valid_fraction*100).toFixed(2)}%。`:freeOffset(site)?__t('此方框直接從原始 DTM 取樣並檢查有效。'):__t('原始錨點已有可搜尋的 5 m 格網。')} 可點另一個位置移動整個 3 km 研究裁切。`
  renderRegionalSelection('moon')
}
function renderMarsRegion(){
  const panel=$('mars-region');panel.classList.toggle('hidden',coverageBody!=='mars')
  if(coverageBody!=='mars'||!metadata)return
  const actions=$('mars-parent-actions')
  if(!actions.children.length)metadata.mars_sites.forEach(row=>{
    const button=document.createElement('button');button.type='button';button.dataset.marsParent=row.id
    button.textContent=row.id.startsWith('JEZERO_HIRISE')?'Jezero HiRISE 1 m':__t(row.label.split(' · ')[0])+' CTX'
    actions.appendChild(button)
  })
  actions.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.marsParent===marsRegionParent))
  const parent=metadata.mars_sites.find(row=>row.id===marsRegionParent)
  const rows=[{...parent,tile_offset_east_north_m:[0,0]},...(metadata.mars_tiles||[]).filter(row=>row.tile_parent_id===marsRegionParent)]
  const east=rows.map(row=>Number(row.tile_offset_east_north_m[0])),north=rows.map(row=>Number(row.tile_offset_east_north_m[1]))
  const minE=Math.min(...east),maxE=Math.max(...east),minN=Math.min(...north),maxN=Math.max(...north)
  const map=$('mars-tile-map'),overview=metadata.mars_overviews?.[marsRegionParent]
  map.replaceChildren()
  if(overview){
    map.style.aspectRatio=`${overview.east_m-overview.west_m}/${overview.north_m-overview.south_m}`
    const image=document.createElement('img');image.src=`${overview.url}?v=${overview.sha256.slice(0,12)}`
    image.alt=__m`${parent.label} DEM 相對高程及地形陰影；透明處沒有有效高程`
    map.appendChild(image)
  }
  rows.forEach(row=>{
    const [x,y]=row.tile_offset_east_north_m,button=document.createElement('button')
    button.type='button';button.className=`regional-tile${row.id===site?' active':''}`
    button.style.left=`${overview?100*(x-overview.west_m)/(overview.east_m-overview.west_m):6+88*(x-minE)/Math.max(maxE-minE,1)}%`
    button.style.top=`${overview?100*(overview.north_m-y)/(overview.north_m-overview.south_m):6+88*(maxN-y)/Math.max(maxN-minN,1)}%`
    button.setAttribute('aria-label',__m`${row.label}，${coordinates(...row.center_lat_lon)}，3 公里高程裁切`)
    button.title=__t(row.label)
    button.addEventListener('click',async()=>{$('site').value=row.id;await changeSite();setMapView('local');document.querySelector('.map-workspace').scrollIntoView({behavior:'smooth',block:'start'})})
    map.appendChild(button)
  })
  $('mars-axis').textContent=__m`${marsRegionParent==='JEZERO_HIRISE_023524'?__t('保存的 HiRISE 3 km 裁切'):__t('原始 CTX DTM 外接範圍')}：東西 ${(overview?.west_m/1000).toFixed(1)}～${(overview?.east_m/1000).toFixed(1)} km、南北 ${(overview?.south_m/1000).toFixed(1)}～${(overview?.north_m/1000).toFixed(1)} km；${rows.length} 個預建 3 km 裁切中心。`
  const current=regionalCurrent(rows,marsRegionParent)
  $('mars-tile-detail').textContent=__m`目前選擇：${current.label}，${coordinates(...current.center_lat_lon)}。${current.native_grid_valid_fraction!=null?__m`此 3 km 的 ${marsRegionParent==='JEZERO_HIRISE_023524'?'4':'20'} m 比較格網有效像元 ${(current.native_grid_valid_fraction*100).toFixed(2)}%。`:freeOffset(site)?__t('此方框直接從原始 DTM 取樣並檢查有效。'):__t('原始錨點已有可搜尋格網。')} 可點另一個位置移動方框；只有全框有效才會通過。`
  renderRegionalSelection('mars')
}
async function chooseRegionalPoint(body,event){
  if(event.target.closest('.regional-tile'))return
  const parent=body==='moon'?moonRegionParent:marsRegionParent
  const overview=metadata?.[body==='moon'?'moon_overviews':'mars_overviews']?.[parent]
  if(!overview)return
  const box=event.currentTarget.getBoundingClientRect()
  const x=Math.max(0,Math.min(1,(event.clientX-box.left)/box.width))
  const y=Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))
  const desiredEast=overview.west_m+x*(overview.east_m-overview.west_m)
  const desiredNorth=overview.north_m-y*(overview.north_m-overview.south_m)
  $('status').textContent=__t('檢查選區的原生 DEM 有效像元…')
  try{
    const query=new URLSearchParams({parent,size_m:size,east_m:desiredEast.toFixed(1),north_m:desiredNorth.toFixed(1)})
    const resolved=await json(`/api/microterrain/resolve-window?${query}`)
    if(mode!=='native')$('modes').querySelector('[data-mode="native"]').click()
    addFreeSiteOption(resolved.site_id,body,resolved.center_lat_lon)
    $('site').value=resolved.site_id
    await changeSite({offset:resolved.offset_east_north_m})
    $('status').textContent=__m`已選 ${size} m 完整高解析方框：${coordinates(...resolved.center_lat_lon)}。${resolved.source_mode==='on_demand_original_dtm'?__t('此處直接取樣原始 DTM。'):__t('此處使用已保存 3 km DEM。')}可在下方 3 km 圖細調後搜尋。`
    setMapView('local');document.querySelector('.map-workspace').scrollIntoView({behavior:'smooth',block:'start'})
  }catch(error){$('status').textContent=error.message}
}
function changeCoverageZoom(direction){
  const view=$('coverage-map'),x=(view.scrollLeft+view.clientWidth/2)/Math.max(view.scrollWidth,1),y=(view.scrollTop+view.clientHeight/2)/Math.max(view.scrollHeight,1)
  coverageZoom=Math.max(1,Math.min(8,coverageZoom*(direction==='in'?2:.5)))
  syncCoverageSize()
  view.scrollLeft=x*view.scrollWidth-view.clientWidth/2
  view.scrollTop=y*view.scrollHeight-view.clientHeight/2
}
async function changeSite(options={}){
  $('search').disabled=true
  site=$('site').value;east=0;north=0;mapData=null;drawMap()
  if(site.startsWith('JEZERO_CTX'))marsRegionParent='JEZERO_CTX'
  if(site.startsWith('JEZERO_HIRISE'))marsRegionParent='JEZERO_HIRISE_023524'
  if(site.startsWith('OLYMPUS_CTX'))marsRegionParent='OLYMPUS_CTX'
  $('status').textContent=__t('讀取立體高程圖…')
  try{
    mapData=await json(`/api/microterrain/map?site=${encodeURIComponent(site)}`)
    coverageBody=mapData.body
    if(mapData.body==='moon')moonRegionParent=tileParent(site)
    renderCoverage()
    centerCoverage(metadata?.[coverageBody==='mars'?'mars_sites':'moon_sites']?.find(row=>row.id===tileParent(site)))
    evidenceFilter=mapData.body==='moon'?'screen':'off'
    document.querySelectorAll('#evidence-filters button').forEach(b=>b.classList.toggle('active',b.dataset.evidence===evidenceFilter))
    ;[east,north]=options.offset||mapData.recommended_native_offset_east_north_m||[0,0]
    drawMap()
    renderRegionalSelection(mapData.body)
    const [lat,lon]=mapData.center_lat_lon
    $('site-detail').textContent=__m`${bodyName(mapData.body)} · ${coordinates(lat,lon)} · 原始 DEM 格距 ${mapData.native_spacing_m.toFixed(1)} m · 選區預覽網格約 ${mapData.side_m/Math.max(mapData.grid.length,1)} m${mapData.source_crop_mode==='on_demand_original_dtm'?__t(' · 從原始 DTM 按需裁切'):''}。`
    $('status').textContent=(east||north) ? __m`已選最近的完整高解析窗格（東移 ${east} m、北移 ${north} m）；可點地圖改選。` : __t('點選要搜尋的方框位置。')
  }
  catch(e){$('status').textContent=e.message}
  finally{$('search').disabled=!mapData;updateWorkspaceSite()}
}
function showMatch(index) {
  if(!response?.matches?.[index])return
  selected=index
  const row=response.matches[index]
  updateWorkspaceCandidate(row)
  paint('moon',response.reference_height,response.body);paint('earth',row.earth_height,'earth')
  const shared=overlayMode==='shared'&&response.mode==='native'&&row.reference_height_shared&&row.earth_aligned_height_shared
  paint('overlay-moon',shared?row.reference_height_shared:response.reference_height,response.body)
  paint('overlay-earth',shared?row.earth_aligned_height_shared:row.earth_aligned_height,'earth')
  $('overlay-legend').textContent=shared ? __m`兩側使用同一公尺色階：色值每增加 1 相當於相對中位高度增加 ${row.overlay_shared_scale_m.toFixed(1)} m，顏色於 ±1.4 色值截斷。旋轉／鏡像後直接比較真實高差。` : __t('兩側各自除以自身 P90–P10 起伏；此視圖只顯示形狀，實際高差請看上方公尺數值。')
  $('reference-title').textContent=__m`${response.body.toUpperCase()} / 查詢 DEM`
  $('earth-title').textContent=`EARTH / ${__t(row.site_label)}`
  $('terrain-scale').textContent=row.height_rmse_m!=null ? __m`真實公尺尺度：${bodyName(response.body)} P90–P10 起伏 ${row.query_relief_p90_p10_m.toFixed(1)} m；地球 ${row.earth_relief_p90_p10_m.toFixed(1)} m（${row.earth_to_query_relief_ratio.toFixed(2)} 倍）。旋轉／鏡像後去除各自中位高度的 RMSE ${row.height_rmse_m.toFixed(1)} m。此處沒有逐格高程真值誤差。` : ''
  const detailed=row.earth_detailed_geologic_map_context
  const amboyVeneer=row.site_id==='AMBOY_CRATER'&&detailed?.mapped_units?.[0]?.major_lithology==='surficial_veneer_over_mafic_volcanic_deposit'
  const evidenceNote=row.evidence_sampling==='exact_candidate_center'?__t(' 地質圖、土地覆蓋與 NAIP 植被訊號已在此 4 m 候選的實際中心取樣；原始地圖比例尺與分類誤差仍不能證明逐格岩性。'):''
  const surfaceWarning=(amboyVeneer?__m`Amboy 地表圖顯示主要為「${detailed.mapped_units[0].name}」；下伏火山岩不表示地表是裸露玄武岩。此候選目前只依地形幾何入選，材質類比尚未驗證。`:row.surface_evidence_conflict?__t('地表證據衝突：州地質圖大部分是沖積層，30 m 土地覆蓋大部分是灌叢、裸地極少。此窗格只在幾何上相似，不應稱為裸岩類比。'):row.mapped_alluvium_dominant?__t('州地質圖顯示此窗格以沖積層為主；即使 30 m 土地覆蓋屬「裸地（岩／砂／黏土）」，也不能證明是裸岩。此結果依 DEM 幾何入選，月球岩石與地質成因類比仍未驗證。'):'')
  $('surface-evidence-warning').classList.toggle('hidden',!surfaceWarning)
  $('surface-evidence-warning').textContent=surfaceWarning
  $('earth-context').textContent=__t(row.regional_context)||__t('此地球候選沒有窗格級岩性證據。')
  $('earth-context-link').href=row.regional_context_url||'#'
  $('earth-context-link').classList.toggle('hidden',!row.regional_context_url)
  const geology=row.earth_geologic_map_context
  $('earth-geology').textContent=geology ? __m`地質圖單元覆蓋：${geology.mapped_units.map(unit=>`${unit.name}（${unit.lith}）${(unit.fraction*100).toFixed(0)}%`).join('；')||__t('無已繪單元')}。地圖覆蓋 ${(geology.mapped_fraction*100).toFixed(0)}%；這是州地質圖多邊形與方框相交比例，原圖比例尺不足以判定 200 m 裸岩或礦物。` : __t('此模式沒有候選窗格的地質圖單元資料。')
  $('earth-geology').textContent+=evidenceNote
  $('earth-geology-link').href=geology?.underlying_source_url||'#'
  $('earth-geology-link').classList.toggle('hidden',!geology?.underlying_source_url)
  $('earth-detailed-geology').classList.toggle('hidden',!detailed)
  $('earth-detailed-geology').textContent=detailed?__m`${detailed.map_name||__t('詳細地質圖')} 1:${Number(detailed.map_scale_denominator).toLocaleString('en-US')}：${detailed.mapped_units.map(unit=>`${unit.name}（${unit.symbol}）${(unit.fraction*100).toFixed(0)}%`).join('；')||__t('無已繪單元')}。方框地圖覆蓋 ${(detailed.mapped_fraction*100).toFixed(0)}%；${detailed.contact_accuracy_note|| (detailed.published_horizontal_accuracy_m==null?__t('原圖未給出接觸線水平定位精度'):__m`原圖標稱水平定位精度約 ${detailed.published_horizontal_accuracy_m} m`)}。10 m 取樣僅算多邊形比例，不表示每格裸露岩石或礦物，也不參與搜尋排名。`:''
  $('earth-detailed-geology-link').href=detailed?.source_page||'#'
  $('earth-detailed-geology-link').classList.toggle('hidden',!detailed?.source_page)
  const cover=row.earth_landcover_context
  $('earth-landcover').textContent=cover ? __m`Annual NLCD ${cover.year}：此 ${response.size_m} m 窗格約 ${cover.sample_pixels} 個 30 m 分類像元；裸地（岩／砂／黏土）${(cover.barren_rock_sand_clay_fraction*100).toFixed(0)}%、灌叢 ${(cover.shrub_scrub_fraction*100).toFixed(0)}%。這不是裸岩、玄武岩或礦物判定，也不改變幾何分數；可用於選用的雙重衝突篩選。` : __t('此模式沒有窗格級土地覆蓋資料。')
  $('earth-landcover-link').href=cover?.source_url||'#'
  $('earth-landcover-link').classList.toggle('hidden',!cover?.source_url)
  const naip=row.earth_naip_vegetation_signal
  $('earth-naip').classList.toggle('hidden',!naip)
  $('earth-naip').textContent=naip?__m`USGS NAIP ${naip.acquisition_dates.join('／')} 四波段航照：原始場景約 ${naip.source_scene_resolution_m} m、同窗格以 ${naip.analysis_spacing_m} m 分析 ${naip.sample_pixels.toLocaleString('en-US')} 個有效像元；NDVI 中位數 ${naip.median_ndvi.toFixed(3)}，NDVI ≥0.1／0.2／0.3 分別占 ${(naip.fraction_ndvi_ge_0_1*100).toFixed(2)}%／${(naip.fraction_ndvi_ge_0_2*100).toFixed(2)}%／${(naip.fraction_ndvi_ge_0_3*100).toFixed(2)}%。這只是未校準的近紅外植被訊號；與 2024 NLCD 的灌叢類別定義及日期不同，不能推算裸岩、礦物或材質相似率。` : ''
  $('earth-naip-link').href=naip?.source_url||'#'
  $('earth-naip-link').classList.toggle('hidden',!naip?.source_url)
  const env=row.earth_environment_context
  $('earth-climate').textContent=env ? __m`NASA POWER 2001–2025 區域氣候：年均 ${env.temperature_annual_c.toFixed(1)} °C、平均降水 ${env.precipitation_annual_mean_mm_day.toFixed(2)} mm/日。來源格網遠大於此窗格；不參與地形排名，也不能表示月／火環境相同。` : __t('此模式沒有逐候選的環境資料。')
  $('earth-climate-link').href=env?.source_data_url||'#'
  $('earth-climate-link').classList.toggle('hidden',!env?.source_data_url)
  const scenarioParams=new URLSearchParams({site:response.site_id,size_m:response.size_m,
    east_m:response.moon_offset_east_north_m[0],north_m:response.moon_offset_east_north_m[1],
    ranker:response.ranker||'geomorphon',comparison:response.comparison||'shape',
    evidence_filter:response.evidence_filter||'off',match:index,gallery_index:row.gallery_index,earth_site:row.site_id})
  $('scenario-link').href=`/microterrain-scenario.html?${scenarioParams}`
  $('scenario-link').classList.toggle('hidden',response.mode!=='native')
  const traceParams=new URLSearchParams(scenarioParams)
  traceParams.set('gallery_index',String(row.gallery_index))
  traceParams.set('earth_site',row.site_id)
  traceParams.set('model_sha256',response.model_sha256)
  $('method-trace-link').href=`/technology/?${traceParams}#query-trace`
  $('method-trace-link').classList.toggle('hidden',response.mode!=='native')
  $('download-card').classList.toggle('hidden',response.mode!=='native')
  $('opacity').dispatchEvent(new Event('input'))
  document.querySelectorAll('#matches button').forEach((button,i)=>button.classList.toggle('active',i===index))
}
function downloadCard(){
  const row=response?.matches?.[selected]
  if(!row || response.mode!=='native')return
  const cover=row.earth_landcover_context||{}, env=row.earth_environment_context||{}, geology=row.earth_geologic_map_context||{}, detailed=row.earth_detailed_geologic_map_context, naip=row.earth_naip_vegetation_signal
  const queryCoord=response.reference_window_center_lat_lon||response.center_lat_lon
  const earthCoord=row.center_lat_lon
  const lines=[
    __m`# Analog Atlas 候選場址卡 — ${row.site_label}`,'',
    __m`產生時間：${new Date().toISOString()}`,
    __m`查詢：${bodyName(response.body)} ${response.site_label}；${response.size_m} m 方框；中心 ${queryCoord?.join(', ')||__t('未提供')}（緯度、經度）`,
    __m`地球候選：${row.site_label}；中心 ${earthCoord?.join(', ')||__t('未提供')}（緯度、經度）`,'',
    __t('## 地貌幾何'),'',
    __m`- 粗排：${response.ranker==='tiny'?__t('自訓練 TinyMorphEncoder 32 維向量'):__t('2014 式 55 維 geomorphon Wave-Hedges')}；2014 名次 #${row.paper_rank}，小模型名次 #${row.tiny_rank}。`,
    __m`- D4 旋轉／鏡像後形狀差：${row.shape_gap}；這是相對高度形狀比較，不是跨天體類比機率。`,
    __m`- 未縮放真實起伏 P90–P10：${bodyName(response.body)} ${row.query_relief_p90_p10_m} m、地球 ${row.earth_relief_p90_p10_m} m（比值 ${row.earth_to_query_relief_ratio}）；中位高度對齊後 RMSE ${row.height_rmse_m} m。精排依據：${response.comparison==='meter'?__t('真實高差'):__t('正規化形狀')}。`,
    __m`- 地表證據衝突篩選：${response.evidence_filter==='screen'?__t('啟用'):__t('停用')}；本窗格${row.surface_evidence_conflict?__t('具有州圖沖積層與 NLCD 灌叢雙重衝突'):__t('未觸發雙重衝突條件（不代表已證明裸岩）')}。`,
    row.evidence_sampling==='exact_candidate_center'?__t('- 地質圖／土地覆蓋／NDVI 依精確 4 m 候選的中心與方框重新取樣；原圖尺度、影像日期與分類誤差仍不構成逐格材質真值。'):'',
    __m`- 州地質圖沖積層主導：${row.mapped_alluvium_dominant?__t('是；本候選僅具 DEM 幾何相似性，岩石與地質成因類比未驗證'):__t('否；此判斷不構成裸岩證明')}。`,
    __m`- 實際方框 ${response.actual_sampled_side_m} m；比較網格 ${response.comparison_spacing_m} m；地球 DEM 為 USGS 3DEP 1 m 裸地來源、保存為 2 m 裁切。`,'',
    __t('## 地表、環境與任務證據'),'',
    __m`- ${row.regional_context}。此敘述是場址背景，不是逐窗格岩性真值。`,
    __m`- 州地質圖單元方框覆蓋：${geology.mapped_units?.map(unit=>`${unit.name} [${unit.lith}] ${(unit.fraction*100).toFixed(1)}%`).join('；')||__t('未提供')}。此為原圖多邊形推算，不代表現地岩石暴露或礦物含量。`,
    `- ${detailed?.map_name||__t('詳細地質圖')}${detailed?` 1:${Number(detailed.map_scale_denominator).toLocaleString('en-US')}`:''}：${detailed?detailed.mapped_units.map(unit=>`${unit.name} [${unit.symbol}] ${(unit.fraction*100).toFixed(1)}%`).join('；'):__t('此場址沒有該資料')}。${detailed?__m`此為繪圖單元重疊比例；${detailed.contact_accuracy_note||(detailed.published_horizontal_accuracy_m==null?__t('原圖未給出接觸線水平定位精度'):__m`原圖標稱水平定位精度約 ${detailed.published_horizontal_accuracy_m} m`)}，不代表逐格裸岩或礦物。`:''}`,
    __m`- Annual NLCD ${cover.year||'—'}：${cover.sample_pixels??'—'} 個 ${cover.pixel_size_m||30} m 分類像元；類別 31 岩／砂／黏土裸地 ${cover.barren_rock_sand_clay_fraction!=null?(cover.barren_rock_sand_clay_fraction*100).toFixed(1):'—'}%；類別 52 灌叢 ${cover.shrub_scrub_fraction!=null?(cover.shrub_scrub_fraction*100).toFixed(1):'—'}%。不表示裸岩、玄武岩或礦物。`,
    __m`- USGS NAIP 近紅外植被訊號：${naip?__m`${naip.acquisition_dates.join('／')}，${naip.sample_pixels} 個 ${naip.analysis_spacing_m} m 像元，NDVI 中位數 ${naip.median_ndvi}、NDVI ≥0.1／0.2／0.3 為 ${(naip.fraction_ndvi_ge_0_1*100).toFixed(2)}%／${(naip.fraction_ndvi_ge_0_2*100).toFixed(2)}%／${(naip.fraction_ndvi_ge_0_3*100).toFixed(2)}%`:__t('此場址無資料')}。門檻未經現地校準，不表示裸岩比例；與 NLCD 年份及類別定義不同。`,
    __m`- NASA POWER ${env.period||__t('區域常態')}：年均氣溫 ${env.temperature_annual_c??'—'} °C，平均降水 ${env.precipitation_annual_mean_mm_day??'—'} mm/日。來源格網遠大於地形方框。`,
    __t('- 窗格岩性／礦物：未知。月／火／地環境等效性：未評估。基地／著陸安全：未評估。'),'',
    __t('## 原始來源'),'',
    __m`- 行星 DEM：${response.reference_source_url}`,
    __t('- 地球 DEM：https://data.usgs.gov/datacatalog/data/USGS%3A4f34caac-f28f-4ea0-8d82-eafb2b8f9a5d'),
    __m`- 地質背景：${row.regional_context_url||__t('未提供')}`,
    __m`- 地質圖編纂：${geology.underlying_source_url||__t('未提供')}`,
    __m`- 詳細地表／地質圖：${detailed?.source_page||__t('此場址無資料')}`,
    __m`- 土地覆蓋：${cover.source_url||__t('未提供')}`,
    __m`- 四波段 NAIP：${naip?.source_url||__t('此場址無資料')}`,
    __m`- 氣候：${env.source_data_url||__t('未提供')}`,
    __t('- 方法：https://doi.org/10.1016/j.geomorph.2014.06.011'),'',
    __t('本卡是候選研究紀錄，沒有專家確認的跨天體相似性、逐窗格材質或工程適用性。')
  ]
  const blob=new Blob([lines.join('\n')+'\n'],{type:'text/markdown;charset=utf-8'})
  const url=URL.createObjectURL(blob),link=document.createElement('a')
  link.href=url;link.download=`analog-atlas-${response.site_id.toLowerCase()}-${row.site_id.toLowerCase()}-${response.size_m}m.md`
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
async function search() {
  if(!mapData)return
  $('search').disabled=true;$('status').textContent=comparison==='meter'?__t('正在比對地貌與真實高差…'):__t('正在比對地貌與高度形狀…')
  try{
    const q=new URLSearchParams({site,size_m:size,east_m:east,north_m:north,mode,ranker,comparison,evidence_filter:evidenceFilter})
    const answer=await json(`/api/microterrain/search?${q}`)
    const current=new URLSearchParams({site,size_m:size,east_m:east,north_m:north,mode,ranker,comparison,evidence_filter:evidenceFilter})
    if(q.toString()!==current.toString()){ $('status').textContent=__t('選區或設定已變更，請重新搜尋。'); return }
    response=answer
    $('result').classList.remove('hidden')
    $('scope').textContent=__m`${response.site_label} · ${response.size_m} m 目標窗格 · ${response.mode === 'native' ? __m`高解析／${response.ranker === 'tiny' ? __t('小模型') : __t('2014 基線')}／${response.comparison==='meter'?__t('真實高差'):__t('正規化形狀')}／${response.evidence_filter==='screen'?__t('避開雙重衝突'):__t('純幾何')}` : __t('舊版')} · ${response.actual_grid_cells}×${response.actual_grid_cells} 高程格 · ${response.comparison_spacing_m||31.25} m 格距`
    $('count').textContent=__m`${response.searched_windows} 個候選窗格`
    $('matches').innerHTML=''
    response.matches.forEach((row,i)=>{
      const button=document.createElement('button');button.type='button'
      button.innerHTML=__m`<canvas id="candidate-thumb-${i}" width="64" height="64" aria-hidden="true"></canvas><strong>${i+1}. ${row.site_label}</strong><small>形狀差 ${row.shape_gap.toFixed(3)}${row.height_rmse_m!=null?__m` · 真實高差 ${row.height_rmse_m.toFixed(1)} m`:''}</small>`
      button.addEventListener('click',()=>showMatch(i));$('matches').appendChild(button);paint(`candidate-thumb-${i}`,row.earth_height,'earth')
    })
    $('warning').textContent=__m`${response.resolution_warning ? response.resolution_warning+'。' : ''}${response.mode === 'native' ? __m`高解析模式使用${metadata.native_mode.earth_site_ids.length}處 USGS 3DEP 裸地裁切；本次為 ${response.comparison_spacing_m} m 共格網，仍只有${metadata.native_mode.earth_site_ids.length}處 3 km 地球區域。${response.evidence_alignment?__t('地質圖、土地覆蓋與 NAIP 證據已依精確 4 m 候選中心重算；原始地圖解析度仍較粗。'):''}${response.evidence_filter==='screen'?__m`產生五筆結果前避開 ${response.excluded_evidence_conflicts} 個州圖沖積層＋NLCD 灌叢雙重衝突窗格；這不證明剩餘窗格為裸岩。`:''}Amboy Crater、Death Valley Mars Hill 與 Idaho Craters of the Moon 是已知 NASA 月／火類比場址；Cima 曾納入 NASA 行星地質遙測研究，但本站的 Cima 小窗格尚未驗證；Carrizozo、Big Pine 是待確認的研究候選。小模型只以同窗格旋轉／跨解析度自監督訓練，未經月／火－地專家類比標註驗證。` : __t('舊版模式使用約 31 m 地球 DSM；200 m 僅約 7 格橫跨。')}場址描述不等於每格地貌標籤；這些窗格尚未有材質或地質成因真值，不能保證「一模一樣」。`
    $('reference-source').href=response.reference_source_url
    $('reference-source').textContent=__m`${bodyName(response.body)} DEM 原始來源 ↗`
    $('context-source').classList.toggle('hidden',!response.reference_context_url)
    if(response.reference_context_url) $('context-source').href=response.reference_context_url
    $('status').textContent=__m`完成：${response.matches.length} 個可疊合候選。`
    showMatch(0)
    showWorkspaceResults()
  }catch(e){$('status').textContent=e.message}
  finally{$('search').disabled=false}
}
window.addEventListener('DOMContentLoaded',async()=>{
  $('coverage-actions').addEventListener('click',e=>{
    const body=e.target.closest('[data-coverage-body]'),zoom=e.target.closest('[data-coverage-zoom]')
    if(body){coverageBody=body.dataset.coverageBody;coverageZoom=1;renderCoverage();$('coverage-map').scrollTo(0,0)}
    if(zoom)changeCoverageZoom(zoom.dataset.coverageZoom)
  })
  $('mars-parent-actions').addEventListener('click',e=>{
    const button=e.target.closest('[data-mars-parent]');if(!button)return
    marsRegionParent=button.dataset.marsParent;renderMarsRegion()
  })
  $('moon-parent-actions').addEventListener('click',e=>{
    const button=e.target.closest('[data-moon-parent]');if(!button)return
    moonRegionParent=button.dataset.moonParent;renderMoonRegion()
  })
  let coverageDrag=null
  $('coverage-map').addEventListener('pointerdown',e=>{
    if(e.target.closest('.coverage-pin'))return
    coverageDrag={x:e.clientX,y:e.clientY,left:$('coverage-map').scrollLeft,top:$('coverage-map').scrollTop}
    $('coverage-map').setPointerCapture(e.pointerId)
  })
  $('coverage-map').addEventListener('pointermove',e=>{
    if(!coverageDrag)return
    $('coverage-map').scrollLeft=coverageDrag.left-(e.clientX-coverageDrag.x)
    $('coverage-map').scrollTop=coverageDrag.top-(e.clientY-coverageDrag.y)
  })
  $('coverage-map').addEventListener('pointerup',()=>{coverageDrag=null})
  $('coverage-map').addEventListener('pointercancel',()=>{coverageDrag=null})
  new ResizeObserver(syncCoverageSize).observe($('coverage-map'))
  $('map').addEventListener('click',e=>{
    const box=$('map').getBoundingClientRect(),half=size/2
    east=Math.round(Math.max(-1500+half,Math.min(1500-half,((e.clientX-box.left)/box.width-.5)*3000)))
    north=Math.round(Math.max(-1500+half,Math.min(1500-half,(.5-(e.clientY-box.top)/box.height)*3000)))
    drawMap()
    if(mapData)renderRegionalSelection(mapData.body)
  })
  $('moon-tile-map').addEventListener('click',e=>chooseRegionalPoint('moon',e))
  $('mars-tile-map').addEventListener('click',e=>chooseRegionalPoint('mars',e))
  $('site').addEventListener('change',changeSite)
  $('sizes').addEventListener('click',e=>{
    const button=e.target.closest('[data-size]');if(!button)return
    size=Number(button.dataset.size)
    document.querySelectorAll('#sizes button').forEach(b=>b.classList.toggle('active',b===button))
    const limit=1500-size/2;east=Math.max(-limit,Math.min(limit,east));north=Math.max(-limit,Math.min(limit,north));drawMap()
    if(mapData)renderRegionalSelection(mapData.body)
  })
  $('modes').addEventListener('click',e=>{
    const button=e.target.closest('[data-mode]');if(!button)return
    mode=button.dataset.mode
    document.querySelectorAll('#modes button').forEach(b=>b.classList.toggle('active',b===button))
    $('mode-detail').textContent=mode==='native' ? __t('真正使用高解析 DEM：月地 5 m、火星 CTX 20 m、Jezero HiRISE 4 m 比較格網；地球候選為 USGS 3DEP 裸地。') : __t('保留原 31.25 m GLO-30 基線，方便比較解析度影響。')
    $('ranker-control').classList.toggle('hidden',mode!=='native')
    $('comparison-control').classList.toggle('hidden',mode!=='native')
    $('evidence-control').classList.toggle('hidden',mode!=='native')
    $('overlay-mode-control').classList.toggle('hidden',mode!=='native')
    if(mode!=='native'){
      ranker='geomorphon'
      document.querySelectorAll('#rankers button').forEach(b=>b.classList.toggle('active',b.dataset.ranker===ranker))
    }
  })
  $('rankers').addEventListener('click',e=>{
    const button=e.target.closest('[data-ranker]');if(!button)return
    ranker=button.dataset.ranker
    document.querySelectorAll('#rankers button').forEach(b=>b.classList.toggle('active',b===button))
  })
  $('comparisons').addEventListener('click',e=>{
    const button=e.target.closest('[data-comparison]');if(!button)return
    comparison=button.dataset.comparison
    document.querySelectorAll('#comparisons button').forEach(b=>b.classList.toggle('active',b===button))
  })
  $('evidence-filters').addEventListener('click',e=>{
    const button=e.target.closest('[data-evidence]');if(!button)return
    evidenceFilter=button.dataset.evidence
    document.querySelectorAll('#evidence-filters button').forEach(b=>b.classList.toggle('active',b===button))
  })
  $('overlay-modes').addEventListener('click',e=>{
    const button=e.target.closest('[data-overlay]');if(!button)return
    overlayMode=button.dataset.overlay
    document.querySelectorAll('#overlay-modes button').forEach(b=>b.classList.toggle('active',b===button))
    showMatch(selected)
  })
  $('opacity').addEventListener('input',()=>{
    const amount=Number($('opacity').value)/100
    $('overlay-moon').style.opacity=1-amount
    $('overlay-earth').style.opacity=amount
  })
  $('search').addEventListener('click',search)
  $('download-card').addEventListener('click',downloadCard)
  try{
    metadata=await json('/api/microterrain/sites')
    const groups=[[__t('月球 / LROC NAC'),metadata.moon_sites],...metadata.moon_sites.map(row=>[__m`${row.label.split(' · ')[0]} / 區域裁切`,(metadata.moon_tiles||[]).filter(tile=>tile.tile_parent_id===row.id)]),[__t('火星 / HiRISE 與 CTX 立體高程'),metadata.mars_sites||[]],[__t('Jezero CTX / 區域裁切'),(metadata.mars_tiles||[]).filter(row=>row.tile_parent_id==='JEZERO_CTX')],[__t('Olympus CTX / 區域裁切'),(metadata.mars_tiles||[]).filter(row=>row.tile_parent_id==='OLYMPUS_CTX')]]
    for(const [label,rows] of groups){
      const group=document.createElement('optgroup');group.label=label
      rows.forEach(row=>{const option=document.createElement('option');option.value=row.id;option.textContent=__t(row.label);group.appendChild(option)})
      $('site').appendChild(group)
    }
    const savedParams=new URLSearchParams(location.search)
    const requested=savedParams.get('site')
    if(requested&&freeOffset(requested)){
      const parent=tileParent(requested)
      const body=metadata.moon_sites.some(row=>row.id===parent)?'moon':
        metadata.mars_sites.some(row=>row.id===parent)?'mars':null
      if(body)addFreeSiteOption(requested,body)
    }
    if(requested && [...$('site').options].some(option=>option.value===requested)) $('site').value=requested
    const savedEast=Number(savedParams.get('east_m')),savedNorth=Number(savedParams.get('north_m'))
    const savedOffset=savedParams.has('east_m')&&savedParams.has('north_m')&&
      Number.isFinite(savedEast)&&Number.isFinite(savedNorth)&&Math.abs(savedEast)<=1500&&Math.abs(savedNorth)<=1500
      ? [savedEast,savedNorth]:null
    await changeSite(savedOffset?{offset:savedOffset}:{})
    if(savedParams.get('autosearch')==='1'&&mapData&&savedOffset){
      const savedSize=Number(savedParams.get('size_m'))
      if([200,500,1000].includes(savedSize))size=savedSize
      if(['geomorphon','tiny'].includes(savedParams.get('ranker')))ranker=savedParams.get('ranker')
      if(['shape','meter'].includes(savedParams.get('comparison')))comparison=savedParams.get('comparison')
      if(['off','screen'].includes(savedParams.get('evidence_filter')))evidenceFilter=savedParams.get('evidence_filter')
      document.querySelectorAll('#sizes button').forEach(b=>b.classList.toggle('active',Number(b.dataset.size)===size))
      document.querySelectorAll('#rankers button').forEach(b=>b.classList.toggle('active',b.dataset.ranker===ranker))
      document.querySelectorAll('#comparisons button').forEach(b=>b.classList.toggle('active',b.dataset.comparison===comparison))
      document.querySelectorAll('#evidence-filters button').forEach(b=>b.classList.toggle('active',b.dataset.evidence===evidenceFilter))
      drawMap()
      await search()
      const savedIndex=savedParams.get('gallery_index'),savedSite=savedParams.get('earth_site')
      const found=response?.matches?.findIndex(row=>String(row.gallery_index)===savedIndex&&row.site_id===savedSite)
      if(found>=0)showMatch(found)
    }
  }catch(e){$('status').textContent=e.message}
})
