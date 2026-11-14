// Results page (stage 2). Loaded on demand by main.jsx with React.lazy, so the home page does not download it.
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, Info } from 'lucide-react'
import { GlobalVisualPanel } from './global_visual_panel.jsx'
import { ImageryComparison } from './imagery_comparison.jsx'
import { usePageHeading } from './modal_focus.js'
import { requestJson } from './api_request.js'
import { candidateDossier } from './site_report.js'
import { OffcatTag, OffcatToggle } from './offcat_ui.jsx'
import './offcat_ui.css'
import { translate, message, getLanguage } from './i18n/core.js'
import { useFlatView, ViewToggle, FlatEarth } from './flat_view.jsx'
import { renderGate } from './render_gate.js'
import { nextCandidateOffset } from './candidate_paging.js'
import { clusterScreenPoints } from './marker_clusters.js'
import { PURPOSES } from './purposes.js'
import { RunDownloads, TerrainDiagnostics } from './research_evidence.jsx'
import { LavaTubePanel } from './lavatube_panel.jsx'
import { ConditionsPanel } from './conditions_panel.jsx'
import { PhysicalMatchPanel } from './physical_match_panel.jsx'
import { FacetsPanel } from './facets_panel.jsx'
import { MaxMatchPanel } from './maxmatch_panel.jsx'
import { ResourcePanel } from './resource_panel.jsx'
import { MaterialPanel } from './material_panel.jsx'
import { prefetchExploreDem, prefetchExplorerModels } from './explore_dem.js'
import { formatCoord, lonLatPoint } from './planet_geo.js'
import { TerrainView } from './terrain_view.jsx'
import { ResultsGlance, knownAnalogInfo } from './results_glance.jsx'
import { useEarthPlaces } from './earth_names.js'
import { ResultsNav } from './results_nav.jsx'

const AstronautExplorer = React.lazy(() => import('./astronaut_explorer.jsx'))

function EarthCandidates({ matches, activeId, onActive }) {
  const host = useRef(null)
  const [flat,setFlat]=useFlatView()
  const controller = useRef(null)
  const pick = useRef(onActive)
  const [zoomed, setZoomed] = useState(false)
  const [textureError, setTextureError] = useState(false)
  const [renderError, setRenderError] = useState(false)
  const [clusterIds, setClusterIds] = useState([])
  const cameraMemory = useRef(null)
  const clusterPanel = useRef(null)
  useEffect(()=>{if(clusterIds.length>1)clusterPanel.current?.focus()},[clusterIds])
  useEffect(()=>setClusterIds([]),[matches])
  pick.current = onActive
  useEffect(() => {
    if(flat)return
    const element = host.current
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50)
    camera.position.set(0, 0.6, 4.3)
    let renderer
    try {renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })} catch {setRenderError(true);setFlat(true);return}
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7))
    renderer.domElement.addEventListener('webglcontextlost', event=>{event.preventDefault();setFlat(true)}, {once:true})
    renderer.outputColorSpace = THREE.SRGBColorSpace
    element.appendChild(renderer.domElement)
    let globeDirty = true, globeOnScreen = true
    const globeVisibility = new IntersectionObserver(entries => { globeOnScreen = entries[0]?.isIntersecting ?? true; globeDirty = true }, { threshold: 0.01 })
    globeVisibility.observe(element)
    const texture = new THREE.TextureLoader().load('/earth-color.jpg', () => { globeDirty = true }, undefined, () => setTextureError(true))
    texture.colorSpace = THREE.SRGBColorSpace
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }))
    scene.add(earth, new THREE.AmbientLight(0xc5e1ff, 2))
    const sunlight = new THREE.DirectionalLight(0xffffff, 2.4)
    camera.add(sunlight); sunlight.position.set(-3, 4, 5); scene.add(camera)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false; controls.enableDamping = true
    controls.minDistance = 1.65; controls.maxDistance = 5
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const buttons = matches.map((row, index) => {
      const button = document.createElement('button')
      button.className = 'earth-candidate-dot'
      button.textContent = ''
      button.type = 'button'
      button.setAttribute('aria-label', message`定位候選：${formatCoord(row.center.latitude, row.center.longitude_east)}`)
      button.title = message`${row.name} · 點選放大`
      element.appendChild(button)
      const item = { button, row, position: lonLatPoint(row.center.latitude, row.center.longitude_east, 1.018), members:null }
      button.onclick = () => {
        if(item.members?.length>1){
          setClusterIds(item.members.map(p=>p.id))
          const target=new THREE.Vector3()
          item.members.forEach(p=>target.add(p.item.position))
          controller.current?.focusCluster(target.normalize())
        } else {setClusterIds([]);setZoomed(true);pick.current(row.id);controller.current?.focus(row.id,2.25)}
      }
      return item
    })
    let flight = null, frame, disposed = false, lastMarkerKey = null
    let currentId = activeId
    const focus = (id, distance = 3.4) => {
      const candidate = buttons.find(item => item.row.id === id)
      if (!candidate) return
      currentId = id
      const from = camera.position.clone().normalize()
      const to = candidate.position.clone().normalize()
      flight = { start: performance.now(), from, rotation: new THREE.Quaternion().setFromUnitVectors(from, to), distance: camera.position.length(), targetDistance: distance }
      buttons.forEach(item => item.button.setAttribute('aria-pressed', String(item.row.id === id)))
    }
    const stopFlight = () => { flight = null }
    controls.addEventListener('start', stopFlight)
    const resize = () => {
      const width = element.clientWidth, height = element.clientHeight
      if (!width || !height) return
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height)
    }
    const observer = new ResizeObserver(resize); observer.observe(element); resize()
    controller.current = { focus, focusCluster: target => {
      const from=camera.position.clone().normalize()
      flight={start:performance.now(),from,rotation:new THREE.Quaternion().setFromUnitVectors(from,target),distance:camera.position.length(),targetDistance:1.65}
    }, reset: () => { setClusterIds([]);setZoomed(false); focus(currentId, 3.4) } }
    if(cameraMemory.current)camera.position.fromArray(cameraMemory.current)
    else focus(activeId)
    const render = () => {
      if (disposed) return
      frame = requestAnimationFrame(render)
      if (!globeOnScreen || renderGate.paused || document.hidden) return
      if (flight) {
        const t = reduced ? 1 : Math.min(1, (performance.now() - flight.start) / 350)
        const ease = t * t * (3 - 2 * t)
        camera.position.copy(flight.from).applyQuaternion(new THREE.Quaternion().slerp(flight.rotation, ease)).multiplyScalar(THREE.MathUtils.lerp(flight.distance, flight.targetDistance, ease))
        if (t === 1) flight = null
      }
      const moved = controls.update(); camera.updateMatrixWorld()
      const markerKey=camera.position.toArray().join(",")+":"+element.clientWidth+":"+element.clientHeight+":"+currentId+":"+document.documentElement.lang
      if(markerKey!==lastMarkerKey){
      lastMarkerKey=markerKey
      globeDirty=true
      const projected=[]
      buttons.forEach(item => {
        item.button.style.visibility='hidden'
        const facing=item.position.dot(camera.position.clone().sub(item.position))>0
        const point=item.position.clone().project(camera)
        if(facing&&Math.abs(point.x)<.95&&Math.abs(point.y)<.94&&point.z<1)projected.push({id:item.row.id,item,x:(point.x+1)*element.clientWidth/2,y:(1-point.y)*element.clientHeight/2})
      })
      clusterScreenPoints(projected,28,currentId).forEach(group=>{
        const item=group.representative.item,n=group.members.length,button=item.button
        item.members=group.members
        button.classList.toggle('is-cluster',n>1)
        button.textContent=''
        button.setAttribute('aria-label',translate(n>1?message`${n} 個候選聚合，放大並展開`:message`定位候選：${formatCoord(item.row.center.latitude,item.row.center.longitude_east)}`))
        button.setAttribute('aria-pressed',String(group.members.some(p=>p.id===currentId)))
        button.title=translate(n>1?message`${n} 個候選 · 點擊展開`:item.row.name+' · 點選放大')
        button.style.visibility='visible';button.style.left=group.x+'px';button.style.top=group.y+'px'
      })
      }
      if (globeDirty || flight || moved) { renderer.render(scene, camera); globeDirty = false }
    }
    render()
    return () => {
      cameraMemory.current=camera.position.toArray()
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); globeVisibility.disconnect(); controls.removeEventListener('start', stopFlight); controls.dispose()
      buttons.forEach(item => item.button.remove()); earth.geometry.dispose(); earth.material.dispose(); texture.dispose(); renderer.dispose(); renderer.domElement.remove(); controller.current = null
    }
  }, [matches,flat])
  useEffect(() => { controller.current?.focus(activeId, zoomed ? 2.25 : 3.4) }, [activeId, zoomed])
  return (
    <section className="earth-locator flat-capable-view" aria-label="地球候選定位">
      <ViewToggle
        flat={flat}
        onChange={value => {
          setRenderError(false)
          setFlat(value)
        }}
      />
      <div className="earth-locator-heading">
        <span>EARTH / 地球定位</span>
        <button onClick={() => controller.current?.reset()}>全地球視角</button>
      </div>
      <div
        className="earth-locator-canvas"
        ref={host}
        aria-label={flat ? '平面地球，紅點為候選地點' : '可拖曳旋轉的地球，紅點為候選地點'}
      >
        {flat && <FlatEarth matches={matches} activeId={activeId} onActive={onActive} />}
      </div>
      {renderError && <p role="status">此裝置無法顯示 3D 地球，仍可用下方候選清單切換比對。</p>}
      {textureError && <p role="status">地球影像暫時無法載入，可用下方地點清單選擇候選。</p>}

      {!flat && (
        <p>
          紅點代表候選；較大的紅點是重疊的多個候選。
          <br />
          點聚合標記放大，再選擇地點；拖曳可查看另一側。
        </p>
      )}
      {clusterIds.length > 1 && (
        <div className="earth-cluster-list" ref={clusterPanel} tabIndex={-1} role="group" aria-label="聚合中的候選">
          <div>
            <strong>選擇其中一個候選（{clusterIds.length}）</strong>
            <button type="button" onClick={() => setClusterIds([])}>
              收起
            </button>
          </div>
          {matches
            .filter(row => clusterIds.includes(row.id))
            .map(row => (
              <button
                type="button"
                key={row.id}
                onClick={() => {
                  setZoomed(true)
                  onActive(row.id)
                  setClusterIds([])
                  controller.current?.focus(row.id, 2.25)
                }}
              >
                {formatCoord(row.center.latitude, row.center.longitude_east)} ·{' '}
                {row.earth_lithology?.label || '岩性未知'}
              </button>
            ))}
        </div>
      )}
      <button
        className="earth-show-comparison"
        onClick={() =>
          document
            .getElementById('current-terrain-comparison')
            ?.scrollIntoView({
              behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
              block: 'start',
            })
        }
      >
        查看目前比對 <ArrowRight size={14} />
      </button>
    </section>
  )
}

export default function ResultsStage({ onVisual, onTerrain, data, activeId, onActive, onBack, status, onMore, loadingMore, searchError }) {
  const pageHeading = usePageHeading()
  const isMars = data.window.body === 'mars'
  const [isMobile,setIsMobile]=useState(()=>matchMedia('(max-width:800px)').matches)
  const [sheetOpen,setSheetOpen]=useState(false)
  const sheetGesture=useRef({y:null,moved:false})
  useEffect(()=>{
    const media=matchMedia('(max-width:800px)')
    const update=()=>setIsMobile(media.matches);media.addEventListener('change',update)
    return()=>media.removeEventListener('change',update)
  },[])
  useEffect(()=>{
    if(!isMobile||!sheetOpen)return
    const escape=e=>{if(e.key==='Escape'){setSheetOpen(false);document.getElementById('candidate-sheet-toggle')?.focus()}}
    document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape)
  },[isMobile,sheetOpen])
  const selectCandidate=id=>{
    onActive(id)
    if(isMobile){
      setSheetOpen(false)
      requestAnimationFrame(()=>{const region=document.getElementById('current-terrain-comparison'),heading=region?.querySelector('h2')||region
        if(heading){if(!heading.hasAttribute('tabindex'))heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true})}
        region?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'})})
    }
  }
  const [rockFilter, setRockFilter] = useState('all')
  const [offOnly, setOffOnly] = useState(false)
  const rockOptions = [...new Map(data.matches.filter(row => row.earth_lithology?.available).map(row => [row.earth_lithology.code, row.earth_lithology.label])).entries()]
  const visibleMatches = React.useMemo(() => data.matches.filter(row => (rockFilter === 'all' || row.earth_lithology?.code === rockFilter) && (!offOnly || row.catalogue_nearest?.off_catalogue)), [data.matches, rockFilter, offOnly])
  const active = visibleMatches.find(row => row.id === activeId) || visibleMatches[0] || data.matches[0]
  // Natural Earth place names (static tiles) for the candidates; coordinates until a tile arrives.
  const places = useEarthPlaces(data.matches)
  const placeOf = row => places[row.id]?.[getLanguage() === 'en' ? 1 : 0] || row.name.split(',')[0]
  const scrollToComparison = () => requestAnimationFrame(() => document.getElementById('current-terrain-comparison')
    ?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'instant' : 'smooth', block: 'start' }))
  const [comparisonMode, setComparisonMode] = useState('imagery')
  const cameraSync = React.useMemo(() => new EventTarget(), [])
  const [linkCameras, setLinkCameras] = useState(true)
  const [explore, setExplore] = useState(null)
  const [refined, setRefined] = useState({})
  const [refineState, setRefineState] = useState({})
  const [mineralMap, setMineralMap] = useState(null)
  const [materialModel, setMaterialModel] = useState(null)
  const [reportImageResponse,setReportImageResponse]=useState(null)
  const reportImageKey=[data.window.body,data.window.lat,data.window.lon,data.window.patch_km].join(':')
  const reportImagery=reportImageResponse?.key===reportImageKey?reportImageResponse.value:{state:'loading'}
  useEffect(()=>{
    if(!isMars)return
    const abort=new AbortController()
    requestJson(`/api/mars-imagery?lat=${data.window.lat}&lon=${data.window.lon}&size_km=${data.window.patch_km}`,{signal:abort.signal,timeoutMs:30000})
      .then(value=>setReportImageResponse({key:reportImageKey,value}))
      .catch(error=>{if(error.name!=='AbortError')setReportImageResponse({key:reportImageKey,value:{state:'unavailable'}})})
    return()=>abort.abort()
  },[isMars,reportImageKey])
  const [earthEnvironmentResponse, setEarthEnvironment] = useState(null)
  const earthEnvironment = earthEnvironmentResponse?.candidate_id === active.id ? earthEnvironmentResponse : null
  useEffect(() => {
    const abort = new AbortController()
    setEarthEnvironment(null)
    fetch(`/api/earth-environment?lat=${active.center.latitude}&lon=${active.center.longitude_east}`, { signal: abort.signal })
      .then(response => response.json())
      .then(result => setEarthEnvironment({ ...result, candidate_id: active.id }))
      .catch(error => { if (error.name !== 'AbortError') setEarthEnvironment({ available: false, reason: '地球環境資料載入失敗', candidate_id: active.id }) })
    return () => abort.abort()
  }, [active.id, active.center.latitude, active.center.longitude_east])
  useEffect(() => {
    if (isMars) return
    const abort = new AbortController()
    setMineralMap(null)
    fetch(`/api/moon-minerals?lat=${data.window.lat}&lon=${data.window.lon}&size_km=${data.window.patch_km}`, { signal: abort.signal })
      .then(response => response.json())
      .then(result => setMineralMap(result))
      .catch(error => { if (error.name !== 'AbortError') setMineralMap({ available: false, reason: '礦物圖載入失敗' }) })
    return () => abort.abort()
  }, [isMars, data.window.lat, data.window.lon, data.window.patch_km])
  useEffect(() => {
    if (isMars) return
    const abort = new AbortController()
    setMaterialModel(null)
    fetch(`/api/moon-material-model?lat=${data.window.lat}&lon=${data.window.lon}&size_km=${data.window.patch_km}`, { signal: abort.signal })
      .then(response => response.json())
      .then(result => setMaterialModel(result))
      .catch(error => { if (error.name !== 'AbortError') setMaterialModel({ available: false, reason: '研究材質模型載入失敗' }) })
    return () => abort.abort()
  }, [isMars, data.window.lat, data.window.lon, data.window.patch_km])
  useEffect(() => {
    if (refined[active.id] || refineState[active.id]) return
    setRefineState(previous => ({ ...previous, [active.id]: 'loading' }))
    fetch(`/api/refine?candidate_id=${encodeURIComponent(active.id)}`)
      .then(async response => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Copernicus DEM unavailable')
        return result
      })
      .then(result => setRefined(previous => ({ ...previous, [active.id]: result })))
      .catch(() => setRefineState(previous => ({ ...previous, [active.id]: 'unavailable' })))
  }, [active.id])
  const refinedCandidate = refined[active.id]
  const refinedSource = refinedCandidate?.source
  const earthTerrain = refinedCandidate?.terrain || active.terrain
  // Explorer warm-up: the selection's high-resolution DEM and the 3D models start downloading as soon as results show,
  // the current Earth candidate's DEM after the user has looked at it for a moment.
  useEffect(() => {
    prefetchExploreDem({ body: data.window.body, lat: data.window.lat, lon: data.window.lon, patchKm: data.window.patch_km })
    const t = window.setTimeout(() => prefetchExplorerModels(window.matchMedia?.('(hover: none) and (pointer: coarse)').matches, data.window.body), 2500)
    return () => window.clearTimeout(t)
  }, [data.window.body, data.window.lat, data.window.lon, data.window.patch_km])
  useEffect(() => {
    const t = window.setTimeout(() => prefetchExploreDem({ body: 'earth', lat: active.center.latitude, lon: active.center.longitude_east, patchKm: data.window.patch_km }), 1500)
    return () => window.clearTimeout(t)
  }, [active.id, data.window.patch_km])
  const sharedHeightScaleM = Math.max(300,
    ...data.window.terrain.heights_m.map(Math.abs),
    ...earthTerrain.heights_m.map(Math.abs))
  const resolution = refinedCandidate?.source?.resolution_note || active.resolution_note
  const moonTextureUrl = isMars ? null : `/api/surface-texture?body=moon&lat=${data.window.lat}&lon=${data.window.lon}&size_km=${data.window.patch_km}`
  const earthTextureUrl = `/api/surface-texture?extent=v2&body=earth&lat=${active.center.latitude}&lon=${active.center.longitude_east}&size_km=${data.window.patch_km}`
  const downloadDossier = () => {
    const content = candidateDossier({ data, active, rank: data.matches.findIndex(row => row.id === active.id) + 1,
      status, refinedCandidate, refineStatus: refineState[active.id], earthEnvironment, mineralMap, materialModel, marsImagery:isMars?reportImagery:undefined })
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `analog-atlas-${data.window.body}-${data.window.patch_km}km-${active.id.replace(/[^a-z0-9_-]/gi, '_')}.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const candidatePanel = (
    <div className="candidate-panel-content">
      <div className="candidate-filters">
        <label>
          地球區域岩性
          <select
            value={rockFilter}
            onChange={e => {
              setRockFilter(e.target.value)
              const next = data.matches.find(
                row => e.target.value === 'all' || row.earth_lithology?.code === e.target.value,
              )
              if (next) onActive(next.id)
            }}
          >
            <option value="all">全部岩性</option>
            {rockOptions.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <OffcatToggle checked={offOnly} onChange={setOffOnly} />
        <small>只篩選本次 {data.matches.length} 個候選；可回到選區修改全索引檢索條件。</small>
      </div>
      <div className="match-list-header">
        <span>候選地點</span>
        <span>{visibleMatches.length} 個結果</span>
      </div>
      {visibleMatches.map((row, i) => (
        <button
          className={`match-row ${row.id === active.id ? 'active' : ''}`}
          key={row.id}
          onClick={() => selectCandidate(row.id)}
        >
          <span className="match-location-dot" aria-hidden="true" />
          <span className="match-name">
            <strong>{placeOf(row)}</strong>
            <small>{formatCoord(row.center.latitude, row.center.longitude_east)}</small>
            {row.visual_similarity?.available && (
              <small>影像相似值 {row.visual_similarity.cosine.toFixed(3)} · 中心樣本</small>
            )}
            <small className="candidate-rock">
              {row.earth_lithology?.available ? row.earth_lithology.label : '岩性資料不足'}
            </small>
            {data.known_analog_catalogue?.available && row.known_analog && (
              <small className={`candidate-known fit-${knownAnalogInfo(row.known_analog, data.purpose).fit || 'none'}`}>既有類比<span>{' · '}{knownAnalogInfo(row.known_analog, data.purpose).name}{knownAnalogInfo(row.known_analog, data.purpose).type ? ` · ${knownAnalogInfo(row.known_analog, data.purpose).type}` : ''}</span></small>
            )}
            <OffcatTag row={row} />
            <small className="candidate-score">
              地形 {row.score}
              {row.material_context?.similarity != null && <> · 材質 {Math.round(row.material_context.similarity * 100)}</>}
            </small>
            {row.lavatube_context && (
              <small className="candidate-score">
                {row.lavatube_context.name} · {row.lavatube_context.distance_km} km
              </small>
            )}
          </span>
          <ChevronRight size={17} />
        </button>
      ))}
      <div className="candidate-expansion">
        {data.candidate_groups && (
          <p>
            前 {data.candidate_groups.shortlisted_windows} 筆候選窗格整理為 {data.candidate_groups.group_count}{' '}
            個空間群組，目前顯示 {data.matches.length} 組。群組不代表已驗證場址。
          </p>
        )}
        {nextCandidateOffset(data) !== null && (
          <button type="button" className="outline-button" disabled={loadingMore} onClick={onMore}>
            {loadingMore ? '正在載入…' : '顯示更多候選'}
          </button>
        )}
        {searchError && <p role="alert">{searchError}</p>}
      </div>
    </div>
  )
  return (
    <motion.main
      key="results"
      initial={{ opacity: 0, y: 26 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.12 }}
      className="results-page simple-results"
    >
      <ResultsNav signal={active?.id} />
      <ResultsGlance
        data={data}
        active={active}
        places={places}
        headingRef={pageHeading}
        onBack={onBack}
        onReport={downloadDossier}
        onCompare={id => { onActive(id); scrollToComparison() }}
        onExplore={id => { onActive(id); setExplore('earth') }}
        onShowAll={() => document.querySelector('.results-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onConditions={id => { onActive(id); setTimeout(() => document.getElementById('conditions-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60) }}
      />
      <div className="results-layout">
        <aside className="match-list">
          <EarthCandidates matches={visibleMatches} activeId={active.id} onActive={selectCandidate} />
          {isMobile
            ? createPortal(
                <section className={'candidate-sheet ' + (sheetOpen ? 'is-open' : '')} aria-label="手機候選面板">
                  <button
                    id="candidate-sheet-toggle"
                    className="candidate-sheet-toggle"
                    type="button"
                    aria-expanded={sheetOpen}
                    aria-controls="candidate-sheet-content"
                    onPointerDown={e => {
                      sheetGesture.current = { y: e.clientY, moved: false }
                      e.currentTarget.setPointerCapture(e.pointerId)
                    }}
                    onPointerUp={e => {
                      const dy = e.clientY - sheetGesture.current.y
                      if (Math.abs(dy) > 35) {
                        sheetGesture.current.moved = true
                        setSheetOpen(dy < 0)
                      }
                    }}
                    onPointerCancel={() => {
                      sheetGesture.current = { y: null, moved: false }
                    }}
                    onClick={() => {
                      if (sheetGesture.current.moved) {
                        sheetGesture.current.moved = false
                        return
                      }
                      setSheetOpen(x => !x)
                    }}
                  >
                    <span className="sheet-grip" aria-hidden="true" />
                    {sheetOpen ? '收合候選清單' : '展開候選清單'} · {data.matches.length} 個候選
                  </button>
                  <div id="candidate-sheet-content" className="candidate-sheet-content" hidden={!sheetOpen}>
                    {candidatePanel}
                  </div>
                </section>,
                document.body,
              )
            : candidatePanel}
        </aside>
        <section className="reconstruction" id="current-terrain-comparison">
          <div className="reconstruction-top">
            <div>
              <span className="micro-label">TERRAIN COMPARISON</span>
              <h2>地形並排比較</h2>
            </div>
            <div className="comparison-switch" role="group" aria-label="地形比較顯示方式">
              <button
                type="button"
                aria-pressed={comparisonMode === 'shape'}
                className={comparisonMode === 'shape' ? 'active' : ''}
                onClick={() => setComparisonMode('shape')}
              >
                純地形比較
              </button>
              <button
                type="button"
                aria-pressed={comparisonMode === 'imagery'}
                className={comparisonMode === 'imagery' ? 'active' : ''}
                onClick={() => setComparisonMode('imagery')}
              >
                真實影像
              </button>
            </div>
          </div>
          <div className="terrain-pair">
            <div className="terrain-panel">
              <div className="terrain-panel-header">
                <span>{isMars ? '火星選區' : '月球選區'}</span>
                <strong>{formatCoord(data.window.lat, data.window.lon)}</strong>
              </div>
              <TerrainView
                terrain={data.window.terrain}
                tone={comparisonMode === 'shape' ? 'shape' : isMars ? 'mars' : 'moon'}
                label={`${isMars ? '火星' : '月球'}窗格 DEM 三維重建`}
                textureUrl={comparisonMode === 'imagery' ? moonTextureUrl : null}
                textureCredit="NASA SVS · LROC WAC"
                heightScaleM={sharedHeightScaleM}
                cameraSync={linkCameras ? cameraSync : null}
                onExplore={() => setExplore('target')}
              />
              <div className="terrain-panel-footer">
                <span>高程起伏</span>
                <strong>{data.window.terrain.relief_m.toLocaleString()} m</strong>
              </div>
            </div>
            <div className="terrain-vs">VS</div>
            <div className="terrain-panel">
              <div className="terrain-panel-header">
                <span>地球候選</span>
                <strong>{placeOf(active)}</strong>
              </div>
              <TerrainView
                terrain={earthTerrain}
                tone={comparisonMode === 'shape' ? 'shape' : 'earth'}
                label="地球候選 DEM 三維重建"
                textureUrl={comparisonMode === 'imagery' ? earthTextureUrl : null}
                textureCredit="Esri · World Imagery"
                heightScaleM={sharedHeightScaleM}
                cameraSync={linkCameras ? cameraSync : null}
                onExplore={() => setExplore('earth')}
              />
              <div className="terrain-panel-footer">
                <span>高程起伏</span>
                <strong>{earthTerrain.relief_m.toLocaleString()} m</strong>
              </div>
            </div>
          </div>
          <p className="flat-comparison-note">
            目前含 2D 高程圖：北在上，兩側色階範圍相同，以各自窗格中位數為零。高程圖不貼合衛星影像；可展開下方 2D 影像並排。
          </p>
          <label className="camera-link">
            <input type="checkbox" checked={linkCameras} onChange={e => setLinkCameras(e.target.checked)} />
            連動旋轉與縮放
          </label>
          <p className="comparison-hint">
            拖曳旋轉、滾輪縮放。兩側採相同垂直比例：
            {((0.78 * data.window.patch_km * 1000) / (3.2 * sharedHeightScaleM)).toFixed(1)} 倍。窗格寬{' '}
            {data.window.patch_km} km；地球高程解析度：{resolution}。
          </p>
          <ImageryComparison query={data.window} active={active} moonUrl={moonTextureUrl} earthUrl={earthTextureUrl} />
          <details className="result-technical">
            <summary>重建方式與解析度</summary>
            <div className="resolution-state">
              {refinedCandidate
                ? 'COPERNICUS GLO-90 · 90 m 高解析重建完成'
                : refineState[active.id] === 'loading'
                  ? 'COPERNICUS GLO-90 · 正在載入原始高程'
                  : 'ETOPO / SRTM · 使用搜尋格網重建'}
            </div>
            <div className="reconstruction-note">
              <Info size={16} />
              <span>
                拖曳旋轉、滾輪縮放。
                {isMars
                  ? '火星使用來源高程配色；地球為 DEM 貼合 Esri World Imagery。'
                  : '月球為 LOLA 高程貼合 NASA SVS／LROC 影像；地球為 DEM 貼合 Esri World Imagery。'}
                兩側使用相同的垂直比例（仍為展示而放大），「純地形比較」用同一灰階檢查形狀；地球高程解析度：{resolution}
                。這是可追溯的影像貼合網格，Skyfall-GS 多視角 3DGS 與擴散精修尚未對這些候選完成訓練。影像不參與搜尋排名，也不能據此推斷礦物。
                {isMars && '火星輸入對月球訓練編碼器的轉移尚未驗證。'}
              </span>
            </div>
          </details>
          {explore && (
            <Suspense
              fallback={
                <div className="eva-loading eva-boot" role="status">
                  載入探索場景…
                </div>
              }
            >
              <AstronautExplorer
                key={active.id + explore}
                initialWorld={explore}
                onClose={() => setExplore(null)}
                target={{
                  body: isMars ? 'mars' : 'moon',
                  lat: data.window.lat,
                  lon: data.window.lon,
                  patchKm: data.window.patch_km,
                  terrain: data.window.terrain,
                  textureUrl: moonTextureUrl,
                  textureCredit: 'NASA SVS · LROC WAC',
                  minerals: !isMars && mineralMap?.available ? { order: mineralMap.mineral_order, grid: mineralMap.dominant_mineral_index_grid } : null,
                  geochem: !isMars && data.moon_geochemistry?.available ? data.moon_geochemistry : null,
                  label: `${formatCoord(data.window.lat, data.window.lon)} · ${data.window.patch_km} × ${data.window.patch_km} km`,
                }}
                earth={{
                  body: 'earth',
                  lat: active.center.latitude,
                  lon: active.center.longitude_east,
                  patchKm: data.window.patch_km,
                  terrain: earthTerrain,
                  textureUrl: earthTextureUrl,
                  textureCredit: 'Imagery: Esri, Vantor / Maxar, Earthstar Geographics, GIS User Community',
                  label: placeOf(active),
                  lithology: active.earth_lithology?.available ? active.earth_lithology.label : null,
                }}
              />
            </Suspense>
          )}
        </section>
      </div>
      <ConditionsPanel data={data} matches={visibleMatches} active={active} place={placeOf(active)} earthEnvironment={earthEnvironment} onActive={onActive} placeOf={placeOf} />
      <MaxMatchPanel data={data} active={active} />
      <FacetsPanel data={data} active={active} />
      <ResourcePanel data={data} active={active} />
      <PhysicalMatchPanel data={data} active={active} />
      {data.lavatube ? (
        <LavaTubePanel data={data} activeId={active.id} onActive={selectCandidate} />
      ) : data.material ? (
        <MaterialPanel data={data} activeId={active.id} onActive={selectCandidate} />
      ) : (
        <GlobalVisualPanel data={data} onVisual={onVisual} onTerrain={onTerrain} busy={loadingMore} />
      )}
      {active.spatial_group && (
        <details className="source-detail">
          <summary>此候選附近的 {active.spatial_group.window_count} 個窗格</summary>
          <p>
            按排名代表中心 {data.candidate_groups.radius_km} km 半徑整理，僅涵蓋前{' '}
            {data.candidate_groups.shortlisted_windows} 筆；不是地質場址邊界。
          </p>
          <ul className="group-members">
            {active.spatial_group.members.map(m => (
              <li key={m.id}>
                {formatCoord(m.center.latitude, m.center.longitude_east)} · 排序值 {m.fusion_score.toFixed(3)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <TerrainDiagnostics data={data} active={active} />
      <details className="source-detail">
        <summary>更多地表與岩性對照</summary>
        <section className="surface-evidence" aria-label="地表與岩性對照">
          <div className="surface-evidence-title">
            <h2>除了形狀，地表也相同嗎？</h2>
            <span>
              {data.context_ranking?.context_applied ? '已納入區域證據 · 精細材質未驗證' : '尚未確認材質對應'}
            </span>
          </div>
          <div className="surface-evidence-grid">
            <article>
              <h3>{isMars ? '火星選區' : '月球選區'}</h3>
              <dl>
                <dt>地質背景</dt>
                <dd>
                  {!isMars && data.moon_geology?.available
                    ? `${data.moon_geology.dominant_unit.code} · ${data.moon_geology.dominant_unit.description}`
                    : '尚無此選區的地質分類'}
                </dd>
                <dt>沙地／裸岩／岩層</dt>
                <dd>尚無同尺度地表分類</dd>
              </dl>
            </article>
            <article>
              <h3>地球候選</h3>
              <dl>
                <dt>區域岩性</dt>
                <dd>{active.earth_lithology?.available ? active.earth_lithology.label : '資料不足'}</dd>
                <dt>年均每日降水</dt>
                <dd>
                  {earthEnvironment?.available
                    ? message`${earthEnvironment.precipitation_annual_mean_mm_day.toFixed(2)} mm／日`
                    : earthEnvironment
                      ? '資料不足'
                      : '讀取中…'}
                </dd>
                <dt>沙漠地域取樣</dt>
                <dd>
                  {data.context_ranking?.target.surface === 'desert'
                    ? message`${Math.round((active.context_match?.desert_sample_share || 0) * 100)}% 格點落在沙漠／乾燥灌叢地域`
                    : '本次未套用沙漠地域條件'}
                </dd>
                <dt>指定岩性取樣</dt>
                <dd>
                  {data.context_ranking?.target.rock !== 'any'
                    ? message`${Math.round((active.context_match?.rock_sample_share || 0) * 100)}% 格點符合目標岩性`
                    : '本次不限岩性'}
                </dd>
              </dl>
            </article>
          </div>
          <p>
            岩性來自 GLiM 0.5° 區域格網，不能確認裸露岩層、層理或沙地。降水為 NASA POWER 區域氣候背景。地域與指定岩性已參與聯合排序；降水仍只供參考。沙漠地域不等於沙地，岩性也不等於裸露岩層。
          </p>
        </section>
      </details>
      <div className="candidate-location">
        <div>
          <span>目前候選</span>
          <strong>{placeOf(active)}</strong>
        </div>
        <a
          className="outline-button"
          href={`https://www.openstreetmap.org/#map=10/${active.center.latitude}/${active.center.longitude_east}`}
          target="_blank"
          rel="noreferrer"
        >
          在地圖上查看 <ArrowUpRight size={15} />
        </a>
      </div>
    </motion.main>
  )
}
