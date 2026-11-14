import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { getLanguage } from './i18n/core.js'
import { PURPOSES } from './purposes.js'
import { BARE, DUNES, HYDRATED, RAIN, SNOW, VOLCANO } from './conditions_scenes.js'
import { rockMesh } from './rock_mesh.js'
import './selection_tiles.css'

// Selection page choices drawn as animated tiles instead of drop-down lists: four search purposes, the Earth
// environment and the lithology condition. The pictures reuse the condition-panel scenes (2D canvas) and rock models
// (one shared WebGL renderer for every rock tile). Decorative only; the button text carries the choice.
const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Terrain relief: stacked ridge lines drifting slowly, for the shape-only purpose.
const RELIEF = {
  draw(ctx, st) {
    const t = st.t, g = ctx.createLinearGradient(0, 0, 0, 88)
    g.addColorStop(0, '#08151b'); g.addColorStop(1, '#14303a'); ctx.fillStyle = g; ctx.fillRect(0, 0, 88, 88)
    for (let k = 0; k < 7; k++) {
      const y0 = 34 + k * 8, peak = 44 + 10 * Math.sin(t * 0.35 + k * 0.7)
      ctx.strokeStyle = `rgba(240,240,240,${0.18 + 0.11 * k})`; ctx.lineWidth = 0.8
      ctx.beginPath()
      for (let x = 0; x <= 88; x += 2) {
        const y = y0 - (14 - k) * Math.exp(-((x - peak) ** 2) / 260) + 1.6 * Math.sin(x * 0.16 + t * 0.7 + k)
        if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y)
      }
      ctx.stroke()
    }
  },
}

// Gamma-ray spectrum: a continuum with element lines flickering like counting statistics, for the physical-match purpose.
const SPECTRUM = {
  draw(ctx, st) {
    const t = st.t
    ctx.fillStyle = '#07161a'; ctx.fillRect(0, 0, 88, 88)
    const lines = [[0.16, 0.9], [0.29, 0.7], [0.75, 0.45], [0.84, 0.35]]
    for (let b = 0; b < 40; b++) {
      const e = b / 40
      let h = 0.5 * Math.exp(-3 * e)
      for (const [c, a] of lines) h += a * Math.exp(-((e - c) ** 2) / 0.0009)
      h *= 1 + 0.14 * Math.sin(t * 6 + b * 2.1) + 0.09 * Math.sin(t * 11 + b * 4.7)
      ctx.fillStyle = b % 2 ? 'rgba(219,219,219,.85)' : 'rgba(201,201,201,.85)'
      ctx.fillRect(4 + b * 2, 82 - 56 * h, 1.4, 56 * h)
    }
  },
}

// Animated 2D scene: the 88-unit scene covers the canvas; `focus` (third entry, default 1 = bottom) picks which band
// of the scene stays in view, so the ground shows for landscapes and the summit for the volcano.
// With several scenes it cross-fades from one to the next every `period` seconds.
function TileScene({ scenes, period = 3.2 }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!ctx) return
    let dpr = 1, w = 0, h = 0, s = 1
    const fit = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1); w = cv.clientWidth || 120; h = cv.clientHeight || 64; s = Math.max(w, h) / 88
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
    }
    fit()
    const states = scenes.map(([scene, p]) => { const st = { p: p || {}, t: 0 }; scene.init?.(st); return st })
    const paint = (t, dt) => {
      // the frame timestamp can precede `last`, so t may step back slightly: keep the index non-negative
      const n = scenes.length, c = Math.max(0, t), i = Math.floor(c / period) % n, f = (c % period) / period
      const draw = (k, alpha) => {
        const focus = scenes[k][2] ?? 1
        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (w - 88 * s) / 2, -dpr * s * (88 - h / s) * focus)
        states[k].t = t; ctx.globalAlpha = alpha; scenes[k][0].draw(ctx, states[k], dt)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height)
      draw(i, 1)
      if (n > 1 && f > 0.82) draw((i + 1) % n, (f - 0.82) / 0.18)
      ctx.globalAlpha = 1
    }
    let raf = 0, visible = true, last = performance.now(), t = Math.random() * 2
    const frame = now => { const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = Math.max(last, now); t += dt; paint(t, dt); if (visible) raf = requestAnimationFrame(frame) }
    if (reduced()) { for (let k = 0; k < 45; k++) { t += 1 / 30; paint(t, 1 / 30) } return }
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => {
      visible = e.isIntersecting; cancelAnimationFrame(raf); if (visible) { last = performance.now(); raf = requestAnimationFrame(frame) }
    })
    if (io) io.observe(cv); else raf = requestAnimationFrame(frame)
    window.addEventListener('resize', fit)
    return () => { cancelAnimationFrame(raf); io?.disconnect(); window.removeEventListener('resize', fit) }
  }, [scenes, period])
  return <canvas ref={ref} className="sel-tile-canvas" aria-hidden="true" />
}

// One WebGL renderer paints every rock tile: each frame it renders the tile's rock and copies the image into the
// tile's own 2D canvas, so a dozen tiles cost one GL context.
const rockPainter = (() => {
  let renderer = null, scene = null, camera = null, failed = false, raf = 0
  const items = new Set()
  const W = 168, H = 112
  const ensure = () => {
    if (renderer) return true
    if (failed) return false
    try { renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: true }) } catch { failed = true; return false }
    renderer.setPixelRatio(1); renderer.setSize(W, H, false)
    scene = new THREE.Scene()
    camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 50); camera.position.set(0, 0.35, 4.7); camera.lookAt(0, 0, 0)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x1b2b2b, 0.8))
    const sun = new THREE.DirectionalLight(0xfff4e6, 3.2); sun.position.set(3, 4, 5); scene.add(sun)
    const rim = new THREE.DirectionalLight(0xe3e3e3, 1.5); rim.position.set(-4, 2, -5); scene.add(rim)
    return true
  }
  const paintItem = (it, t) => {
    const k = it.meshes.length > 1 ? Math.floor((t + it.phase) / 2.6) % it.meshes.length : 0
    const m = it.meshes[k]
    m.rotation.y = t * 0.6 + it.phase; m.rotation.x = Math.sin(t * 0.45 + it.phase) * 0.22; m.position.y = 0.05 * Math.sin(t * 1.2 + it.phase)
    scene.add(m); renderer.render(scene, camera); scene.remove(m)
    const cv = it.canvas, ctx = it.ctx, dpr = Math.min(2, window.devicePixelRatio || 1)
    const cw = Math.round((cv.clientWidth || 96) * dpr), ch = Math.round((cv.clientHeight || 60) * dpr)
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch }
    const sc = Math.min(cw / W, ch / H), dw = W * sc, dh = H * sc
    ctx.clearRect(0, 0, cw, ch); ctx.drawImage(renderer.domElement, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
  }
  const frame = now => {
    raf = 0
    const t = now / 1000
    let any = false
    for (const it of items) if (it.visible) { paintItem(it, t); any = true }
    if (any && !reduced()) raf = requestAnimationFrame(frame)
  }
  return {
    add(it) {
      if (!ensure()) return false
      it.meshes = it.looks.map((look, i) => rockMesh(look, 7001 + i * 313 + look.length * 97))
      items.add(it)
      if (reduced()) paintItem(it, 1.3)
      this.kick()
      return true
    },
    remove(it) {
      items.delete(it)
      it.meshes?.forEach(m => { m.geometry.dispose(); m.material.dispose() })
      if (!items.size && renderer) { cancelAnimationFrame(raf); raf = 0; renderer.dispose(); renderer.forceContextLoss(); renderer = null }
    },
    kick() { if (!raf && !reduced()) raf = requestAnimationFrame(frame) },
  }
})()

function RockTile({ looks }) {
  const ref = useRef(null)
  const key = looks.join('|')
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return
    const it = { canvas, ctx, looks, visible: true, phase: Math.random() * 6 }
    if (!rockPainter.add(it)) return
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => { it.visible = e.isIntersecting; if (it.visible) rockPainter.kick() })
    io?.observe(canvas)
    return () => { io?.disconnect(); rockPainter.remove(it) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="sel-tile-canvas is-rock" aria-hidden="true" />
}

// Scene lists are module constants so the canvases do not restart on every render.
const ART = {
  conditions: [[BARE, { bare: 0.9 }], [SNOW, { cold: 0.8 }], [HYDRATED, { hyd: 0.7 }]],  // no volcano here: that is the lava-tube tile
  morphology: [[RELIEF]],
  physical: [[SPECTRUM]],
  maxmatch: [[SPECTRUM]],
  facets: [[BARE, { bare: 0.7 }], [SNOW, { cold: 0.75 }], [DUNES, { dune: 0.2 }]],
  lavatube: [[VOLCANO, { km: 20 }, 0.3]],
  desert: [[BARE, { bare: 0.85 }]],
  mapped_dunes: [[DUNES, { dune: 0.2 }]],
  anyEnv: [[BARE, { bare: 0.5 }], [SNOW, { cold: 0.7 }], [RAIN, { aridity: 0.9 }]],
}

const PURPOSE_TILES = [
  { key: 'maxmatch', title: ['實測比對', 'Measured match'], sub: ['符合最多項實測資料', 'most measured properties agree'], art: () => <TileScene scenes={ART.maxmatch} /> },
  { key: 'facets', title: ['全面向', 'All facets'], sub: ['十個面向一起計分', 'ten facets scored together'], art: () => <TileScene scenes={ART.facets} /> },
  { key: 'conditions', title: ['條件優先', 'Conditions first'], sub: ['環境＋地質＋資源', 'environment, geology, resources'], art: () => <TileScene scenes={ART.conditions} /> },
  { key: 'physical', title: ['物理相符', 'Physical match'], sub: ['同單位性質', 'same-unit properties'], art: () => <TileScene scenes={ART.physical} /> },
  { key: 'morphology', title: ['地貌研究', 'Landforms'], sub: ['只比地形形狀', 'terrain shape only'], art: () => <TileScene scenes={ART.morphology} /> },
  { key: 'material', title: ['地形＋材質', 'Terrain + material'], sub: ['遮蔽下也能推估', 'inferred under cover'], art: () => <RockTile looks={['basalt', 'limestone']} /> },
  { key: 'lavatube', title: ['熔岩管／天窗坑', 'Lava tubes'], sub: ['兩階段檢索', 'two-stage search'], art: () => <TileScene scenes={ART.lavatube} /> },
]

const ENV_TILES = [
  { key: 'desert', title: ['沙漠與乾燥灌叢', 'Desert and dry shrub'], art: () => <TileScene scenes={ART.desert} /> },
  { key: 'mapped_dunes', title: ['已記錄沙丘', 'Mapped dunes'], art: () => <TileScene scenes={ART.mapped_dunes} /> },
  { key: 'any', title: ['不限環境', 'Any environment'], art: () => <TileScene scenes={ART.anyEnv} /> },
]

const ROCK_TILES = [
  { key: 'auto', title: ['依地質圖', 'From geologic map'], looks: ['basalt', 'anorthosite', 'sandstone'] },
  { key: 'any', title: ['不限岩性', 'Any rock'], looks: ['unknown'] },
  { key: 'vb', title: ['基性火山岩', 'Basic volcanic'], looks: ['basalt'] },
  { key: 'py', title: ['火山碎屑岩', 'Pyroclastic'], looks: ['pyroclastic'] },
  { key: 'su', title: ['未固結沉積物', 'Loose sediment'], looks: ['sand'] },
  { key: 'ss', title: ['矽質碎屑岩', 'Siliciclastic'], looks: ['sandstone'] },
  { key: 'sm', title: ['混合沉積岩', 'Mixed sedimentary'], looks: ['mixed'] },
  { key: 'sc', title: ['碳酸鹽岩', 'Carbonate'], looks: ['limestone'] },
  { key: 'mt', title: ['變質岩', 'Metamorphic'], looks: ['gneiss'] },
]

function Tile({ on, onPick, art, title, sub }) {
  return <button type="button" className={'sel-tile' + (on ? ' is-on' : '')} aria-pressed={on} onClick={onPick}>
    <span className="sel-tile-art">{art}</span>
    <span className="sel-tile-text"><b>{title}</b>{sub && <small>{sub}</small>}</span>
  </button>
}

export function PurposeTiles({ purpose, onPurpose }) {
  return <fieldset className="tile-group purpose-tiles">
    <legend>{tr('搜尋用途', 'Search purpose')}</legend>
    <div className="tile-grid cols-3">
      {PURPOSE_TILES.map(p => <Tile key={p.key} on={purpose === p.key} onPick={() => onPurpose(p.key)} art={p.art()} title={tr(...p.title)} sub={tr(...p.sub)} />)}
    </div>
  </fieldset>
}

const USE_CHIPS = [['isru', ['資源（化學）', 'ISRU (chemistry)']], ['mobility', ['移動', 'Mobility']], ['thermal', ['熱環境', 'Thermal']], ['base', ['基地', 'Base']]]

// The use whose properties rank the physical-match search (protocol p8 uses).
export function UseChips({ use, onUse }) {
  return <fieldset className="tile-group use-chips">
    <legend>{tr('依哪種用途比對', 'Compare for which use')}</legend>
    <div className="use-chip-row">
      {USE_CHIPS.map(([k, t]) => <button key={k} type="button" className={'use-chip' + (use === k ? ' is-on' : '')} aria-pressed={use === k} onClick={() => onUse(k)}>{tr(...t)}</button>)}
    </div>
  </fieldset>
}

const FACET_USE_CHIPS = [['overall', ['全面向', 'All facets']], ['astrobiology', ['天體生物', 'Astrobiology']], ['subsurface', ['地下探測', 'Subsurface']], ['crew_ops', ['乘員作業', 'Crew operations']]]

// The use whose facet weights rank the all-facets search (facets v6).
export function FacetUseChips({ use, onUse }) {
  return <fieldset className="tile-group use-chips facet-use">
    <legend>{tr('偏重哪種用途', 'Weight the facets for which use')}</legend>
    <div className="use-chip-row">
      {FACET_USE_CHIPS.map(([k, t]) => <button key={k} type="button" className={'use-chip' + (use === k ? ' is-on' : '')} aria-pressed={use === k} onClick={() => onUse(k)}>{tr(...t)}</button>)}
    </div>
  </fieldset>
}

// The long description of the chosen purpose, shown under the search button so the button stays in view.
export function PurposeNote({ purpose }) {
  return <p className="tile-note">{PURPOSES[purpose]?.note}</p>
}

export function ConditionTiles({ surface, onSurface, rock, onRock }) {
  return <details className="selection-details condition-tiles" open>
    <summary>調整環境與岩性條件</summary>
    <fieldset className="tile-group">
      <legend>{tr('地球環境', 'Earth environment')}</legend>
      <div className="tile-grid cols-3">
        {ENV_TILES.map(e => <Tile key={e.key} on={surface === e.key} onPick={() => onSurface(e.key)} art={e.art()} title={tr(...e.title)} />)}
      </div>
    </fieldset>
    <fieldset className="tile-group">
      <legend>{tr('岩性條件', 'Lithology')}</legend>
      <div className="tile-grid cols-3">
        {ROCK_TILES.map(r => <Tile key={r.key} on={rock === r.key} onPick={() => onRock(r.key)} art={<RockTile looks={r.looks} />} title={tr(...r.title)} />)}
      </div>
    </fieldset>
    <small>條件會參與全索引檢索；這是你指定的類比目標，不是自動判讀沙丘或裸露岩層。沙丘圖層只記錄地域內曾辨識出沙丘，不表示整個窗格皆為沙地。</small>
  </details>
}
