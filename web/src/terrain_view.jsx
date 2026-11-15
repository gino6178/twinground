import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useFlatView, ViewToggle, FlatTerrain } from './flat_view.jsx'
import { renderGate } from './render_gate.js'

// Phones (touch, small shared GPU memory): lighter comparison views. Framebuffers at <= 1.5x instead of the DPR 3
// screen, meshes <= 256 x 256, textures <= 1024 px. Desktop keeps <= 2x, 512 and 2048.
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches
const LIMIT = coarse ? { ratio: 1.5, mesh: 256, texture: 1024 } : { ratio: 2, mesh: 512, texture: 2048 }
// The DEM grid at no more than LIMIT.mesh points a side (nearest sample; the comparison views are small).
function meshGrid(terrain) {
  const n = terrain.size
  if (n <= LIMIT.mesh) return { count: n, heights: terrain.heights_m }
  const m = LIMIT.mesh, heights = new Array(m * m)
  for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
    heights[r * m + c] = terrain.heights_m[Math.round(r * (n - 1) / (m - 1)) * n + Math.round(c * (n - 1) / (m - 1))]
  }
  return { count: m, heights }
}
// Panels build one at a time (each on its own frame), so two views never allocate their GPU resources at once.
let buildQueue = Promise.resolve()

export function TerrainView({ terrain, tone = 'moon', label, wireframe = false, textureUrl = null, textureCredit = '', heightScaleM = null, cameraSync = null, onExplore = null }) {
  const host = useRef(null)
  const exploreRef = useRef(onExplore)
  exploreRef.current = onExplore
  const [flat,setFlat]=useFlatView()
  const [textureState, setTextureState] = useState(textureUrl ? 'loading' : 'none')
  const [lostNote, setLostNote] = useState(false)
  useEffect(() => {
    if (!host.current || !terrain || flat) return
    let cleanup = null, cancelled = false
    buildQueue = buildQueue.then(() => new Promise(resolve => requestAnimationFrame(() => {
      try { if (!cancelled && host.current) cleanup = build() } finally { resolve() }
    })))
    return () => { cancelled = true; cleanup?.() }
  function build() {
    setTextureState(textureUrl ? 'loading' : 'none')
    const width = host.current.clientWidth
    const height = host.current.clientHeight
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100)
    camera.position.set(2.7, 2.6, 3.1)
    let renderer
    try {renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, alpha: true })} catch {setFlat(true);return null}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, LIMIT.ratio))
    renderer.setSize(width, height)
    // Static scene: render on demand (camera moves, texture arrives, resize), not every frame.
    let dirty = true, onScreen = true
    const visibility = new IntersectionObserver(entries => { onScreen = entries[0]?.isIntersecting ?? true; dirty = true }, { threshold: 0.01 })
    visibility.observe(host.current)
    // The browser took the context back (low graphics memory): fall back to the 2D view and say why.
    const onLost = event=>{event.preventDefault();setLostNote(true);setFlat(true)}
    renderer.domElement.addEventListener('webglcontextlost', onLost, {once:true})
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.current.appendChild(renderer.domElement)
    const { count, heights } = meshGrid(terrain)
    const geometry = new THREE.PlaneGeometry(3.2, 3.2, count - 1, count - 1)
    const pos = geometry.attributes.position
    const maxAbs = heightScaleM || Math.max(300, ...heights.map(Math.abs))
    const colors = []
    const low = new THREE.Color(tone === 'shape' ? '#344349' : tone === 'moon' ? '#263a46' : tone === 'mars' ? '#572d2b' : '#215256')
    const mid = new THREE.Color(tone === 'shape' ? '#9eaaa9' : tone === 'moon' ? '#708897' : tone === 'mars' ? '#b36e50' : '#75a59c')
    const high = new THREE.Color(tone === 'shape' ? '#e2e6df' : tone === 'moon' ? '#d0d8d4' : tone === 'mars' ? '#e9bb83' : '#edc98d')
    for (let i = 0; i < pos.count; i++) {
      const value = heights[i] / maxAbs
      pos.setZ(i, value * 0.78)
      const shade = value < 0 ? low.clone().lerp(mid, 1 + value) : mid.clone().lerp(high, value)
      colors.push(shade.r, shade.g, shade.b)
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geometry.rotateX(-Math.PI / 2)
    geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0, side: THREE.DoubleSide }))
    scene.add(mesh)
    let imageTexture = null
    let disposed = false
    if (textureUrl) {
      new THREE.TextureLoader().load(textureUrl, loaded => {
        if (disposed) { loaded.dispose(); return }
        imageTexture = loaded
        const img = loaded.image
        if (img && Math.max(img.width, img.height) > LIMIT.texture) {
          const k = LIMIT.texture / Math.max(img.width, img.height), cv = document.createElement('canvas')
          cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k)
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
          imageTexture.image = cv
        }
        imageTexture.colorSpace = THREE.SRGBColorSpace
        imageTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
        mesh.material.map = imageTexture
        mesh.material.vertexColors = false
        mesh.material.needsUpdate = true
        dirty = true
        setTextureState('ready')
      }, undefined, () => { if (!disposed) setTextureState('unavailable') })
    }
    let meshLines = null
    if (wireframe) {
      const vertices = []
      const addSegment = (a, b) => {
        vertices.push(pos.getX(a), pos.getY(a) + 0.012, pos.getZ(a), pos.getX(b), pos.getY(b) + 0.012, pos.getZ(b))
      }
      for (let row = 0; row < count; row += 4) {
        for (let col = 0; col < count - 1; col++) addSegment(row * count + col, row * count + col + 1)
      }
      for (let col = 0; col < count; col += 4) {
        for (let row = 0; row < count - 1; row++) addSegment(row * count + col, (row + 1) * count + col)
      }
      const lines = new THREE.BufferGeometry()
      lines.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
      meshLines = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0xfafafa, transparent: true, opacity: 0.55 }))
      scene.add(meshLines)
    }
    const grid = new THREE.GridHelper(3.6, 10, tone === 'moon' ? 0x6d979f : tone === 'mars' ? 0xc48a6b : 0xb7b7b7, 0x23414b)
    grid.position.y = -0.84
    grid.material.transparent = true
    grid.material.opacity = 0.34
    scene.add(grid)
    scene.add(new THREE.AmbientLight(0xe7e7e7, 1.5))
    const light = new THREE.DirectionalLight(0xffe8c5, 3)
    light.position.set(-2, 5, 3)
    scene.add(light)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = !cameraSync
    controls.enablePan = false
    controls.minDistance = 2.7
    controls.maxDistance = 8
    let applying = false
    const publishCamera = () => {
      // Without damping, OrbitControls updates the camera inside its pointer handlers, so the render loop's
      // controls.update() returns false; mark this view dirty or the dragged side never redraws.
      dirty = true
      host.current?.setAttribute('data-camera-position', camera.position.toArray().join(','))
      if (!cameraSync || applying) return
      cameraSync.last = { source: renderer.domElement, position: camera.position.toArray(), target: controls.target.toArray() }
      cameraSync.dispatchEvent(new CustomEvent('camera', { detail: cameraSync.last }))
    }
    const receiveCamera = event => {
      if (event.detail.source === renderer.domElement) return
      applying = true
      camera.position.fromArray(event.detail.position); controls.target.fromArray(event.detail.target)
      controls.update(); applying = false; dirty = true
      host.current?.setAttribute('data-camera-position', camera.position.toArray().join(','))
    }
    controls.addEventListener('change', publishCamera)
    cameraSync?.addEventListener('camera', receiveCamera)
    // A click without dragging opens the astronaut explorer; drags keep rotating the view.
    let press = null
    const pressStart = e => { press = { x: e.clientX, y: e.clientY, t: performance.now() } }
    const pressEnd = e => {
      if (press && exploreRef.current && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6 && performance.now() - press.t < 450) exploreRef.current()
      press = null
    }
    renderer.domElement.addEventListener('pointerdown', pressStart)
    renderer.domElement.addEventListener('pointerup', pressEnd)
    if (cameraSync?.last) receiveCamera({detail:cameraSync.last})
    publishCamera()
    let frame
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!onScreen || renderGate.paused || document.hidden) return
      if (controls.update() || dirty) { renderer.render(scene, camera); dirty = false }
    }
    render()
    const resize = new ResizeObserver(() => {
      if (!host.current) return
      const w = host.current.clientWidth, h = host.current.clientHeight
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); dirty = true
    })
    resize.observe(host.current)
    return () => {
      visibility.disconnect()
      controls.removeEventListener('change', publishCamera)
      cameraSync?.removeEventListener('camera', receiveCamera)
      renderer.domElement.removeEventListener('pointerdown', pressStart)
      renderer.domElement.removeEventListener('pointerup', pressEnd)
      disposed = true
      cancelAnimationFrame(frame); resize.disconnect(); controls.dispose()
      geometry.dispose(); mesh.material.dispose()
      if (imageTexture) imageTexture.dispose()
      if (meshLines) { meshLines.geometry.dispose(); meshLines.material.dispose() }
      // Release the GPU context now rather than at garbage collection: every view switch builds new ones, and on a
      // phone the stale contexts still hold graphics memory when the explorer opens. (Not a loss to fall back from.)
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
    }
  }
  }, [terrain, tone, wireframe, textureUrl, heightScaleM, cameraSync, flat])
  return (
    <div className="terrain-viewport flat-capable-view">
      <ViewToggle flat={flat} onChange={setFlat} />
      {onExplore && (
        <button type="button" className="terrain-explore-button" onClick={onExplore}>
          進入太空人探索
        </button>
      )}
      {onExplore && !flat && (
        <span className="terrain-explore-hint" aria-hidden="true">
          點擊地形進入探索
        </span>
      )}
      <div
        className="terrain-canvas"
        ref={host}
        aria-label={flat ? label?.replace(/(?:DEM )?三維重建|實測地形/g, 'DEM 平面高程') : label}
      >
        {flat && lostNote && <p className="terrain-lost-note" role="status">3D 繪圖資源不足，已改為平面顯示。</p>}
        {flat && (
          <FlatTerrain
            terrain={terrain}
            heightScaleM={heightScaleM}
            label={label?.replace(/(?:DEM )?三維重建|實測地形/g, 'DEM 平面高程')}
          />
        )}
      </div>
      {!flat && textureUrl && (
        <div className="terrain-texture-credit">
          {textureState === 'ready'
            ? textureCredit
            : textureState === 'loading'
              ? '正在貼合衛星影像…'
              : '影像暫不可用 · 高程配色'}
        </div>
      )}
    </div>
  )
}
