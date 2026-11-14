import {TerrainSampling} from './terrain_sampling.jsx'
import {useModalFocus,usePageHeading} from './modal_focus.js'
import {requestJson} from './api_request.js'
import {useLanguage,LanguageSwitch} from './i18n/language.jsx'
import {message,getLanguage} from './i18n/core.js'
import {useFlatView,ViewToggle,FlatPlanet} from './flat_view.jsx'
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  ArrowRight, ArrowUpRight,
  Crosshair, Grip, Layers3,
  Rotate3D,
} from 'lucide-react'
// The results page imports this sheet too; importing it here keeps it ahead of style.css in the cascade.
import './imagery_comparison.css'
import './style.css'
import './cover_theme.css'
import './upgrade_v2.css'
import { PurposeTiles, PurposeNote, ConditionTiles, UseChips, FacetUseChips } from './selection_tiles.jsx'
import { Landing } from './landing.jsx'
import { MusicToggle, trackFor } from './music_player.jsx'
import { renderGate } from './render_gate.js'
import {nextCandidateOffset,mergeCandidatePage} from './candidate_paging.js'
import { PURPOSES } from './purposes.js'
import { SkylightPresets } from './skylight_presets.jsx'
import { TerrainReadCard } from './terrain_read_card.jsx'
import { clamp, formatCoord, lonLatPoint } from './planet_geo.js'
import { TerrainView } from './terrain_view.jsx'

// The results page is its own chunk, so the home page never downloads it. It is fetched when the selection page
// opens and search() awaits it together with the search request; by the time the results stage renders the module
// is loaded, and React.lazy then resolves synchronously instead of flashing the Suspense fallback.
let resultsModule = null
const loadResults = () => import('./results_stage.jsx').then(module => (resultsModule = module))
const ChatSearch = React.lazy(() => import('./chat_search.jsx'))
const AssistantWidget = React.lazy(() => import('./assistant_widget.jsx'))
const ResultsStage = React.lazy(() => (resultsModule ? { then: resolve => resolve(resultsModule) } : loadResults()))

const PRESETS = [
  { id: '01', name: '南方環形山', lat: -43.3, lon: -11.4, type: 'CRATER FIELD' },
  { id: '02', name: '寧靜海上部', lat: 8.7, lon: 27.4, type: 'MARE UNIT' },
  { id: '03', name: '西側月海', lat: 21.4, lon: -39.2, type: 'MARE EDGE' },
  { id: '04', name: '北方月海', lat: 42.1, lon: -8.6, type: 'MARE UNIT' },
  { id: '05', name: '東側月海', lat: -17.8, lon: 58.2, type: 'MARE UNIT' },
  { id: '06', name: '背面盆地交界', lat: 12.5, lon: 143.0, type: 'MIXED UNITS' },
  { id: '07', name: '南部高地覆層', lat: -56.8, lon: 34.1, type: 'TERRA UNIT' },
  { id: '08', name: '赤道平原', lat: 1.6, lon: -67.3, type: 'PLAINS UNIT' },
]

const FULL_MOON_DISTANCE = 3.5
const moonFitDistance = (width, height) => {
  const halfFov = Math.atan(Math.tan(42 * Math.PI / 360) * Math.min(1, width / height))
  return Math.max(FULL_MOON_DISTANCE, 1.02 * 1.12 / Math.sin(halfFov))
}

function localMoonPoint(lat, lon, eastKm, northKm, radius = 1.046, planetRadius = 1737.4) {
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
  const center = new THREE.Vector3(Math.cos(phi) * Math.cos(lambda), Math.sin(phi), -Math.cos(phi) * Math.sin(lambda))
  const east = new THREE.Vector3(-Math.sin(lambda), 0, -Math.cos(lambda))
  const north = new THREE.Vector3(-Math.sin(phi) * Math.cos(lambda), Math.cos(phi), Math.sin(phi) * Math.sin(lambda))
  const length = Math.hypot(eastKm, northKm)
  const angle = length / planetRadius
  return center.multiplyScalar(Math.cos(angle)).add(east.multiplyScalar(eastKm).add(north.multiplyScalar(northKm)).multiplyScalar(Math.sin(angle) / Math.max(length, 1e-9))).multiplyScalar(radius)
}

function faceMoonLocation(moon, lat, lon) {
  const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lat * Math.PI / 180)
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-lon - 90) * Math.PI / 180)
  moon.quaternion.copy(pitch.multiply(yaw))
}

function MoonGlobe({ selected, onPick, onHover, onDraft, mode = 'rotate', sizeKm = 40, compact = false, focusTarget = null, body = 'moon' }) {
  const host = useRef(null)
  const [flat,setFlat]=useFlatView()
  const pickRef = useRef(onPick)
  const hoverRef = useRef(onHover)
  const draftRef = useRef(onDraft)
  const modeRef = useRef(mode)
  const sizeRef = useRef(sizeKm)
  const selectedRef = useRef(selected)
  const markerRef = useRef(null)
  const frameRef = useRef(null)
  const fillRef = useRef(null)
  const groupRef = useRef(null)
  const viewRef = useRef(null)
  pickRef.current = onPick
  hoverRef.current = onHover
  draftRef.current = onDraft
  modeRef.current = mode
  sizeRef.current = sizeKm
  selectedRef.current = selected

  useEffect(() => {
    if (!host.current || flat) return
    const width = host.current.clientWidth
    const height = host.current.clientHeight
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100)
    camera.position.set(0, 0, compact ? 3.25 : moonFitDistance(width, height))
    let renderer
    try {renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })} catch {setFlat(true);return}
    const mobileRenderer = window.matchMedia('(max-width: 700px)').matches
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileRenderer ? 1.35 : 2))
    renderer.setSize(width, height)
    renderer.domElement.addEventListener('webglcontextlost', event=>{event.preventDefault();setFlat(true)}, {once:true})
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.current.appendChild(renderer.domElement)
    const light = new THREE.DirectionalLight(0xf8eee0, 3.6)
    light.position.set(-2.5, 2.3, 4)
    scene.add(light, new THREE.AmbientLight(0xafafaf, compact ? 0.45 : 1.2))
    const moon = new THREE.Group()
    if (compact) moon.rotation.y = -Math.PI / 2
    else faceMoonLocation(moon, selected.lat, selected.lon)
    scene.add(moon)
    groupRef.current = moon
    const loader = new THREE.TextureLoader()
    const color = loader.load(body === 'mars' ? '/mars-viking.jpg' : '/moon-color.webp')
    const heightMap = body === 'mars' ? null : loader.load('/moon-height.webp')
    color.colorSpace = THREE.SRGBColorSpace
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 96),
      new THREE.MeshStandardMaterial({
        map: color, displacementMap: heightMap, displacementScale: 0.035,
        displacementBias: -0.0175, roughness: 1, metalness: 0,
      }),
    )
    moon.add(sphere)
    const marker = new THREE.Group()
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.033, 0.039, 48),
      new THREE.MeshBasicMaterial({ color: 0xf6f6f6, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
    )
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.003, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    marker.add(ring, dot)
    marker.visible = !compact
    moon.add(marker)
    markerRef.current = marker
    const hoverMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.044, 0.048, 48),
      new THREE.MeshBasicMaterial({ color: 0xf1ffed, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }),
    )
    hoverMarker.visible = false
    moon.add(hoverMarker)
    const selectionFrame = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xfcfcfc, transparent: true, opacity: 0.97 }))
    selectionFrame.visible = !compact
    moon.add(selectionFrame)
    frameRef.current = selectionFrame
    const selectionFill = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xebebeb, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthWrite: false }))
    selectionFill.visible = !compact
    moon.add(selectionFill)
    fillRef.current = selectionFill
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.enableZoom = true
    controls.minDistance = compact ? 2.4 : 1.35
    controls.maxDistance = 5.2
    controls.enableDamping = true
    controls.rotateSpeed = 0.65
    viewRef.current = { camera, controls, fullDistance: camera.position.length(), isFullView: true }
    const onControlEnd = () => {
      if (viewRef.current && Math.abs(camera.position.length() - viewRef.current.fullDistance) > 0.1) viewRef.current.isFullView = false
    }
    controls.addEventListener('end', onControlEnd)
    const resize = new ResizeObserver(() => {
      if (!host.current) return
      const w = host.current.clientWidth, h = host.current.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      if (!compact) {
        const nextDistance = moonFitDistance(w, h)
        if (viewRef.current.isFullView) camera.position.setLength(nextDistance)
        viewRef.current.fullDistance = nextDistance
      }
      renderer.setSize(w, h)
    })
    resize.observe(host.current)
    const raycaster = new THREE.Raycaster()
    let pointerStart = null
    const activePointers = new Set()
    let multiTouchGesture = false
    const coordinatesAt = e => {
      const box = renderer.domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1,
        -((e.clientY - box.top) / box.height) * 2 + 1)
      raycaster.setFromCamera(mouse, camera)
      const hit = raycaster.intersectObject(sphere)[0]
      if (!hit) return null
      const lunar = moon.worldToLocal(hit.point.clone()).normalize()
      return {
        lat: clamp(THREE.MathUtils.radToDeg(Math.asin(clamp(lunar.y, -1, 1))), -89.5, 89.5),
        lon: THREE.MathUtils.radToDeg(Math.atan2(-lunar.z, lunar.x)),
      }
    }
    const showHover = position => {
      hoverMarker.visible = Boolean(position) && !compact
      if (!position || compact) return
      const point = lonLatPoint(position.lat, position.lon, 1.052)
      hoverMarker.position.copy(point)
      hoverMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), point.clone().normalize())
      hoverMarker.scale.setScalar(clamp(sizeRef.current / 40, 0.75, 1.3))
    }
    const selectionAt = (position, start) => {
      if (!position || !start?.grabFrame) return position
      const lon = position.lon + start.offsetLon
      return { lat: clamp(position.lat + start.offsetLat, -89.5, 89.5), lon: ((lon + 180) % 360 + 360) % 360 - 180 }
    }
    const pointerDown = e => {
      activePointers.add(e.pointerId)
      if (activePointers.size > 1) { multiTouchGesture = true; pointerStart = null; return }
      renderer.domElement.setPointerCapture(e.pointerId)
      const position = coordinatesAt(e)
      const selectedPoint = selectedRef.current
      const markerWorld = selectedPoint && lonLatPoint(selectedPoint.lat, selectedPoint.lon, 1.047)
        .applyQuaternion(moon.quaternion)
      const projected = markerWorld?.clone().project(camera)
      const box = renderer.domElement.getBoundingClientRect()
      const markerX = projected && box.left + (projected.x + 1) * box.width / 2
      const markerY = projected && box.top + (1 - projected.y) * box.height / 2
      // The physical window can project to just a few pixels in the full view.
      // Keep its drag target large enough for a finger without changing its footprint.
      const markerVisible = markerWorld && markerWorld.dot(camera.position.clone().normalize()) > 1 / camera.position.length()
      // The selected square is draggable in either mode. Keep the target
      // smaller in rotation mode so the surrounding globe still rotates.
      const grabRadius = modeRef.current === 'select'
        ? (e.pointerType === 'touch' ? 48 : 34)
        : (e.pointerType === 'touch' ? 30 : 18)
      const grabFrame = !compact && position && markerVisible && projected?.z < 1 &&
        Math.hypot(e.clientX - markerX, e.clientY - markerY) < grabRadius
      if (grabFrame) controls.enableRotate = false
      pointerStart = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, lastPosition: position, grabFrame, moved: false,
        offsetLat: grabFrame ? selectedPoint.lat - position.lat : 0,
        offsetLon: grabFrame ? selectedPoint.lon - position.lon : 0 }
      if (!compact && (modeRef.current === 'select' || grabFrame) && position) draftRef.current?.(selectionAt(position, pointerStart))
    }
    const pointerCancel = e => {
      activePointers.delete(e.pointerId)
      pointerStart = null
      controls.enableRotate = compact || modeRef.current !== 'select'
      draftRef.current?.(null)
      showHover(null)
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId)
      if (!activePointers.size) multiTouchGesture = false
    }
    const pointerMove = e => {
      // A finger can drag the selected footprint while the globe remains in
      // rotation mode. Ignore only an ordinary touch orbit gesture here.
      if (e.pointerType === 'touch' && !(pointerStart && (modeRef.current === 'select' || pointerStart.grabFrame))) return
      const position = coordinatesAt(e)
      showHover(position)
      if (pointerStart?.id === e.pointerId) {
        if (Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > (pointerStart.type === 'touch' ? 10 : 5)) pointerStart.moved = true
        if (position) pointerStart.lastPosition = position
      }
      if (!compact && (modeRef.current === 'select' || pointerStart?.grabFrame) && pointerStart?.id === e.pointerId && !multiTouchGesture && position) draftRef.current?.(pointerStart.grabFrame && pointerStart.moved ? selectionAt(position, pointerStart) : position)
      hoverRef.current?.(position)
    }
    const pointerLeave = () => { showHover(null); hoverRef.current?.(null) }
    const pointerUp = e => {
      const start = pointerStart
      pointerStart = null
      controls.enableRotate = compact || modeRef.current !== 'select'
      draftRef.current?.(null)
      showHover(null)
      activePointers.delete(e.pointerId)
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId)
      const wasMultiTouch = multiTouchGesture
      if (!activePointers.size) multiTouchGesture = false
      if (wasMultiTouch || !start || start.id !== e.pointerId) return
      if ((compact || (modeRef.current !== 'select' && !start.grabFrame)) && Math.hypot(e.clientX - start.x, e.clientY - start.y) > (start.type === 'touch' ? 16 : 7)) return
      const position = coordinatesAt(e) || (modeRef.current === 'select' || start.grabFrame ? start.lastPosition : null)
      const moved = start.moved || Math.hypot(e.clientX - start.x, e.clientY - start.y) > (start.type === 'touch' ? 10 : 5)
      // A tap anywhere on the visible terrain selects that exact point. Only
      // a real drag of the current marker keeps the pointer-to-marker offset.
      const next = start.grabFrame && moved ? selectionAt(position, start) : position
      if (next) {
        pickRef.current?.(next.lat, next.lon)
        // Keep the overview after a pick. Auto-zooming to 1.65 hid almost the
        // entire Moon, so the next region could no longer be selected easily.
        // The explicit focus control below provides precision zoom on demand.
      }
    }
    renderer.domElement.addEventListener('pointerdown', pointerDown)
    renderer.domElement.addEventListener('pointermove', pointerMove)
    renderer.domElement.addEventListener('pointerup', pointerUp)
    renderer.domElement.addEventListener('pointercancel', pointerCancel)
    renderer.domElement.addEventListener('pointerleave', pointerLeave)
    let frame, visible = true, lastFrame = 0
    const visibility = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true }, { threshold: 0.01 })
    visibility.observe(host.current)
    const frameInterval = mobileRenderer ? 1000 / 30 : 1000 / 60
    const render = timestamp => {
      frame = requestAnimationFrame(render)
      if (!visible || renderGate.paused || document.visibilityState !== 'visible' || timestamp - lastFrame < frameInterval) return
      lastFrame = timestamp
      controls.update()
      renderer.render(scene, camera)
    }
    frame = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(frame)
      visibility.disconnect()
      controls.dispose()
      controls.removeEventListener('end', onControlEnd)
      resize.disconnect()
      renderer.domElement.removeEventListener('pointerdown', pointerDown)
      renderer.domElement.removeEventListener('pointermove', pointerMove)
      renderer.domElement.removeEventListener('pointerup', pointerUp)
      renderer.domElement.removeEventListener('pointercancel', pointerCancel)
      renderer.domElement.removeEventListener('pointerleave', pointerLeave)
      viewRef.current = null
      markerRef.current=null;frameRef.current=null;fillRef.current=null;groupRef.current=null
      scene.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose() })
      color.dispose(); heightMap?.dispose(); renderer.dispose()
      renderer.domElement.remove()
    }
  }, [compact, body, flat])

  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.controls.enableRotate = compact || mode !== 'select'
    viewRef.current.controls.enableZoom = true
  }, [compact, mode])

  useEffect(() => {
    if (!focusTarget || !groupRef.current || !viewRef.current) return
    viewRef.current.controls.reset()
    faceMoonLocation(groupRef.current, focusTarget.lat, focusTarget.lon)
    viewRef.current.isFullView = focusTarget.distance === 'full'
    viewRef.current.camera.position.set(0, 0, viewRef.current.isFullView ? viewRef.current.fullDistance : focusTarget.distance || 1.72)
    viewRef.current.controls.update()
  }, [focusTarget])

  useEffect(() => {
    if (!markerRef.current || !selected) return
    const point = lonLatPoint(selected.lat, selected.lon, 1.047)
    markerRef.current.position.copy(point)
    markerRef.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), point.clone().normalize())
    markerRef.current.scale.setScalar(clamp(sizeKm / 40, 0.8, 1.2))
    if (frameRef.current) {
      // Draw the same physical footprint used by the DEM request.
      const half = sizeKm / 2
      const corners = [
        [-half, half], [half, half], [half, -half], [-half, -half],
      ]
      const positions = []
      corners.forEach((start, side) => {
        const end = corners[(side + 1) % 4]
        for (let j = 0; j < 16; j++) {
          const a = j / 16, b = (j + 1) / 16
          const p = localMoonPoint(selected.lat, selected.lon, start[0] * (1 - a) + end[0] * a, start[1] * (1 - a) + end[1] * a, 1.046, body === 'mars' ? 3396 : 1737.4)
          const q = localMoonPoint(selected.lat, selected.lon, start[0] * (1 - b) + end[0] * b, start[1] * (1 - b) + end[1] * b, 1.046, body === 'mars' ? 3396 : 1737.4)
          positions.push(p.x, p.y, p.z, q.x, q.y, q.z)
        }
      })
      frameRef.current.geometry.dispose()
      frameRef.current.geometry = new THREE.BufferGeometry()
      frameRef.current.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      if (fillRef.current) {
        const corners3d = corners.map(([east, north]) => localMoonPoint(selected.lat, selected.lon, east, north, 1.044, body === 'mars' ? 3396 : 1737.4))
        const vertices = [0, 1, 2, 0, 2, 3].flatMap(index => corners3d[index].toArray())
        fillRef.current.geometry.dispose()
        fillRef.current.geometry = new THREE.BufferGeometry()
        fillRef.current.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
      }
    }
  }, [selected?.lat, selected?.lon, sizeKm, body])

  return (
    <div className="flat-capable-view">
      <ViewToggle flat={flat} onChange={setFlat} />
      <div
        ref={host}
        className={`globe-canvas ${!compact && mode === 'select' ? 'is-selecting' : ''}`}
        aria-label={
          flat
            ? body === 'mars'
              ? '火星平面定位'
              : '月球平面定位'
            : body === 'mars'
              ? '火星模型：拖曳旋轉、點擊選區'
              : compact
                ? '入口月球模型：拖曳旋轉、縮放，點選月面直接進入選區'
                : mode === 'select'
                  ? '月球選區模式：點擊或拖曳月面，移動方形窗格'
                  : '月球旋轉模式：拖曳旋轉、點擊選區'
        }
      >
        {flat && <FlatPlanet body={body} selected={selected} onPick={onPick} />}
      </div>
    </div>
  )
}

function Header({ stage, body, onHome, onBody, onResults, onChat }) {
  const method = '/technology/paper-en.html'
  const current = key => (key === 'results' ? stage === 2 : stage === 1 && body === key) ? 'page' : undefined
  return <header className="topbar">
    <button className="brand" onClick={onHome} aria-label="返回入口頁">
      <span className="brand-word">TwinGround</span>
    </button>
    <nav className="topnav" aria-label="網站導覽">
      <button type="button" className="topnav-link" aria-current={current('moon')} onClick={() => onBody('moon')}>月球</button>
      <button type="button" className="topnav-link" aria-current={current('mars')} onClick={() => onBody('mars')}>火星</button>
      {onResults && <button type="button" className="topnav-link" aria-current={current('results')} onClick={onResults}>搜尋結果</button>}
      {onChat && <button type="button" className="topnav-link" aria-current={stage === 3 ? 'page' : undefined} onClick={onChat}>{getLanguage() === 'en' ? 'Ask' : '對話搜尋'}</button>}
      <a className="topnav-link" href={getLanguage() === 'en' ? '/offcatalogue/en.html' : '/offcatalogue/'}>{getLanguage() === 'en' ? 'Off-catalogue' : '目錄外的候選'}</a>
      <a className="topnav-link" href={method}>方法與原理 <ArrowUpRight size={13} /></a>
    </nav>
    <div className="header-right"><MusicToggle track={trackFor(stage, body)} /><LanguageSwitch/></div>
  </header>
}

function TileRail({ selected, onPick }) {
  const ref = useRef(null)
  const drag = useRef(null)
  return (
    <div className="tile-rail-wrap">
      <div className="rail-top">
        <div>
          <span className="micro-label">CURATED WINDOWS</span>
          <h3>或者，滑動挑選一個窗格</h3>
        </div>
        <span className="rail-hint">
          <Grip size={15} /> DRAG TO EXPLORE
        </span>
      </div>
      <div
        className="tile-rail"
        ref={ref}
        onPointerDown={e => {
          drag.current = [e.clientX, ref.current.scrollLeft]
        }}
        onPointerMove={e => {
          if (drag.current) ref.current.scrollLeft = drag.current[1] - (e.clientX - drag.current[0])
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {PRESETS.map(item => {
          const active = Math.abs(item.lat - selected.lat) < 0.01 && Math.abs(item.lon - selected.lon) < 0.01
          return (
            <button
              key={item.id}
              className={`tile-card ${active ? 'selected' : ''}`}
              onClick={() => onPick(item.lat, item.lon)}
            >
              <span className="tile-index">WINDOW / {item.id}</span>
              <span
                className="tile-thumb"
                style={{ backgroundPosition: `${((item.lon + 180) / 360) * 100}% ${((90 - item.lat) / 180) * 100}%` }}
              />
              <span className="tile-name">{item.name}</span>
              <span className="tile-meta">
                {item.type} <ArrowUpRight size={14} />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Everything that differs between the Moon and Mars selection pages. Texts stay literal strings: the i18n catalog
// matches them exactly and scripts/audit_i18n.mjs checks them. The Viking mosaic gains no detail past 8×, so the
// Mars map stops there; the Moon map swaps in LOLA hillshade tiles from 16×.
const SELECT_BODIES = {
  moon: {
    title: '月球探索', liveModel: 'LIVE MOON MODEL', projection: 'EQUIRECTANGULAR / LRO',
    globeSelectHint: '拖曳月面移動窗格 · 點一下選取', globeRotateHint: '拖曳旋轉月球 · 點一下放置窗格',
    globeModes: '月球球面操作模式', rotate: '旋轉月球', fullView: '全月視角',
    terrainLabel: '月球所選地區實測地形', source: 'LOLA',
    latitudeLabel: '月球緯度；北緯為正，南緯為負', longitudeLabel: '月球經度；東經為正，西經為負',
    dialogLabel: 'LUNAR REGION SELECTOR', dialogTitle: '選擇月球上的方形區域',
    dialogHint: '點全月地圖上的任意位置可連續重選；按「放大選區」後點選或拖曳方框微調。需要移動地圖時切換「平移地圖」。',
    map: {
      image: '/moon-color.webp', imageAlt: '月球等距矩形全球影像', kmPerDegree: 30.32, maxZoom: 64, focusZoom: 32,
      quickLabel: 'MOON / QUICK LOCATOR', fullLabel: 'FULL MOON / 2D LOCATOR',
      quickTitle: '全月選點，再放大微調', fullTitle: '在全月地圖上精準定位',
      pickHint: '點選全月任意位置，可連續重選；按「放大選區」再微調', refineHint: '點選或拖曳方框微調；按「重選全月區域」可選遠方',
      zoomOut: '縮小月球地圖', zoomIn: '放大月球地圖', modes: '月球地圖操作模式', scales: '月球方形窗格邊長',
      selectLabel: '月球地圖：點擊或拖曳任意位置選取方形窗格', panLabel: '月球地圖：拖曳平移，點擊選取',
    },
  },
  mars: {
    title: '火星探索', liveModel: 'LIVE MARS MODEL', projection: 'EQUIRECTANGULAR / VIKING',
    globeSelectHint: '拖曳火星表面移動窗格 · 點一下選取', globeRotateHint: '拖曳旋轉火星 · 點一下放置窗格',
    globeModes: '火星球面操作模式', rotate: '旋轉火星', fullView: '全火星視角',
    terrainLabel: '火星所選地區實測地形', source: 'MOLA',
    latitudeLabel: '火星緯度；北緯為正，南緯為負', longitudeLabel: '火星經度；東經為正，西經為負',
    dialogLabel: 'MARS REGION SELECTOR', dialogTitle: '選擇火星上的方形區域',
    dialogHint: '點全火星地圖上的任意位置可連續重選；按「放大選區」後點選或拖曳方框微調。需要移動地圖時切換「平移地圖」。',
    map: {
      image: '/mars-viking.jpg', imageAlt: '火星等距矩形全球影像', kmPerDegree: 59.271, maxZoom: 8, focusZoom: 8,
      quickLabel: 'MARS / QUICK LOCATOR', fullLabel: 'FULL MARS / 2D LOCATOR',
      quickTitle: '全火星選點，再放大微調', fullTitle: '在全火星地圖上精準定位',
      pickHint: '點選全火星任意位置，可連續重選；按「放大選區」再微調', refineHint: '點選或拖曳方框微調；按「重選全火星區域」可選遠方',
      zoomOut: '縮小火星地圖', zoomIn: '放大火星地圖', modes: '火星地圖操作模式', scales: '火星方形窗格邊長',
      selectLabel: '火星地圖：點擊或拖曳任意位置選取方形窗格', panLabel: '火星地圖：拖曳平移，點擊選取',
    },
  },
}

function PlanetMap({ body = 'moon', selected, onPick, sizeKm, onSize, compact = false, expanded = false }) {
  const planet = SELECT_BODIES[body].map
  const [draft, setDraft] = useState(null)
  const [hover, setHover] = useState(null)
  const [mapMode, setMapMode] = useState('select')
  const [zoom, setZoom] = useState(1)
  const [center, setCenter] = useState({ x: 0.5, y: 0.5 })
  const [detailUrl, setDetailUrl] = useState(null)
  const dragging = useRef(null)
  const localPick = useRef(false)
  const centerAt = (next, level) => ({
    x: clamp(next.x, 0.5 / level, 1 - 0.5 / level),
    y: clamp(next.y, 0.5 / level, 1 - 0.5 / level),
  })
  const worldPoint = (lat, lon) => ({ x: (lon + 180) / 360, y: (90 - lat) / 180 })
  const screenPosition = point => ({
    left: `${(0.5 + (point.x - center.x) * zoom) * 100}%`,
    top: `${(0.5 + (point.y - center.y) * zoom) * 100}%`,
  })
  const locatorUrl = body === 'moon' && zoom >= 16 ? `/api/moon-locator?x=${center.x.toFixed(5)}&y=${center.y.toFixed(5)}&zoom=${zoom}` : null
  useEffect(() => {
    if (!locatorUrl) { setDetailUrl(null); return }
    const timer = window.setTimeout(() => setDetailUrl(locatorUrl), 180)
    return () => window.clearTimeout(timer)
  }, [locatorUrl])
  useEffect(() => {
    if (localPick.current) { localPick.current = false; return }
    if (zoom > 1 && !dragging.current) setCenter(centerAt(worldPoint(selected.lat, selected.lon), zoom))
  }, [selected.lat, selected.lon])
  const fromPointer = e => {
    const box = e.currentTarget.getBoundingClientRect()
    return {
      lat: clamp(90 - (center.y + ((e.clientY - box.top) / box.height - 0.5) / zoom) * 180, -89.5, 89.5),
      lon: clamp((center.x + ((e.clientX - box.left) / box.width - 0.5) / zoom) * 360 - 180, -180, 180),
    }
  }
  const shown = draft || selected
  const point = worldPoint(shown.lat, shown.lon)
  const hoverPoint = hover && worldPoint(hover.lat, hover.lon)
  const footprintWidthAt = lat => sizeKm / (Math.max(0.15, Math.cos(lat * Math.PI / 180)) * planet.kmPerDegree) / 360 * zoom * 100
  const footprintHeight = sizeKm / planet.kmPerDegree / 180 * zoom * 100
  const changeZoom = (next, anchor = null) => {
    const level = clamp(next, 1, planet.maxZoom)
    if (anchor) {
      const box = anchor.currentTarget.getBoundingClientRect()
      const fx = (anchor.clientX - box.left) / box.width - 0.5
      const fy = (anchor.clientY - box.top) / box.height - 0.5
      setCenter(centerAt({ x: center.x + fx / zoom - fx / level, y: center.y + fy / zoom - fy / level }, level))
    } else setCenter(centerAt(worldPoint(shown.lat, shown.lon), level))
    setZoom(level)
  }
  const pointerDown = e => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const onLocator = Boolean(e.target.closest('.moon-map-locator, .moon-map-footprint'))
    // The primary gesture places the requested window. Panning is explicit so
    // dragging across terrain never silently leaves the selection unchanged.
    const gestureMode = onLocator ? 'move-selection' : mapMode === 'select' || zoom === 1 ? 'select' : 'pan'
    const startPoint = fromPointer(e)
    dragging.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY, center,
      mode: gestureMode, moved: false, onLocator,
      offsetLat: onLocator ? selected.lat - startPoint.lat : 0,
      offsetLon: onLocator ? selected.lon - startPoint.lon : 0,
    }
    if (onLocator) setDraft(selected)
    else if (gestureMode === 'select') setDraft(startPoint)
  }
  const draggedPoint = (e, gesture) => {
    const point = fromPointer(e)
    return {
      lat: clamp(point.lat + gesture.offsetLat, -89.5, 89.5),
      lon: clamp(point.lon + gesture.offsetLon, -180, 180),
    }
  }
  const pointerMove = e => {
    const gesture = dragging.current
    if (!gesture || gesture.id !== e.pointerId) { setHover(fromPointer(e)); return }
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y
    if (Math.hypot(dx, dy) > 5) gesture.moved = true
    if (!gesture.moved) return
    if (gesture.mode === 'move-selection' || gesture.mode === 'select') setDraft(draggedPoint(e, gesture))
    else if (zoom > 1) {
      const box = e.currentTarget.getBoundingClientRect()
      setCenter(centerAt({ x: gesture.center.x - dx / box.width / zoom, y: gesture.center.y - dy / box.height / zoom }, zoom))
    }
  }
  const pointerUp = e => {
    const gesture = dragging.current
    if (!gesture || gesture.id !== e.pointerId) return
    dragging.current = null
    setHover(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (gesture.mode === 'move-selection' || gesture.mode === 'select' || !gesture.moved) {
      // A tap on the existing marker means "select here". Preserve the
      // marker offset only for an actual drag of the current footprint.
      const next = gesture.moved ? draggedPoint(e, gesture) : fromPointer(e)
      setDraft(null)
      // Keep the global map visible after a pick so another distant region
      // can be selected immediately. Precision zoom is an explicit action.
      if (Number(next.lat.toFixed(5)) === selected.lat && Number(next.lon.toFixed(5)) === selected.lon) return
      localPick.current = true
      onPick(next.lat, next.lon)
    }
  }
  const keyDown = e => {
    const delta = e.shiftKey ? 1 : 0.1
    const offsets = { ArrowUp: [delta, 0], ArrowDown: [-delta, 0], ArrowRight: [0, delta], ArrowLeft: [0, -delta] }
    const offset = offsets[e.key]
    if (offset) {
      e.preventDefault()
      onPick(clamp(selected.lat + offset[0], -89.5, 89.5), clamp(selected.lon + offset[1], -180, 180))
    } else if (e.key === '+' || e.key === '=') changeZoom(zoom * 2)
    else if (e.key === '-') changeZoom(zoom / 2)
  }
  const sectionId = expanded ? `${body}-expanded-map` : compact ? `${body}-focus-map` : `full-${body}-map`
  return (
    <div
      className={`moon-map-section ${compact ? 'moon-map-compact' : ''} ${expanded ? 'moon-map-expanded' : ''}`}
      id={sectionId}
    >
      <div className="moon-map-heading">
        <div>
          <span className="micro-label">{compact ? planet.quickLabel : planet.fullLabel}</span>
          <h3>{compact ? planet.quickTitle : planet.fullTitle}</h3>
        </div>
        <p>
          {mapMode === 'select'
            ? zoom === 1
              ? planet.pickHint
              : planet.refineHint
            : '拖曳地圖平移；點一下仍可選取位置'}
        </p>
      </div>
      <div className="moon-map-toolbar">
        <div className="moon-map-zoom">
          <button type="button" onClick={() => changeZoom(zoom / 2)} disabled={zoom === 1} aria-label={planet.zoomOut}>
            −
          </button>
          <span>{zoom}×</span>
          <button
            type="button"
            onClick={() => changeZoom(zoom * 2)}
            disabled={zoom >= planet.maxZoom}
            aria-label={planet.zoomIn}
          >
            +
          </button>
        </div>
        <div className="moon-map-tools" role="group" aria-label={planet.modes}>
          <button
            type="button"
            className={mapMode === 'select' ? 'active' : ''}
            aria-pressed={mapMode === 'select'}
            onClick={() => setMapMode('select')}
          >
            選取窗格
          </button>
          <button
            type="button"
            className={mapMode === 'pan' ? 'active' : ''}
            aria-pressed={mapMode === 'pan'}
            disabled={zoom === 1}
            title={zoom === 1 ? '放大後才能平移' : undefined}
            onClick={() => setMapMode('pan')}
          >
            平移地圖
          </button>
        </div>
        <div className="moon-map-scales" role="group" aria-label={planet.scales}>
          {[20, 40, 80].map(km => (
            <button
              type="button"
              key={km}
              className={sizeKm === km ? 'active' : ''}
              aria-pressed={sizeKm === km}
              onClick={() => onSize(km)}
            >
              {km} km
            </button>
          ))}
        </div>
        {zoom > 1 && (
          <button type="button" className="moon-map-center" onClick={() => changeZoom(1)}>
            {SELECT_BODIES[body].fullView}
          </button>
        )}
        <button type="button" className="moon-map-center" onClick={() => changeZoom(Math.max(zoom, planet.focusZoom))}>
          放大選區
        </button>
        {zoom > 1 && (
          <button
            type="button"
            className="moon-map-center"
            onClick={() => setCenter(centerAt(worldPoint(selected.lat, selected.lon), zoom))}
          >
            置中選區
          </button>
        )}
      </div>
      <div
        className={`moon-map ${mapMode === 'pan' && zoom > 1 ? 'is-panning' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={mapMode === 'select' ? planet.selectLabel : planet.panLabel}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          dragging.current = null
          setDraft(null)
        }}
        onPointerLeave={() => setHover(null)}
        onWheel={e => {
          e.preventDefault()
          changeZoom(zoom * (e.deltaY < 0 ? 2 : 0.5), e)
        }}
        onKeyDown={keyDown}
      >
        <img
          src={planet.image}
          alt={planet.imageAlt}
          draggable="false"
          style={{
            width: `${zoom * 100}%`,
            height: `${zoom * 100}%`,
            left: `${(0.5 - center.x * zoom) * 100}%`,
            top: `${(0.5 - center.y * zoom) * 100}%`,
          }}
        />
        {locatorUrl && detailUrl === locatorUrl && (
          <img className="moon-map-detail" src={detailUrl} alt="LOLA 高程局部陰影圖" draggable="false" />
        )}
        <span
          className="moon-map-footprint"
          style={{ ...screenPosition(point), width: `${footprintWidthAt(shown.lat)}%`, height: `${footprintHeight}%` }}
        />
        <span className={`moon-map-locator ${zoom >= 16 ? 'is-detail' : ''}`} style={screenPosition(point)} />
        {hover && !draft && (
          <span
            className="moon-map-hover-footprint"
            style={{
              ...screenPosition(hoverPoint),
              width: `${footprintWidthAt(hover.lat)}%`,
              height: `${footprintHeight}%`,
            }}
          />
        )}
        {hover && !draft && (
          <span className="moon-map-hover" style={screenPosition(hoverPoint)}>
            <span>{formatCoord(hover.lat, hover.lon)}</span>
          </span>
        )}
        {zoom === 1 && (
          <>
            <span className="moon-map-label west">180°W</span>
            <span className="moon-map-label east">180°E</span>
          </>
        )}
      </div>
      <div className="moon-map-readout">
        <span>{formatCoord(shown.lat, shown.lon)}</span>
        <span>
          {body === 'mars' ? (
            'Viking 定位影像（放大不增加影像細節） · '
          ) : (
            <>{zoom >= 16 ? 'LOLA 高程陰影' : 'LRO 全月影像'} · </>
          )}
          {sizeKm} × {sizeKm} km 方形窗格 · 拖曳細框微調
        </span>
      </div>
    </div>
  )
}

// Plan 12.3 scale gating. A scale is "limited" when the elevation source is coarser than the model grid at
// that scale (the model then interpolates). Derived from the API's window.sampling, not from site lists:
// current scale uses model_upsamples_source; other scales compare source spacing with width/(grid-1).
const SCALES_KM = [20, 40, 80]
function limitedScales(sampling, currentKm) {
  const spacing = sampling?.source_grid_north_south_spacing_m, cells = sampling?.model_grid_shape?.[0]
  if (!Number.isFinite(spacing) || !Number.isFinite(cells) || cells < 2) return new Set()
  return new Set(SCALES_KM.filter(km => km === currentKm ? sampling.model_upsamples_source === true : spacing > km * 1000 / (cells - 1)))
}
function ScalePicker({ sizeKm, onSize, selected, windowData }) {
  const [known, setKnown] = useState(null)
  const here = row => row && Math.abs(row.lat - selected.lat) < 0.001 && Math.abs(row.lon - selected.lon) < 0.001
  useEffect(() => { if (here(windowData) && windowData.sampling) setKnown({ lat: selected.lat, lon: selected.lon, km: windowData.patch_km, sampling: windowData.sampling }) }, [windowData, selected.lat, selected.lon])
  const sampling = here(known) ? known.sampling : null
  const limited = limitedScales(sampling, known?.km)
  const spacing = sampling ? Math.round(sampling.source_grid_north_south_spacing_m).toLocaleString('en-US') : ''
  const fallback = SCALES_KM.find(km => !limited.has(km))
  return (
    <>
      <div className="scale-picker">
        <span>方形窗格邊長</span>
        <div>
          {SCALES_KM.map(km => (
            <button
              key={km}
              className={(sizeKm === km ? 'active' : '') + (limited.has(km) ? ' scale-limited' : '')}
              aria-pressed={sizeKm === km}
              aria-describedby={limited.has(km) ? 'scale-limit-note' : undefined}
              onClick={() => onSize(km)}
            >
              {km} km{limited.has(km) && <small className="scale-limit-tag">插值</small>}
            </button>
          ))}
        </div>
      </div>
      {limited.size > 0 && (
        <p className="scale-limit-note" id="scale-limit-note">
          {message`此處高程來源格距約 ${spacing} m，比 ${[...limited].map(km => km + ' km').join(getLanguage() === 'en' ? '/' : '／')} 窗格的模型格點粗；這些尺度是插值結果，細部不是實測。`}
          {limited.has(sizeKm) && fallback && (
            <>
              {' '}
              <button
                type="button"
                className="text-button"
                onClick={() => onSize(fallback)}
              >{message`改用 ${fallback} km`}</button>
            </>
          )}
        </p>
      )}
    </>
  )
}
// Plan 12.3 no-coverage actions: shown with the server's own message when the window request returns 4xx.
function CoverageActions({ sizeKm, onSize, onChooseArea }) {
  const larger = SCALES_KM.find(km => km > sizeKm)
  return <div className="coverage-actions" role="group" aria-label="資料不足時的替代做法">
    {larger && <button type="button" className="outline-button" onClick={() => onSize(larger)}>{message`改用較大尺度（${larger} km）`}</button>}
    <button type="button" className="outline-button" onClick={onChooseArea}>選擇有資料的區域</button>
  </div>
}

// Keyed by body: switching between the Moon and Mars remounts the page, so globe, map dialog and form state start fresh.
function SelectStage(props) {
  return <BodySelectStage key={props.body} {...props} />
}

function BodySelectStage({ body, selected, onPick, sizeKm, onSize, windowData, localDtm, busy, onSearch, onRetry, error, coverageError, surface, onSurface, rock, onRock, purpose, onPurpose, physUse, onPhysUse, facetUse, onFacetUse }) {
  const ui = SELECT_BODIES[body]
  const isMars = body === 'mars'
  const pageHeading = usePageHeading()
  const [mapOpen, setMapOpen] = useState(false)
  const [focusTarget, setFocusTarget] = useState(null)
  const [globeHover, setGlobeHover] = useState(null)
  const [globeDraft, setGlobeDraft] = useState(null)
  // Selection is the primary task on this screen. Rotation remains an
  // explicit mode so a drag cannot silently move the globe instead of the box.
  const [globeMode, setGlobeMode] = useState('select')
  const [latitude, setLatitude] = useState(String(selected.lat))
  const [longitude, setLongitude] = useState(String(selected.lon))
  const [coordinateError, setCoordinateError] = useState('')
  const previewReady = windowData && Math.abs(windowData.lat - selected.lat) < 0.001 && Math.abs(windowData.lon - selected.lon) < 0.001 && windowData.patch_km === sizeKm
  const localReady = localDtm?.available && Math.abs(localDtm.center.lat - selected.lat) < 0.000001 && Math.abs(localDtm.center.lon - selected.lon) < 0.000001
  const lroc = windowData?.lroc_dtm_coverage
  const crater = windowData?.moon_crater_center
  useEffect(() => { setLatitude(String(selected.lat)); setLongitude(String(selected.lon)); setCoordinateError('') }, [selected.lat, selected.lon])
  const mapDialog = useRef(null)
  useModalFocus(mapOpen, mapDialog, () => setMapOpen(false))
  // Globe picks keep the current view. The explicit focus control handles
  // precision zoom without hiding the rest of the globe after a coarse pick.
  const selectOnGlobe = (lat, lon) => { onPick(lat, lon); setGlobeDraft(null) }
  const selectAndFocus = (lat, lon) => { onPick(lat, lon); setFocusTarget({ lat, lon, distance: 'full' }) }
  const applyCoordinates = e => {
    e.preventDefault()
    const lat = Number(latitude), lon = Number(longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || latitude.trim() === '' || longitude.trim() === '' || Math.abs(lat) > 89.5 || Math.abs(lon) > 180) {
      setCoordinateError('請輸入緯度 -89.5～89.5、經度 -180～180。')
      return
    }
    setCoordinateError('')
    selectAndFocus(lat, lon)
  }
  return (
    <motion.main
      initial={{ opacity: 0, y: 28 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="workspace selection-workspace"
    >
      <div className="page-heading">
        <div>
          <div className="eyebrow">01 / 選擇地區</div>
          <h1 ref={pageHeading} tabIndex={-1}>
            {ui.title}
          </h1>
          <p>{getLanguage() === 'en' ? 'Pick a spot on the globe, set the window size, then find similar terrain on Earth.' : '在球面上點選位置，確認範圍後搜尋地球相似地形。'}</p>
        </div>
        <button className="outline-button" onClick={() => setMapOpen(true)}>
          用地圖選區 <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="select-layout">
        <div className="globe-panel">
          <MoonGlobe
            body={body}
            selected={globeDraft || selected}
            onPick={selectOnGlobe}
            onHover={setGlobeHover}
            onDraft={setGlobeDraft}
            mode={globeMode}
            sizeKm={sizeKm}
            focusTarget={focusTarget}
          />
          <div className="globe-panel-top">
            <span className="live-pill">
              <span /> {ui.liveModel}
            </span>
            <span className="micro-label">{ui.projection}</span>
          </div>
          <div className="globe-hover-readout" aria-live="polite">
            {globeDraft
              ? message`選區 ${formatCoord(globeDraft.lat, globeDraft.lon)}`
              : globeHover
                ? message`點此選取 ${formatCoord(globeHover.lat, globeHover.lon)}`
                : globeMode === 'select'
                  ? ui.globeSelectHint
                  : ui.globeRotateHint}
          </div>
          <div className="globe-mode-picker" role="group" aria-label={ui.globeModes}>
            <button
              type="button"
              className={globeMode === 'select' ? 'active' : ''}
              aria-pressed={globeMode === 'select'}
              onClick={() => {
                setGlobeDraft(null)
                setGlobeMode('select')
              }}
            >
              選取區域
            </button>
            <button
              type="button"
              className={globeMode === 'rotate' ? 'active' : ''}
              aria-pressed={globeMode === 'rotate'}
              onClick={() => {
                setGlobeDraft(null)
                setGlobeMode('rotate')
              }}
            >
              {ui.rotate}
            </button>
          </div>
          <div className="globe-panel-bottom">
            <span>
              <Rotate3D size={15} />{' '}
              {globeMode === 'select' ? '點一下選取 · 拖曳移動窗格' : '拖曳旋轉 · 點一下放置窗格'}
            </span>
            <span>
              <Crosshair size={15} /> 滾輪／雙指縮放
            </span>
          </div>
          <div className="globe-coordinate" aria-live="polite">{formatCoord(selected.lat, selected.lon)}<span>{sizeKm} × {sizeKm} km</span></div>
          <div className="globe-view-actions">
            <button
              className="globe-reset"
              type="button"
              onClick={() => setFocusTarget({ lat: selected.lat, lon: selected.lon })}
            >
              放大目前選區
            </button>
            <button
              className="globe-reset"
              type="button"
              onClick={() => setFocusTarget({ lat: selected.lat, lon: selected.lon, distance: 'full' })}
            >
              {ui.fullView}
            </button>
          </div>
        </div>
        <div className="selection-side">
          <PurposeTiles purpose={purpose} onPurpose={onPurpose} />
          <ScalePicker sizeKm={sizeKm} onSize={onSize} selected={selected} windowData={windowData} />
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {error &&
            !previewReady &&
            (coverageError ? (
              <CoverageActions sizeKm={sizeKm} onSize={onSize} onChooseArea={() => setMapOpen(true)} />
            ) : (
              <button type="button" className="outline-button" onClick={onRetry}>
                {getLanguage() === 'en' ? 'Retry elevation' : '重新載入高程'}
              </button>
            ))}
          <button className="primary-button search-button" onClick={onSearch} disabled={busy || !previewReady}>
            {busy ? (
              '搜尋中…'
            ) : !previewReady && !error ? (
              getLanguage() === 'en' ? 'Loading terrain…' : '正在讀取地形…'
            ) : (
              <>
                搜尋地球相似地形 <ArrowRight size={18} />
              </>
            )}
          </button>
          {purpose === 'physical' && <UseChips use={physUse} onUse={onPhysUse} />}
          {purpose === 'facets' && <FacetUseChips use={facetUse} onUse={onFacetUse} />}
          <PurposeNote purpose={purpose} />
          <p className="side-footnote">由伺服器執行地形模型與環境、岩性聯合排序；不推斷環境適居性。</p>
          {purpose === 'lavatube' && <SkylightPresets body={body} onPick={onPick} />}
          {purpose !== 'physical' && <ConditionTiles surface={surface} onSurface={onSurface} rock={rock} onRock={onRock} />}
          <div className="mini-preview">
            <div className="mini-preview-top">
              <span>
                <Layers3 size={16} /> 所選地區地形
              </span>
            </div>
            {previewReady ? (
              <TerrainView terrain={windowData.terrain} tone={body} label={ui.terrainLabel} wireframe />
            ) : (
              <div className="terrain-loading" role="status">
                {error ? '地形暫時無法載入' : '正在讀取所選地區高程…'}
              </div>
            )}
          </div>
          {previewReady && <TerrainSampling sampling={windowData.sampling} />}
          {previewReady && <TerrainReadCard read={windowData.terrain_read} body={body} />}
          <details className="selection-details">
            <summary>精確座標</summary>
            <form className="coordinate-form" onSubmit={applyCoordinates}>
              <span>指定精確座標</span>
              <div className="coordinate-fields">
                <label>
                  緯度 °
                  <input
                    type="number"
                    min="-89.5"
                    max="89.5"
                    step="0.00001"
                    inputMode="decimal"
                    value={latitude}
                    onChange={e => setLatitude(e.target.value)}
                    aria-label={ui.latitudeLabel}
                  />
                </label>
                <label>
                  經度 °
                  <input
                    type="number"
                    min="-180"
                    max="180"
                    step="0.00001"
                    inputMode="decimal"
                    value={longitude}
                    onChange={e => setLongitude(e.target.value)}
                    aria-label={ui.longitudeLabel}
                  />
                </label>
                <button type="submit">定位</button>
              </div>
              <small>北／東為正，南／西為負；可輸入至小數點後五位</small>
              {coordinateError && <em role="alert">{coordinateError}</em>}
            </form>
          </details>
          <details className="selection-details">
            <summary>地形資訊</summary>
            {isMars && (
              <p className="mars-source-note">
                全球高程原始格距約 1.85 km；放大預覽不增加實測細節。已備妥的局部資料會顯示實際來源格距：
                {windowData?.mars_reference?.source_resolution_m || 1853} m。
              </p>
            )}
            <div className="selection-facts">
              <div>
                <span>窗格面積</span>
                <strong>
                  {(sizeKm * sizeKm).toLocaleString()} <small>km²</small>
                </strong>
              </div>
              <div>
                <span>窗格寬度</span>
                <strong>
                  {sizeKm} <small>km</small>
                </strong>
              </div>
              <div>
                <span>高程起伏</span>
                <strong>
                  {windowData ? windowData.terrain.relief_m.toLocaleString() : '—'} <small>m</small>
                </strong>
              </div>
            </div>
            {/* LROC NAC coverage, the local NAC reconstruction and the crater model exist only for the Moon. */}
            {!isMars && previewReady && lroc && (
              <div className="dtm-coverage-card">
                <div className="dtm-coverage-title">
                  <span>LROC NAC / HIGH-RES TERRAIN</span>
                </div>
                <strong>
                  {lroc.available
                    ? lroc.center_covered_by_dtm_footprint
                      ? '選區中心有 NAC 立體高程覆蓋'
                      : '選區中心沒有 NAC 立體高程覆蓋'
                    : lroc.reason}
                </strong>
                {lroc.available && (
                  <>
                    <p>
                      目前 {sizeKm} km 方框約 {Math.round(lroc.selected_window_sampled_fraction * 100)}% 落在已發布的 NAC DTM 範圍；中心 3 km 約 {Math.round(lroc.center_3km_sampled_fraction * 100)}%。以 21×21 格點估算，並非下載後的有效高程比例。
                    </p>
                    {lroc.products[0] && (
                      <a className="dtm-coverage-product" href={lroc.products[0].url} target="_blank" rel="noreferrer">
                        {lroc.products[0].name} · {lroc.products[0].resolution_m} m/px <ArrowUpRight size={12} />
                      </a>
                    )}
                  </>
                )}
                <small>主選框 3D 預覽使用 LOLA；已下載且完整覆蓋中心 3 km 的 NAC 立體高程會在下方另行重建。</small>
              </div>
            )}
            {!isMars && localReady && (
              <div className="local-dtm-card">
                <div className="local-dtm-header">
                  <span>NAC STEREO / 3 KM LOCAL RECONSTRUCTION</span>
                  <a href={localDtm.product_page} target="_blank" rel="noreferrer">
                    {localDtm.product_id} <ArrowUpRight size={12} />
                  </a>
                </div>
                <div className="local-dtm-view">
                  <TerrainView
                    terrain={localDtm.terrain}
                    tone="moon"
                    label="NAC 立體高程的 3 公里局部三維重建"
                    wireframe
                  />
                </div>
                <p>
                  原始 {localDtm.native_spacing_m} m/px 立體高程，31.25 m 格距顯示 · 完整有效像元 · P90–P10 起伏{' '}
                  {localDtm.terrain.relief_m.toLocaleString()} m。此圖只涵蓋中心 3 km，不代表整個 {sizeKm} km 搜尋方框。
                </p>
              </div>
            )}
            {!isMars && previewReady && (
              <div className="crater-preview">
                <span>{crater?.model_parameters || '—'} PARAMETER / LOCAL LANDFORM MODEL</span>
                <strong>{crater?.available ? crater.label : crater?.reason || '地貌模型載入中'}</strong>
                <small>
                  {crater?.available
                    ? message`中心 ${crater.target_diameter_km} km 坑形態指數 ${(crater.score * 100).toFixed(0)} / 100 · 非有坑機率`
                    : '20／40 km 窗格提供對應尺度坑形線索'}
                </small>
              </div>
            )}
          </details>
        </div>
      </div>
      {!isMars && (
        <details className="region-suggestions">
          <summary>瀏覽月球推薦地區</summary>
          <TileRail selected={selected} onPick={selectAndFocus} />
        </details>
      )}
      {mapOpen &&
        createPortal(
          <div
            className="moon-map-dialog-backdrop"
            onPointerDown={e => {
              if (e.target === e.currentTarget) setMapOpen(false)
            }}
          >
            <section
              ref={mapDialog}
              tabIndex={-1}
              className="moon-map-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="moon-map-dialog-title"
            >
              <div className="moon-map-dialog-header">
                <div>
                  <span className="micro-label">{ui.dialogLabel}</span>
                  <h2 id="moon-map-dialog-title">{ui.dialogTitle}</h2>
                  <p>{ui.dialogHint}</p>
                </div>
                <button
                  className="moon-map-dialog-close"
                  type="button"
                  aria-label="關閉選區地圖"
                  onClick={() => setMapOpen(false)}
                >
                  ×
                </button>
              </div>
              <PlanetMap
                body={body}
                selected={selected}
                onPick={selectAndFocus}
                sizeKm={sizeKm}
                onSize={onSize}
                expanded
              />
              <div className="moon-map-dialog-footer">
                <span>
                  目前選區：<strong>{formatCoord(selected.lat, selected.lon)}</strong> · {sizeKm} × {sizeKm} km
                </span>
                <button className="primary-button" type="button" onClick={() => setMapOpen(false)}>
                  完成選區 <ArrowRight size={18} />
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </motion.main>
  )
}

const savedMoonWindow = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem('selene:moon-window:v1'))
    if (Number.isFinite(value?.lat) && Number.isFinite(value?.lon) && Math.abs(value.lat) <= 89.5 && Math.abs(value.lon) <= 180 && [20, 40, 80].includes(value.sizeKm)) return value
  } catch { /* Browser storage may be disabled. */ }
  return { lat: 8.7, lon: 27.4, sizeKm: 40 }
}

function App() {
  useLanguage()
  const searchAbort = useRef(null)
  const [savedWindow] = useState(savedMoonWindow)
  const [stage, setStage] = useState(0)
  const [body, setBody] = useState('moon')
  const [marsSelected, setMarsSelected] = useState({ lat: 18.4, lon: 77.7 })
  const [selected, setSelected] = useState({ lat: savedWindow.lat, lon: savedWindow.lon })
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [sizeKm, setSizeKm] = useState(savedWindow.sizeKm)
  const [purpose, setPurpose] = useState('facets')
  const [physUse, setPhysUse] = useState('isru')
  const [facetUse, setFacetUse] = useState('overall')
  const [surface, setSurface] = useState('any')
  const [rock, setRock] = useState('any')
  const [windowData, setWindowData] = useState(null)
  const [localDtm, setLocalDtm] = useState(null)
  const [searchData, setSearchData] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [coverageError, setCoverageError] = useState(false)
  useEffect(() => {
    try { window.localStorage.setItem('selene:moon-window:v1', JSON.stringify({ lat: selected.lat, lon: selected.lon, sizeKm })) } catch { /* Keep the live selection when storage is unavailable. */ }
  }, [selected.lat, selected.lon, sizeKm])
  useEffect(() => {
    const abort = new AbortController()
    requestJson('/api/status',{signal:abort.signal,timeoutMs:15000}).then(setStatus).catch(()=>{})
    return ()=>abort.abort()
  }, [])
  useEffect(() => {
    searchAbort.current?.abort()
    setBusy(false)
  }, [body, marsSelected.lat, marsSelected.lon, selected.lat, selected.lon, sizeKm, purpose, surface, rock, physUse, facetUse])
  useEffect(() => {
    if (stage !== 1) return
    const abort = new AbortController()
    setWindowData(null)
    setError('')
    setCoverageError(false)
    const endpoint = body === 'mars'
      ? `/api/mars-window?lat=${marsSelected.lat}&lon=${marsSelected.lon}&size_km=${sizeKm}`
      : `/api/window?lat=${selected.lat}&lon=${selected.lon}&size_km=${sizeKm}`
    requestJson(endpoint, { signal: abort.signal, timeoutMs:30000 })
      .then(data => setWindowData({ ...data.window, moon_crater_center: data.moon_crater_center, lroc_dtm_coverage: data.lroc_dtm_coverage, mars_reference: data.mars_reference, terrain_read: data.terrain_read }))
      .catch(err => { if (abort.signal.aborted) return
        // 4xx with a server message = documented data unavailability (e.g. missing elevation): show it with actions.
        if (err.status >= 400 && err.status < 500 && err.serverMessage) { setCoverageError(true); setError(err.message); return }
        setError(err.name==='TimeoutError'
        ? (getLanguage()==='en'?'Elevation request timed out. Retry with the same selection.':'高程請求逾時，可保留目前選區重試。')
        : (getLanguage()==='en'?'Unable to load elevation. Retry with the same selection.':'高程資料暫時無法讀取，可保留目前選區重試。')) })
    return () => abort.abort()
  }, [stage, body, marsSelected.lat, marsSelected.lon, selected.lat, selected.lon, sizeKm, selectionRevision])
  useEffect(() => {
    if (stage !== 1 || body !== 'moon') { setLocalDtm(null); return }
    const abort = new AbortController()
    setLocalDtm(null)
    const timer = window.setTimeout(() => {
      requestJson(`/api/moon-local-dtm?lat=${selected.lat}&lon=${selected.lon}`, { signal: abort.signal, timeoutMs:30000 })
        .then(setLocalDtm)
        .catch(err => { if (err.name !== 'AbortError') setLocalDtm(null) })
    }, 180)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [stage, body, selected.lat, selected.lon])
  const onPick = (lat, lon) => {
    const wrappedLon = ((lon + 180) % 360 + 360) % 360 - 180
    setSelected({ lat: Number(lat.toFixed(5)), lon: Number(wrappedLon.toFixed(5)) })
    setSelectionRevision(value => value + 1)
  }
  const pickMars = (lat, lon) => { setMarsSelected({ lat: Number(clamp(lat, -89.5, 89.5).toFixed(5)), lon: Number((((lon + 180) % 360 + 360) % 360 - 180).toFixed(5)) }); setSelectionRevision(value => value + 1) }
  useEffect(()=>{if(stage===1){const image=new Image();image.src='/earth-color.jpg'}},[stage])
  useEffect(() => { if (stage === 1) loadResults().catch(() => {}) }, [stage])
  const search = async (requestedLimit = 5, requestedOffset = 0, requestedVisual = null) => {
    const offset = Number.isInteger(requestedOffset) ? requestedOffset : 0
    // two-stage modes show more candidates on the first page so the re-ranked list has room
    const limit = (purpose === 'material' || purpose === 'lavatube') && offset === 0 ? Math.max(12, Number.isInteger(requestedLimit) ? requestedLimit : 5) : (Number.isInteger(requestedLimit) ? requestedLimit : 5)
    const visual = requestedVisual || (offset > 0 ? searchData?.global_visual?.mode : null) || "complete"
    searchAbort.current?.abort()
    const abort = new AbortController(); searchAbort.current = abort
    setBusy(true); setError('')
    try {
      const endpoint = body === 'mars'
        ? `/api/mars-search?lat=${marsSelected.lat}&lon=${marsSelected.lon}&size_km=${sizeKm}`
        : `/api/search?lat=${selected.lat}&lon=${selected.lon}&size_km=${sizeKm}`
      const [result] = await Promise.all([
        requestJson(`${endpoint}&surface=${surface}&rock=${rock}&purpose=${purpose}${purpose === 'physical' ? `&use=${physUse}` : ''}${purpose === 'facets' ? `&facet_use=${facetUse}` : ''}&limit=${limit}&offset=${offset}&visual=${visual}`,{signal:abort.signal,timeoutMs:60000}),
        loadResults(),
      ])
      if (!result.matches?.length) throw Error(offset ? '候選清單已改變，請重新搜尋。' : '沒有符合條件的候選，請放寬類比目標。')
      if (abort.signal.aborted) return
      const merged = mergeCandidatePage(searchData,result)
      setSearchData(merged); setActiveId(current => offset > 0 && merged.matches.some(m => m.id === current) ? current : result.matches[0]?.id); setStage(2)
      if (offset === 0) window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) { if(!abort.signal.aborted&&searchAbort.current===abort)setError(err.name==='TimeoutError'
      ? (getLanguage()==='en'?'Search timed out. Your selection is unchanged; retry the search.':'搜尋逾時，已保留選區，可重新搜尋。')
      : err instanceof TypeError ? (getLanguage()==='en'?'Connection failed. Your selection is unchanged; retry the search.':'連線失敗，已保留選區，可重新搜尋。')
      : err.message || '搜尋未完成，請重試。') }
    finally { if(searchAbort.current===abort)setBusy(false) }
  }
  const navigate = next => { searchAbort.current?.abort();setBusy(false);setStage(next); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const startBody = nextBody => { setBody(nextBody); setSearchData(null); setActiveId(null); setWindowData(null); navigate(1) }
  const pickFromHero = (lat, lon) => { onPick(lat, lon); startBody('moon') }
  return (
    <div className={`app-shell ${stage === 0 ? 'is-landing' : ''}`}>
      <div className="ambient-glow" />
      {stage !== 0 && (
        <Header
          stage={stage}
          body={body}
          onHome={() => navigate(0)}
          onBody={next => (next === body ? navigate(1) : startBody(next))}
          onResults={searchData ? () => navigate(2) : null}
          onChat={() => navigate(3)}
        />
      )}
      <AnimatePresence mode="wait">
        {stage === 0 ? (
          <Landing
            Globe={MoonGlobe}
            onStart={() => startBody('moon')}
            onStartMars={() => startBody('mars')}
            onChat={() => navigate(3)}
            onPickMoon={pickFromHero}
            selected={selected}
            selectedMars={marsSelected}
            onPickMars={(lat, lon) => {
              pickMars(lat, lon)
              startBody('mars')
            }}
            status={status}
          />
        ) : stage === 3 ? (
          <Suspense fallback={null}><ChatSearch /></Suspense>
        ) : stage === 1 ? (
          <SelectStage
            body={body}
            selected={body === 'mars' ? marsSelected : selected}
            onPick={body === 'mars' ? pickMars : onPick}
            sizeKm={sizeKm}
            onSize={setSizeKm}
            windowData={windowData}
            localDtm={localDtm}
            busy={busy}
            onSearch={search}
            onRetry={() => setSelectionRevision(value => value + 1)}
            purpose={purpose}
            onPurpose={setPurpose}
            physUse={physUse}
            onPhysUse={setPhysUse}
            facetUse={facetUse}
            onFacetUse={setFacetUse}
            surface={surface}
            onSurface={setSurface}
            rock={rock}
            onRock={setRock}
            error={error}
            coverageError={coverageError}
          />
        ) : (
          <Suspense fallback={null}>
            <ResultsStage
              onVisual={() => search(30, 0, 'available')}
              onTerrain={() => search(5, 0, 'complete')}
              onMore={() => search(15, nextCandidateOffset(searchData))}
              loadingMore={busy}
              searchError={error}
              data={searchData}
              activeId={activeId}
              onActive={setActiveId}
              onBack={() => navigate(1)}
              status={status}
            />
          </Suspense>
        )}
      </AnimatePresence>
      <Suspense fallback={null}>
        <AssistantWidget searchData={searchData} activeId={activeId} onResults={stage === 2} />
      </Suspense>
      {stage !== 0 && (
        <footer className="site-footer">
          <div>
            <b>TwinGround</b>
            <p className="brand-tagline">{getLanguage() === 'en' ? 'Finding Earth’s twins of the Moon and Mars' : '在地球上找出月球與火星的雙胞胎'}</p>
            <p>{getLanguage() === 'en' ? 'Candidates are proposals of the same kind of setting; measured properties such as chemistry may not match, and they are not validated analog sites. This site is not endorsed by NASA.' : '候選地點是同類場域的提案，實測物理性質（例如化學成分）不一定相符，也不代表已驗證的類比場址。本網站未經 NASA 背書。'}</p>
          </div>
          <nav aria-label="NASA">
            <span>NASA</span>
            <a href="https://science.nasa.gov/solar-system/analog-explorer/" target="_blank" rel="noreferrer">
              Planetary Analog Explorer <ArrowUpRight size={13} />
            </a>
            <a href="https://www.nasa.gov/analog-missions/" target="_blank" rel="noreferrer">
              Analog Missions <ArrowUpRight size={13} />
            </a>
          </nav>
        </footer>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
