import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useFlatView, ViewToggle, FlatTerrain } from './flat_view.jsx'
import { renderGate } from './render_gate.js'

export function TerrainView({ terrain, tone = 'moon', label, wireframe = false, textureUrl = null, textureCredit = '', heightScaleM = null, cameraSync = null, onExplore = null }) {
  const host = useRef(null)
  const exploreRef = useRef(onExplore)
  exploreRef.current = onExplore
  const [flat,setFlat]=useFlatView()
  const [textureState, setTextureState] = useState(textureUrl ? 'loading' : 'none')
  useEffect(() => {
    if (!host.current || !terrain || flat) return
    setTextureState(textureUrl ? 'loading' : 'none')
    const width = host.current.clientWidth
    const height = host.current.clientHeight
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100)
    camera.position.set(2.7, 2.6, 3.1)
    let renderer
    try {renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, alpha: true })} catch {setFlat(true);return}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    // Static scene: render on demand (camera moves, texture arrives, resize), not every frame.
    let dirty = true, onScreen = true
    const visibility = new IntersectionObserver(entries => { onScreen = entries[0]?.isIntersecting ?? true; dirty = true }, { threshold: 0.01 })
    visibility.observe(host.current)
    renderer.domElement.addEventListener('webglcontextlost', event=>{event.preventDefault();setFlat(true)}, {once:true})
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.current.appendChild(renderer.domElement)
    const count = terrain.size
    const geometry = new THREE.PlaneGeometry(3.2, 3.2, count - 1, count - 1)
    const pos = geometry.attributes.position
    const heights = terrain.heights_m
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
      renderer.dispose(); renderer.domElement.remove()
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
