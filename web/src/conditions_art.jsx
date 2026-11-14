import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { LOOKS, rockMesh } from './rock_mesh.js'
import { getLanguage } from './i18n/core.js'
import { BARE, DUNES, FIRE_2D, FIRE_BED, HYDRATED, LOW_SUN, PERMAFROST, RAIN, SNOW, STEAM, VOLCANO } from './conditions_scenes.js'
import './conditions_art.css'

// Animated illustration for each condition card, driven by the candidate's own value: a WebGL campfire when the
// place is dry and rain when it is wet, snowfall scaled by the cold share, an erupting cone when a basaltic volcano
// is close, and rotating rock models for lithology. Decorative only; the gauge beside it carries the data.
// Animation pauses off screen and stops under prefers-reduced-motion.
const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Run `draw(t, dt)` every frame while the canvas is on screen.
function useFrameLoop(ref, setup, deps) {
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const api = setup(cv)
    if (!api) return
    const reduce = reduced()
    let raf = 0, visible = true, last = performance.now(), t = 0
    const frame = now => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt
      api.draw(t, dt)
      if (visible && !reduce) raf = requestAnimationFrame(frame)
    }
    if (reduce) { for (let i = 0; i < 60; i++) { t += 1 / 30; api.draw(t, 1 / 30) } }
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => {
      visible = e.isIntersecting; cancelAnimationFrame(raf)
      if (visible && !reduce) { last = performance.now(); raf = requestAnimationFrame(frame) }
    })
    if (io) io.observe(cv); else if (!reduce) raf = requestAnimationFrame(frame)
    const resize = () => api.fit?.()
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(raf); io?.disconnect(); window.removeEventListener('resize', resize); api.dispose?.() }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
}

export function SceneCanvas({ scene, params }) {
  const ref = useRef(null)
  const key = JSON.stringify(params)
  useFrameLoop(ref, cv => {
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.round((cv.clientWidth || 84) * dpr); cv.height = Math.round((cv.clientHeight || 84) * dpr)
      ctx.setTransform(cv.width / 88, 0, 0, cv.height / 88, 0, 0)
    }
    fit()
    const st = { p: params, t: 0 }
    scene.init?.(st)
    return { fit, draw: (t, dt) => { st.t = t; ctx.clearRect(0, 0, 88, 88); scene.draw(ctx, st, dt) } }
  }, [scene, key])
  return <canvas ref={ref} className="cart-canvas" aria-hidden="true" />
}

// Campfire flame: three noise-driven tongues rising through a white -> yellow -> orange -> red temperature ramp.
const FLAME_FS = `precision mediump float;
uniform vec2 uRes; uniform float uTime; uniform float uPower;
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y); }
float fbm(vec2 p){ float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { s += a * vn(p); p = m * p; a *= .5; } return s; }
float tongue(vec2 uv, float off, float hs, float ph){
  float x = uv.x - .5 - off;
  float s = (uv.y - .1) / (.66 * uPower * hs);
  float cs = clamp(s, 0., 1.);
  float w = .36 * (.55 + .45 * hs) * sqrt(clamp(s + .05, 0., 1.)) * pow(1. - cs, 1.5);
  float n1 = fbm(vec2(x * 3. + ph, uv.y * 3. - uTime * 2.6));
  float n2 = fbm(vec2(x * 6. + 3.1 + ph, uv.y * 6.5 - uTime * 4.42));
  float k = 1. - abs(x + (n1 - .5) * .24 * cs) / max(w, 1e-3) - (n2 - .35) * 2.4 * cs;
  return clamp(k, 0., 1.) * smoothstep(-.06, .04, s) * (1. - .3 * cs) * (1. - smoothstep(.85, 1., s));
}
vec3 ramp(float h){
  vec3 c = mix(vec3(.35, .04, 0.), vec3(.78, .13, .02), clamp(h / .18, 0., 1.));
  c = mix(c, vec3(1., .45, .06), clamp((h - .18) / .24, 0., 1.));
  c = mix(c, vec3(1., .8, .3), clamp((h - .42) / .26, 0., 1.));
  return mix(c, vec3(1., .97, .86), clamp((h - .68) / .24, 0., 1.));
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float h = tongue(uv, -.13, .6, 1.7) + tongue(uv, 0., 1., 0.) + tongue(uv, .12, .72, 4.1);
  h = clamp(h * .95, 0., 1.) * (.82 + .18 * fbm(vec2((uv.x - .5) * 2. + 9., uv.y * 2. - uTime * 5.)));
  float a = smoothstep(.02, .28, h);
  gl_FragColor = vec4(ramp(h) * a, a);
}`

function FlameGL({ power, onFail }) {
  const ref = useRef(null)
  useFrameLoop(ref, cv => {
    const g = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false })
    if (!g) { onFail(); return null }
    const shader = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); return g.getShaderParameter(s, g.COMPILE_STATUS) ? s : null }
    const vs = shader(g.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }'), fs = shader(g.FRAGMENT_SHADER, FLAME_FS)
    const pr = g.createProgram()
    if (!vs || !fs) { onFail(); return null }
    g.attachShader(pr, vs); g.attachShader(pr, fs); g.linkProgram(pr)
    if (!g.getProgramParameter(pr, g.LINK_STATUS)) { onFail(); return null }
    g.useProgram(pr)
    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer())
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW)
    const loc = g.getAttribLocation(pr, 'p'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
    const uRes = g.getUniformLocation(pr, 'uRes'), uTime = g.getUniformLocation(pr, 'uTime'), uPower = g.getUniformLocation(pr, 'uPower')
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.round((cv.clientWidth || 84) * dpr); cv.height = Math.round((cv.clientHeight || 84) * dpr); g.viewport(0, 0, cv.width, cv.height)
    }
    fit()
    return {
      fit,
      draw: t => { g.uniform2f(uRes, cv.width, cv.height); g.uniform1f(uTime, t + 3); g.uniform1f(uPower, power); g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT); g.drawArrays(g.TRIANGLE_STRIP, 0, 4) },
      dispose: () => g.getExtension('WEBGL_lose_context')?.loseContext(),
    }
  }, [power])
  return <canvas ref={ref} className="cart-canvas" aria-hidden="true" />
}

function Fire({ power }) {
  const [gl, setGl] = useState(true)
  return <div className="cart-stack">
    <SceneCanvas scene={gl ? FIRE_BED : FIRE_2D} params={{ power }} />
    {gl && <FlameGL key={power} power={power} onFail={() => setGl(false)} />}
  </div>
}

// ---------------------------------------------------------------- rotating rock models (three.js, one canvas)
const KIND_LOOK = { basaltic: 'basalt', anorthositic: 'anorthosite', sedimentary: 'sandstone' }
const KIND_NAME = { basaltic: ['玄武岩', 'basalt'], anorthositic: ['斜長岩', 'anorthosite'], sedimentary: ['沉積岩', 'sedimentary rock'] }
const GLIM = {
  vb: ['basalt', '基性火山岩', 'basic volcanic'], vi: ['andesite', '中性火山岩', 'intermediate volcanic'], va: ['rhyolite', '酸性火山岩', 'acid volcanic'],
  py: ['pyroclastic', '火山碎屑岩', 'pyroclastic'], pb: ['gabbro', '基性深成岩', 'basic plutonic'], pi: ['diorite', '中性深成岩', 'intermediate plutonic'],
  pa: ['granite', '酸性深成岩', 'acid plutonic'], ss: ['sandstone', '矽質碎屑沉積岩', 'siliciclastic sedimentary'], sm: ['mixed', '混合沉積岩', 'mixed sedimentary'],
  sc: ['limestone', '碳酸鹽沉積岩', 'carbonate sedimentary'], su: ['sand', '未固結沉積物', 'unconsolidated sediment'], mt: ['gneiss', '變質岩', 'metamorphic'],
  ev: ['evaporite', '蒸發岩', 'evaporite'], ig: ['ice', '冰與冰川', 'ice and glaciers'], nd: ['unknown', '未分類', 'unclassified'],
}


let shadowTexture
function groundShadow() {
  if (!shadowTexture) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64
    const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32)
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)')
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64)
    shadowTexture = new THREE.CanvasTexture(cv)
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.3), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }))
  mesh.rotation.x = -Math.PI / 2
  return mesh
}

function RockSpin({ rocks }) {
  const ref = useRef(null)
  const [failed, setFailed] = useState(false)
  const keyOf = rocks.map(r => r.look).join('|')
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let renderer
    try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' }) } catch { setFailed(true); return }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    const size = () => { const w = canvas.clientWidth || 240, h = canvas.clientHeight || 96; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix() }
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(28, 2.5, 0.1, 50)
    camera.position.set(0, 0.45, 6.1); camera.lookAt(0, 0, 0)
    scene.add(new THREE.HemisphereLight(0xe6f2ee, 0x1b2b2b, 0.75))
    const sun = new THREE.DirectionalLight(0xfff4e6, 3.3); sun.position.set(3, 4, 5); scene.add(sun)
    const rim = new THREE.DirectionalLight(0x9fd8ff, 1.6); rim.position.set(-4, 2, -5); scene.add(rim)
    const meshes = rocks.map((r, i) => { const m = rockMesh(r.look, 9301 + i * 4049 + r.look.length * 97); m.position.x = rocks.length === 2 ? (i ? 1.45 : -1.45) : 0; scene.add(m); return m })
    const shadows = meshes.map(m => { const sh = groundShadow(); sh.position.set(m.position.x, -0.95, 0); scene.add(sh); return sh })
    size()
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, visible = true
    const t0 = performance.now()
    const frame = now => {
      const t = (now - t0) / 1000
      meshes.forEach((m, i) => { m.rotation.y = t * 0.6 + i * 1.7; m.rotation.x = Math.sin(t * 0.45 + i) * 0.22; m.position.y = 0.06 * Math.sin(t * 1.2 + i) })
      renderer.render(scene, camera)
      if (!reduce && visible) raf = requestAnimationFrame(frame)
    }
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => {
      visible = e.isIntersecting; cancelAnimationFrame(raf); if (visible) raf = requestAnimationFrame(frame)
    })
    io?.observe(canvas)
    window.addEventListener('resize', size)
    frame(t0)
    return () => {
      cancelAnimationFrame(raf); io?.disconnect(); window.removeEventListener('resize', size)
      for (const m of [...meshes, ...shadows]) { m.geometry.dispose(); m.material.dispose() }
      renderer.dispose(); renderer.forceContextLoss()
    }
  }, [keyOf])
  return <div className="cart-rocks">
    {failed ? <div className="cart-rocks-fallback">{rocks.map(r => <i key={r.look} style={{ background: LOOKS[r.look]?.base }} />)}</div>
      : <canvas key={keyOf} ref={ref} className="cart-rock-canvas" aria-hidden="true" />}
    <div className={`cart-rock-labels n${rocks.length}`}>{rocks.map(r => <span key={r.label}><small>{r.label}</small>{r.name}</span>)}</div>
  </div>
}

export function ConditionArt({ row, earthLithology }) {
  const g = row.gauge || {}, v = g.raw ?? g.value
  const unknown = row.verdict === -1
  if (row.id === 'lithology') {
    const kind = g.kind || 'basaltic'
    const rocks = [{ look: KIND_LOOK[kind] || 'basalt', label: tr('需要', 'needs'), name: tr(...(KIND_NAME[kind] || KIND_NAME.basaltic)) }]
    const gl = earthLithology?.available && GLIM[earthLithology.code]
    if (gl) rocks.push({ look: gl[0], label: tr('候選中心格', 'candidate centre'), name: tr(gl[1], gl[2]) })
    return <div className={`cart is-wide ${unknown ? 'is-unknown' : ''}`}><RockSpin rocks={rocks} /></div>
  }
  const num = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)
  const art = {
    dry: () => row.verdict === 2 ? <Fire power={0.8 + 0.2 * (1 - Math.min(1, Math.max(0, (v ?? 0.2) / 0.2)))} />
      : row.verdict === 1 ? <SceneCanvas scene={STEAM} params={{}} /> : <SceneCanvas scene={RAIN} params={{ aridity: num(v) }} />,
    bare: () => <SceneCanvas scene={BARE} params={{ bare: num(v), ice: !!g.ice_cover }} />,
    cold: () => <SceneCanvas scene={SNOW} params={{ cold: num(v) }} />,
    ground_ice: () => <SceneCanvas scene={PERMAFROST} params={{ ice: num(v) }} />,
    low_sun: () => <SceneCanvas scene={LOW_SUN} params={{ lat: num(v) }} />,
    volcanic: () => <SceneCanvas scene={VOLCANO} params={{ km: num(v) }} />,
    aeolian: () => <SceneCanvas scene={DUNES} params={{ dune: g.via_sand ? 0.02 : num(v) }} />,
    hydrated: () => <SceneCanvas scene={HYDRATED} params={{ hyd: num(v) }} />,
  }[row.id]
  if (!art) return null
  return <div className={`cart ${unknown ? 'is-unknown' : ''}`}>{art()}</div>
}
