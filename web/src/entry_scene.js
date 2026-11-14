// Landing-page scene: Earth with a day/night terminator, ocean glint, drifting clouds and an
// atmospheric rim; the Moon on its orbit; Mars in the distance on a transfer arc; the Sun and a
// twinkling star field. Body sizes keep their true ratios; distances are compressed.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const NOISE = `
vec3 hash3(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return -1.0 + 2.0*fract(sin(p)*43758.5453123); }
float noise3(vec3 p){ vec3 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i),f), dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x), mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x), mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z); }
float fbm3(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a*noise3(p); p *= 2.03; a *= 0.5; } return s; }
`

function sunCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 512
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256)
  g.addColorStop(0, '#fffbe6'); g.addColorStop(0.18, '#fff3c4'); g.addColorStop(0.28, '#ffd27a'); g.addColorStop(0.42, 'rgba(255,170,70,0.35)'); g.addColorStop(0.7, 'rgba(255,130,40,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512)
  return c
}

// Compressed Moon orbit radius in Earth radii (true size ratio is kept for the bodies, not the distance).
const ORBIT = 2.5
export const narrowFrame = (w, h) => w < 820 || w / h < 1.1

export function createEntryScene({ container, onHover, onPick, reducedMotion = false, mobile = false }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1 : 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setClearColor(0x020408)
  container.appendChild(renderer.domElement)
  renderer.domElement.setAttribute('aria-hidden', 'true')

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(36, container.clientWidth / container.clientHeight, 0.1, 2000)
  camera.position.set(0.6, 1.2, 8.6)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enablePan = false; controls.enableZoom = false; controls.enableDamping = true; controls.dampingFactor = 0.06
  // The camera holds still (Earth spins, the Moon orbits) and dragging is bounded, so the planets never swing over
  // the headline beside or below them.
  controls.minPolarAngle = Math.PI * 0.42; controls.maxPolarAngle = Math.PI * 0.56
  controls.minAzimuthAngle = -0.45; controls.maxAzimuthAngle = 0.5
  const disposables = []
  const keep = x => { disposables.push(x); return x }
  const loader = new THREE.TextureLoader()
  const texture = url => { const t = keep(loader.load(url)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t }

  const sunDir = new THREE.Vector3(0.82, 0.24, 0.56).normalize()
  const sunLight = new THREE.DirectionalLight(0xfff4e2, 3.2)
  sunLight.position.copy(sunDir).multiplyScalar(50)
  scene.add(sunLight, new THREE.AmbientLight(0x2a3444, 0.5))

  // Earth: day map, night side, terminator glow and specular ocean glint
  const segs = mobile ? 64 : 128
  const earthUniforms = { dayMap: { value: texture('/earth-color.jpg') }, sunDir: { value: sunDir }, time: { value: 0 } }
  const earth = new THREE.Mesh(keep(new THREE.SphereGeometry(1, segs, segs / 2)), keep(new THREE.ShaderMaterial({
    uniforms: earthUniforms,
    vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform sampler2D dayMap; uniform vec3 sunDir; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main(){ vec3 n = normalize(vN); vec3 v = normalize(cameraPosition - vW);
        vec3 day = texture2D(dayMap, vUv).rgb; day = pow(day, vec3(2.2));
        float d = dot(n, sunDir); float lit = smoothstep(-0.12, 0.28, d);
        float ocean = smoothstep(0.02, 0.12, day.b - max(day.r, day.g) * 0.85);
        vec3 h = normalize(sunDir + v); float spec = pow(max(dot(n, h), 0.0), 90.0) * ocean * lit * 1.6;
        vec3 night = day * vec3(0.006, 0.009, 0.02);
        vec3 col = mix(night, day * (0.25 + 1.6 * max(d, 0.0)), lit) + vec3(1.0, 0.92, 0.8) * spec;
        vec3 haze = vec3(0.16, 0.36, 0.82) * (0.10 + 0.9 * pow(1.0 - max(dot(n, v), 0.0), 2.2)) * lit * (0.35 + 0.65 * max(d, 0.0));
        col += haze * 0.75 + vec3(0.01, 0.05, 0.13) * ocean * lit;
        gl_FragColor = vec4(pow(col, vec3(1.0/2.2)), 1.0); }`,
  })))
  earth.rotation.z = THREE.MathUtils.degToRad(23.4)
  const earthSpin = new THREE.Group(); earthSpin.add(earth); scene.add(earthSpin)

  // Procedural clouds, lit by the same sun and darker on the night side
  const clouds = new THREE.Mesh(keep(new THREE.SphereGeometry(1.012, segs, segs / 2)), keep(new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir }, time: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: 'varying vec3 vP; varying vec3 vN; void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: NOISE + `uniform vec3 sunDir; uniform float time; varying vec3 vP; varying vec3 vN;
      void main(){ vec3 p = normalize(vP); float band = 1.0 - abs(p.y) * 0.35;
        vec3 q = p * 2.6 + vec3(time * 0.012, 0.0, time * 0.006);
        float n = fbm3(q + fbm3(q * 1.7) * 0.8);
        float a = smoothstep(0.08, 0.42, n * band) * 0.85;
        float lit = smoothstep(-0.1, 0.3, dot(normalize(vN), sunDir));
        gl_FragColor = vec4(vec3(0.96) * (0.08 + 0.92 * lit), a * (0.25 + 0.75 * lit)); }`,
  })))
  earth.add(clouds)

  // Atmosphere rim (Fresnel), warmer near the terminator
  const atmosphere = new THREE.Mesh(keep(new THREE.SphereGeometry(1.07, segs, segs / 2)), keep(new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir } }, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform vec3 sunDir; varying vec3 vN; varying vec3 vW;
      void main(){ vec3 n = normalize(vN); vec3 v = normalize(cameraPosition - vW);
        float rim = pow(clamp(0.72 + dot(n, v), 0.0, 1.0), 4.0);
        float d = dot(-n, sunDir); float lit = smoothstep(-0.35, 0.45, d);
        vec3 col = mix(vec3(0.95, 0.45, 0.2), vec3(0.3, 0.6, 1.0), smoothstep(-0.05, 0.4, d));
        gl_FragColor = vec4(col * rim * lit * 1.4, 1.0); }`,
  })))
  scene.add(atmosphere)

  // Moon on a compressed orbit (true size ratio 0.273 Earth radii)
  const moonOrbit = new THREE.Group(); moonOrbit.rotation.x = THREE.MathUtils.degToRad(5.1); scene.add(moonOrbit)
  const moonMaterial = keep(new THREE.MeshStandardMaterial({ map: texture('/moon-color.webp'), bumpMap: keep(loader.load('/moon-height.webp')), bumpScale: 0.8, roughness: 1, metalness: 0 }))
  const moon = new THREE.Mesh(keep(new THREE.SphereGeometry(0.273, 64, 32)), moonMaterial)
  moon.userData.body = 'moon'
  moonOrbit.add(moon)
  const orbitPoints = new THREE.EllipseCurve(0, 0, ORBIT, ORBIT).getPoints(160).map(p => new THREE.Vector3(p.x, 0, p.y))
  const moonRing = new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(orbitPoints)), keep(new THREE.LineBasicMaterial({ color: 0xececec, transparent: true, opacity: 0.22 })))
  moonOrbit.add(moonRing)

  // Mars far off, joined by a dotted transfer arc
  const mars = new THREE.Mesh(keep(new THREE.SphereGeometry(0.532, 64, 32)), keep(new THREE.MeshStandardMaterial({ map: texture('/mars-viking.jpg'), roughness: 1, metalness: 0 })))
  mars.position.set(2.0, 2.6, -9)
  mars.userData.body = 'mars'
  scene.add(mars)
  const marsHalo = new THREE.Mesh(keep(new THREE.SphereGeometry(0.56, 48, 24)), keep(new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir } }, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform vec3 sunDir; varying vec3 vN; varying vec3 vW; void main(){ vec3 n = normalize(vN); vec3 v = normalize(cameraPosition - vW); float rim = pow(clamp(0.75 + dot(n, v), 0.0, 1.0), 5.0); gl_FragColor = vec4(vec3(0.9, 0.55, 0.35) * rim * smoothstep(-0.3, 0.5, dot(-n, sunDir)) * 0.7, 1.0); }',
  })))
  marsHalo.position.copy(mars.position); scene.add(marsHalo)
  const transfer = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.9, 0.5, 0.6), new THREE.Vector3(3.6, 3.8, -2.5), mars.position.clone().add(new THREE.Vector3(-0.5, -0.2, 0.4)))
  const transferLine = new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(transfer.getPoints(120))), keep(new THREE.LineDashedMaterial({ color: 0xe8a77f, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.45 })))
  transferLine.computeLineDistances(); scene.add(transferLine)

  // Sun
  const sun = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: keep(new THREE.CanvasTexture(sunCanvas())), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })))
  sun.position.copy(sunDir).multiplyScalar(60); sun.scale.setScalar(16)
  scene.add(sun)

  // Twinkling stars computed on the GPU
  const N = mobile ? 700 : 1500, sp = new Float32Array(N * 3), sc = new Float32Array(N * 3), ss = new Float32Array(N), sph = new Float32Array(N), sf = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = 300 + Math.random() * 300, s = Math.sqrt(1 - u * u)
    sp.set([s * Math.cos(t) * r, u * r, s * Math.sin(t) * r], i * 3)
    const k = Math.random(), col = k < 0.7 ? [1, 1, 1] : k < 0.9 ? [0.72, 0.82, 1] : [1, 0.82, 0.62]
    sc.set(col, i * 3); ss[i] = 0.6 + Math.pow(Math.random(), 3) * 2.6; sph[i] = Math.random() * 6.28; sf[i] = 0.5 + Math.random() * 2.5
  }
  const starGeometry = keep(new THREE.BufferGeometry())
  starGeometry.setAttribute('position', new THREE.BufferAttribute(sp, 3)); starGeometry.setAttribute('color', new THREE.BufferAttribute(sc, 3))
  starGeometry.setAttribute('size', new THREE.BufferAttribute(ss, 1)); starGeometry.setAttribute('phase', new THREE.BufferAttribute(sph, 1)); starGeometry.setAttribute('frequency', new THREE.BufferAttribute(sf, 1))
  const starUniforms = { time: { value: 0 }, pixelRatio: { value: renderer.getPixelRatio() } }
  const stars = new THREE.Points(starGeometry, keep(new THREE.ShaderMaterial({
    uniforms: starUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'attribute float size; attribute vec3 color; attribute float phase; attribute float frequency; uniform float time; uniform float pixelRatio; varying vec3 vC; varying float vA; void main(){ vC = color; vA = 0.55 + 0.45 * sin(time * frequency + phase); gl_PointSize = size * pixelRatio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vC; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * a * vA, a * vA); }',
  })))
  scene.add(stars)

  // Hover and click on the Moon or Mars
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), pickable = [moon, mars]
  let hovered = null, down = null
  const bodyAt = e => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    return raycaster.intersectObjects(pickable, false)[0]?.object.userData.body || null
  }
  const screenOf = object => { const p = object.getWorldPosition(new THREE.Vector3()).project(camera); const rect = renderer.domElement.getBoundingClientRect(); return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height } }
  const onMove = e => {
    const body = bodyAt(e)
    if (body !== hovered) { hovered = body; renderer.domElement.style.cursor = body ? 'pointer' : 'grab'; onHover?.(body) }
  }
  const onDown = e => { down = { x: e.clientX, y: e.clientY } }
  const onUp = e => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) { const body = bodyAt(e); if (body) onPick?.(body) } down = null }
  renderer.domElement.addEventListener('pointermove', onMove)
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)

  let scroll = 0, frame = 0, disposed = false, last = performance.now(), t = 0, visible = true
  const loop = now => {
    if (disposed) return
    frame = requestAnimationFrame(loop)
    if (!visible || document.hidden) { last = now; return }
    // Phones draw at 30 fps; the motion is slow so this is not visible, but it halves the GPU work.
    if (mobile && now - last < 31) return
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    if (!reducedMotion) t += dt
    earth.rotation.y = t * 0.05 + scroll * 1.2
    moonOrbit.rotation.y = 2.4 + t * 0.03
    moon.position.set(ORBIT, 0, 0)
    moon.rotation.y = -moonOrbit.rotation.y + Math.PI
    mars.rotation.y = t * 0.04
    earthUniforms.time.value = t; clouds.material.uniforms.time.value = t; starUniforms.time.value = t
    transferLine.material.opacity = 0.25 + 0.2 * Math.sin(t * 1.5) ** 2
    // Scrolling eases the camera back and up, the "scroll to navigate" effect.
    controls.target.set(-scroll * 2.2, scroll * 0.6, -scroll * 2)
    controls.update()
    renderer.render(scene, camera)
    if (hovered) onHover?.(hovered, screenOf(hovered === 'moon' ? moon : mars))
  }
  frame = requestAnimationFrame(loop)
  const resize = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight
    if (!w || !h) return
    camera.aspect = w / h
    // Wide screens: the Moon's orbit fills the right half (Earth at 75 % of the width, orbit radius at most a quarter of
    // the width), the headline owns the left 44 %. Narrow or portrait screens: Earth in the top band (centre at 25 % of
    // the height), the headline below 46 %. The landing CSS uses the same breakpoint.
    if (narrowFrame(w, h)) {
      camera.position.setLength(11.5)
      camera.setViewOffset(w, h, 0, h * 0.25, w, h)
    } else {
      camera.position.setLength(Math.min(14, Math.max(8.6, 2 * ORBIT / (Math.tan(THREE.MathUtils.degToRad(18)) * w / h))))
      camera.setViewOffset(w, h, -w * 0.25, 0, w, h)
    }
    camera.updateProjectionMatrix(); renderer.setSize(w, h)
  })
  resize.observe(container)

  return {
    setScroll(value) { scroll = value },
    setVisible(value) { visible = value },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); controls.dispose()
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      disposables.forEach(x => x.dispose?.()); renderer.dispose(); renderer.domElement.remove()
    },
  }
}
