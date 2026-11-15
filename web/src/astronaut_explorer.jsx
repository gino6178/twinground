import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from './modal_focus.js'
import { useLanguage } from './i18n/language.jsx'
import { createAstronautEngine, decodeDetail } from './astronaut_engine.js'
import { fetchExploreDem, fetchBytes, loadImage, EXPLORER_MODELS, EXPLORER_PROPS } from './explore_dem.js'
import { compareConditions } from './astronaut_weather.js'
import RoutePanel from './eva_route_panel.jsx'
import MissionPanel from './eva_mission_panel.jsx'
import { LifeSupport, CommLine, DaySection } from './eva_life.jsx'
import { renderGate } from './render_gate.js'

const KIND = {
  clear: ['晴', 'Clear'], cloudy: ['多雲', 'Cloudy'], rain: ['雨', 'Rain'], snow: ['雪', 'Snow'], fog: ['霧', 'Fog'], dust: ['沙塵', 'Blowing dust'],
  dusty: ['多塵', 'Dusty'], storm: ['沙塵暴', 'Dust storm'], vacuum: ['真空・無天氣', 'Vacuum, no weather'],
}
const hhmm = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`
const marsSeason = (ls, tr) => ls < 90 ? tr('北半球春', 'northern spring') : ls < 180 ? tr('北半球夏', 'northern summer') : ls < 270 ? tr('北半球秋・沙塵季', 'northern autumn, dust season') : tr('北半球冬・沙塵季', 'northern winter, dust season')

function WeatherPanel({ stats, target, tr, engine, onClose }) {
  const t = stats.time, wx = stats.weather, body = stats.body, isEarth = body === 'earth'
  const set = patch => engine.current?.setTime(patch)
  const tWx = stats.conditions?.target?.weather, eWx = stats.conditions?.earth?.weather
  const rows = tWx && eWx ? compareConditions(tWx, eWx) : []
  const gravity = { moon: 1.62, mars: 3.71 }[target.body]
  const chip = s => ({ match: ['相近', 'Close', 'ok'], partial: ['部分相符', 'Partly', 'mid'], differ: ['差異大', 'Different', 'bad'], never: ['無法類比', 'Cannot match', 'never'] })[s]
  const label = { temperature: tr('此刻氣溫／地表溫度', 'Temperature now'), swing: tr('日溫差', 'Daily swing'), dryness: tr('降水（乾燥度）', 'Precipitation (dryness)'), wind: tr('風速', 'Wind'), pressure: tr('氣壓', 'Pressure') }
  const unit = { temperature: v => `${Math.round(v)} °C`, swing: v => `${Math.round(v)} °C`, dryness: v => `${v.toFixed(2)} mm/d`, wind: v => `${v.toFixed(1)} m/s`, pressure: v => v < 1e-6 ? '≈ 0' : `${v < 2 ? v.toFixed(2) : v.toFixed(1)} kPa` }
  const tName = tr(`${target.body === 'mars' ? '火星' : '月球'}`, target.body === 'mars' ? 'Mars' : 'Moon')
  return <section className="eva-weather" aria-label={tr('時間與天氣', 'Time and weather')}>
    <header><strong>{tr('時間與天氣', 'Time and weather')}</strong><button type="button" onClick={onClose} aria-label={tr('關閉', 'Close')}>✕</button></header>
    <div className="eva-wx-now">
      <b>{Math.round(wx.temperature)}°C</b>
      <span>{tr(KIND[wx.kind]?.[0] || wx.kind, KIND[wx.kind]?.[1] || wx.kind)}</span>
      <small>{tr('太陽高度', 'Sun')} {Math.round(stats.sunElevation)}° · {tr('白晝', 'Daylight')} {stats.dayLength?.toFixed(1)} h · {tr('風', 'Wind')} {wx.wind.toFixed(1)} m/s{isEarth ? ` · ${tr('雲量', 'Cloud')} ${Math.round(wx.cloud * 100)}%` : ''}</small>
    </div>
    <label>{tr('當地時間', 'Local time')} <output>{hhmm(t.hour)}{body === 'mars' ? tr('（火星時）', ' (Mars time)') : body === 'moon' ? tr('（月球時，1 小時 ≈ 29.5 地球小時）', ' (lunar; 1 h ≈ 29.5 Earth h)') : ''}</output>
      <input type="range" min="0" max="23.75" step="0.25" value={t.hour} onChange={e => set({ hour: Number(e.target.value) })} /></label>
    {isEarth && <label>{tr('月份', 'Month')}<select value={t.month} onChange={e => set({ month: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{tr(`${i + 1} 月`, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i])}</option>)}</select></label>}
    {body === 'mars' && <label>{tr('季節 Ls', 'Season Ls')} <output>{Math.round(t.ls)}° · {marsSeason(t.ls, tr)}</output>
      <input type="range" min="0" max="359" value={Math.round(t.ls)} onChange={e => set({ ls: Number(e.target.value) })} /></label>}
    <label>{tr('時間流速', 'Time speed')}<select value={t.speed} onChange={e => set({ speed: Number(e.target.value) })}>
      <option value={0}>{tr('暫停', 'Paused')}</option><option value={1 / 60}>{tr('1 分鐘／秒', '1 min / s')}</option><option value={1 / 6}>{tr('10 分鐘／秒', '10 min / s')}</option><option value={1}>{tr('1 小時／秒', '1 h / s')}</option><option value={2}>{tr('2 小時／秒（縮時）', '2 h / s (time-lapse)')}</option></select></label>
    {isEarth && <label>{tr('天氣', 'Weather')}<select value={t.override} onChange={e => set({ override: e.target.value })}>
      <option value="auto">{tr('自動（依 NASA POWER 氣候）', 'Auto (NASA POWER climate)')}</option>{['clear', 'cloudy', 'rain', 'snow', 'fog', 'dust'].map(k => <option key={k} value={k}>{tr(KIND[k][0], KIND[k][1])}</option>)}</select></label>}
    {body === 'mars' && <label>{tr('沙塵', 'Dust')}<select value={t.override} onChange={e => set({ override: e.target.value })}>
      <option value="auto">{tr('自動（依季節）', 'Auto (by season)')}</option>{['clear', 'dusty', 'storm'].map(k => <option key={k} value={k}>{tr(KIND[k][0], KIND[k][1])}</option>)}</select></label>}
    <button type="button" onClick={() => engine.current?.useNow()}>{tr('現在（真實日期與時間）', 'Now (real date and time)')}</button>
    <DaySection engine={engine} stats={stats} target={target} tr={tr} />
    {rows.length > 0 && <table className="eva-compare"><caption>{tr(`環境比對：${tName}選區 vs 地球候選`, `Conditions: ${tName} selection vs Earth candidate`)}</caption>
      <thead><tr><th scope="col" /><th scope="col">{tName}</th><th scope="col">{tr('地球', 'Earth')}</th><th scope="col" /></tr></thead>
      <tbody>
        {rows.map(r => { const c = chip(r.status); return <tr key={r.key}><th scope="row">{label[r.key]}</th><td>{unit[r.key](r.target)}</td><td>{unit[r.key](r.earth)}</td><td><span className={`eva-chip ${c[2]}`}>{tr(c[0], c[1])}</span></td></tr> })}
        <tr><th scope="row">{tr('重力', 'Gravity')}</th><td>{gravity} m/s²</td><td>9.81 m/s²</td><td><span className="eva-chip never">{tr('無法類比', 'Cannot match')}</span></td></tr>
      </tbody></table>}
    <small>{isEarth || rows.length ? (stats.climateState === 'ready'
      ? tr('地球：NASA POWER 2001–2025 該點月氣候；當日天氣是依月平均推估的示意，不是預報。', 'Earth: NASA POWER 2001–2025 monthly climatology at this point; the day’s weather is an estimate from monthly means, not a forecast.')
      : stats.climateState === 'loading' ? tr('正在讀取 NASA POWER 氣候資料…', 'Loading NASA POWER climatology…') : tr('NASA POWER 暫時無法讀取，地球使用一般預設值。', 'NASA POWER is unavailable; Earth uses generic defaults.')) : ''}
      {' '}{target.body === 'mars' ? tr('火星：依季節 Ls 與緯度的物理近似（沙塵、溫度、氣壓），非即時觀測。', 'Mars: physical approximation from season Ls and latitude (dust, temperature, pressure), not live observation.')
        : tr('月球：依太陽高度估算的表面溫度（Diviner 觀測範圍約 −178～117 °C）。', 'Moon: surface temperature estimated from sun elevation (Diviner range about −178 to 117 °C).')}
      {' '}{tr('氣壓與重力在地球上無法重現，只能類比地形與部分環境。', 'Pressure and gravity cannot be reproduced on Earth; only terrain and some conditions can be analogous.')}</small>
  </section>
}
import './astronaut_explorer.css'

const BODY_NAME = { moon: ['月球', 'Moon'], mars: ['火星', 'Mars'], earth: ['地球', 'Earth'] }
const ACTION_KEYS = { KeyV: 'view', KeyL: 'lamp', KeyT: 'switch', KeyF: 'flag', KeyR: 'rocks', KeyG: 'speed', KeyP: 'photo', KeyC: 'scan', KeyM: 'rover', KeyB: 'board', Home: 'recenter' }
const fmt = (v, d = 0) => Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'
const coord = (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`
const clock = s => { const t = Math.floor(s); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }

function Compass({ bearing }) {
  const marks = []
  for (let d = -360; d <= 720; d += 15) {
    const n = ((d % 360) + 360) % 360
    const label = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[n]
    marks.push(<span key={d} className={label ? 'major' : ''} style={{ left: `${d * 3}px` }}>{label || ''}</span>)
  }
  return <div className="eva-compass" aria-hidden="true"><div className="eva-compass-strip" style={{ transform: `translateX(${-bearing * 3}px)` }}>{marks}</div><i /><b>{fmt(bearing)}°</b></div>
}

function Joystick({ engine }) {
  const base = useRef(null)
  const [knob, setKnob] = useState([0, 0])
  const id = useRef(null)
  const move = e => {
    const rect = base.current.getBoundingClientRect(), r = rect.width / 2
    let x = (e.clientX - rect.left - r) / r, y = (e.clientY - rect.top - r) / r
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m }
    setKnob([x, y]); engine.current?.setJoystick(x, -y)
  }
  const end = () => { id.current = null; setKnob([0, 0]); engine.current?.setJoystick(0, 0) }
  return <div className="eva-joystick" ref={base} aria-hidden="true"
    onPointerDown={e => { id.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); move(e) }}
    onPointerMove={e => { if (id.current === e.pointerId) move(e) }} onPointerUp={end} onPointerCancel={end}>
    <span style={{ transform: `translate(${knob[0] * 38}px, ${knob[1] * 38}px)` }} />
  </div>
}

export default function AstronautExplorer({ target, earth, initialWorld = 'target', onClose }) {
  const lang = useLanguage()
  const tr = (zh, en) => lang === 'en' ? en : zh
  const dialog = useRef(null), host = useRef(null), map = useRef(null), engine = useRef(null), toastTimer = useRef(0)
  const [stats, setStats] = useState(null)
  const [toast, setToast] = useState('')
  const [scan, setScan] = useState(null)
  const [help, setHelp] = useState(() => !window.__twMission)
  const [settings, setSettings] = useState(false)
  const [weatherOpen, setWeatherOpen] = useState(false)
  const [routeOpen, setRouteOpen] = useState(false)
  const [missionOpen, setMissionOpen] = useState(false)
  const [mission, setMission] = useState({})
  const [routePoints, setRoutePoints] = useState([])
  const [load, setLoad] = useState(30)
  const [cover, setCover] = useState('off')
  useEffect(() => { engine.current?.setCover(cover) }, [cover])
  // the minimap zooms to the astronaut's surroundings while planning
  useEffect(() => { engine.current?.setPlanning(routeOpen) }, [routeOpen])
  const [quality, setQualityState] = useState('auto')
  const [exaggeration, setExaggeration] = useState(1)
  const [error, setError] = useState('')
  const [mobile] = useState(() => matchMedia('(hover: none) and (pointer: coarse)').matches)
  const trRef = useRef(tr); trRef.current = tr
  useModalFocus(true, dialog, onClose)
  // The mission tutorial (mission_tutorial.jsx) follows what the astronaut does through these window events.
  const lastEmit = useRef(0)
  const emit = (type, detail = {}) => window.dispatchEvent(new CustomEvent('twinground:eva', { detail: { type, ...detail } }))
  useEffect(() => { emit('open'); return () => emit('close') }, [])
  const onEngineStats = s => {
    setStats(s)
    const now = performance.now()
    if (now - lastEmit.current > 120) { lastEmit.current = now; emit('stats', { stats: s }) }
  }
  useEffect(() => { renderGate.paused = true; return () => { renderGate.paused = false } }, [])

  const toastText = code => {
    const t = trRef.current, [kind, value] = code.split(':')
    const worldName = w => (w === 'earth' ? t('地球候選', 'Earth candidate') : t(`${BODY_NAME[target.body][0]}選區`, `${BODY_NAME[target.body][1]} selection`))
    return {
      boundary: t('已到資料窗格邊界：外側沒有 DEM 資料', 'Edge of the data window: no DEM beyond this line'),
      'view-first': t('第一人稱視角', 'First-person view'), 'view-third': t('第三人稱視角', 'Third-person view'),
      'lamp-on': t('頭燈開啟', 'Headlamp on'), 'lamp-off': t('頭燈關閉', 'Headlamp off'),
      'rocks-on': t('顯示示意岩塊', 'Illustrative rocks on'), 'rocks-off': t('隱藏示意岩塊：只剩 DEM 地形', 'Illustrative rocks hidden: DEM terrain only'),
      speed: t(`移動倍率 ${value}×${value === '1' ? '（真實步行速度）' : '（快速移動，不是真實步速）'}`, `Travel speed ${value}×${value === '1' ? ' (real walking pace)' : ' (fast travel, not a real pace)'}`),
      switch: t(`已切換到${worldName(value)}，保留相同的窗格內位置`, `Switched to the ${worldName(value)} at the same position in the window`),
      flag: t(`已插旗（${value}／20）`, `Flag planted (${value}/20)`), 'flag-limit': t('每個場景最多 20 面旗', 'Up to 20 flags per scene'),
      teleport: t('已移動到地圖上的位置', 'Moved to the map position'),
      photo: t('照片已下載', 'Photo saved'),
      board: t('已上車：W/S 前進後退，A/D 轉向，空白鍵煞車，B 下車', 'Aboard: W/S drive, A/D steer, Space brakes, B to get out'),
      exit: t('已下車', 'Out of the rover'), 'rover-far': t('離探測車太遠：走到 8 m 內再按 B，或按「叫車」', 'Too far from the rover: walk within 8 m and press B, or call it'),
      'rover-loading': t('探測車模型還在載入', 'The rover model is still loading'), summon: t('探測車已開到身邊', 'The rover is beside you'),
      'drive-steep': t('坡度太陡，探測車爬不上去', 'Too steep for the rover'), 'drive-slip': t('車輪打滑：這種土壤上爬不上這個坡', 'Wheels spinning: this soil cannot hold the climb'), 'drive-blocked': t('前方有大石或邊界', 'Boulder or boundary ahead'), 'drive-no-ground': t('前方沒有地形資料', 'No terrain data ahead'),
      rover: t('前往真實火星地面：好奇號在 Dingo Gap 拍攝重建的網格，位置在蓋爾撞擊坑，不是你選的區域', 'Real Mars ground: Curiosity stereo mesh of Dingo Gap in Gale crater, not your selected region'),
      'no-mesh': t('前方沒有實測網格：探測車相機沒有拍到這裡', 'No measured mesh ahead: the rover cameras did not see this area'),
      'route-done': t('已走完規劃路線', 'Reached the end of the route'), 'route-stop': t('已改為手動行走', 'Switched to manual walking'),
    }[kind] || code
  }
  const showToast = code => {
    setToast(toastText(code))
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }

  // Everything the scene needs is fetched in parallel before it is built (usually already prefetched by the results
  // page): both high-resolution DEMs, both surface images and the NASA models. Nothing is swapped under the user,
  // and the loading screen shows real byte and stage progress.
  const [assets, setAssets] = useState(null)
  const [fetching, setFetching] = useState({ data: 0, bytes: 0, total: 0 })
  const lateDetails = useRef({})
  useEffect(() => {
    let alive = true
    const abort = new AbortController()
    const got = { details: {}, images: {}, models: {} }, bytes = {}
    const within = (promise, ms) => Promise.race([promise, new Promise(resolve => window.setTimeout(resolve, ms))])
    const dataDone = () => { if (alive) setFetching(f => ({ ...f, data: f.data + 1 })) }
    const showBytes = () => {
      if (!alive) return
      let loaded = 0, total = 0
      for (const [l, t] of Object.values(bytes)) { loaded += l; total += t }
      setFetching(f => ({ ...f, bytes: loaded, total }))
    }
    const dem = (key, w) => within(fetchExploreDem(w).then(api => {
      const d = decodeDetail(api); got.details[key] = d
      if (d && engine.current) engine.current.setDetail(key, d); else if (d) lateDetails.current[key] = d
    }), 20000).catch(() => {}).finally(dataDone)
    const image = (key, w) => within(w.textureUrl ? loadImage(w.textureUrl).then(img => { got.images[key] = img }) : Promise.resolve(), 15000).catch(() => {}).finally(dataDone)
    const model = (name, spec) => {
      bytes[name] = [0, spec.bytes]
      return fetchBytes(spec.url, (l, t) => { bytes[name] = [l, t]; showBytes() }, abort.signal).then(b => { got.models[name] = b }).catch(() => {})
    }
    const propBody = (initialWorld === 'earth' ? earth : target).body
    const tasks = [dem('target', target), dem('earth', earth), image('target', target), image('earth', earth),
      model('suit', EXPLORER_MODELS.suit), model('rover', mobile ? EXPLORER_MODELS.roverMobile : EXPLORER_MODELS.roverDesktop)]
    if (EXPLORER_PROPS[propBody]) tasks.push(model('prop', EXPLORER_PROPS[propBody]))
    showBytes()
    within(Promise.allSettled(tasks), 60000).then(() => { if (alive) setAssets({ ...got, propBody }) })
    return () => { alive = false; abort.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!assets) return undefined
    let created, timer = 0
    // Let the loading screen paint its "building terrain" step before the synchronous scene build.
    const frameId = requestAnimationFrame(() => { timer = window.setTimeout(() => {
      try {
        created = createAstronautEngine({
          container: host.current, minimap: map.current, initial: initialWorld,
          worlds: { target: { ...target, detail: assets.details.target || null }, earth: { ...earth, detail: assets.details.earth || null } }, mobile,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          onStats: onEngineStats, onToast: showToast,
          assets: { models: assets.models, images: assets.images, propBody: assets.propBody },
        })
        engine.current = created
        for (const [k, d] of Object.entries(lateDetails.current)) created.setDetail(k, d)
      } catch (err) {
        setError(trRef.current('此裝置無法建立 3D 場景（WebGL 不可用）。', 'This device cannot create the 3D scene (WebGL unavailable).'))
      }
    }, 30) })
    return () => { cancelAnimationFrame(frameId); window.clearTimeout(timer); window.clearTimeout(toastTimer.current); created?.dispose(); engine.current = null }
    // The scene is created once per opening; candidate changes close the explorer first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets])

  // Loading progress: downloads (data + model bytes) to 70 %, scene build 72 %, model decoding to 80 %, shader and
  // texture warm-up to 97 %, first frames to 100 %. It never moves backwards.
  const progressFloor = useRef(0)
  const loadingView = (() => {
    const mb = v => (v / 1048576).toFixed(1)
    if (stats?.ready) return { value: 1, text: '' }
    if (!assets) {
      const value = 0.2 * fetching.data / 4 + 0.5 * (fetching.total ? fetching.bytes / fetching.total : 0)
      return { value, text: tr(`下載高解析地形、地表影像與 NASA 3D 模型 · ${mb(fetching.bytes)} / ${mb(fetching.total)} MB`, `Downloading terrain, surface imagery and NASA 3D models · ${mb(fetching.bytes)} / ${mb(fetching.total)} MB`) }
    }
    const L = stats?.loading
    if (!stats) return { value: 0.72, text: tr('建立地形網格', 'Building the terrain mesh') }
    if (!L || L.stage === 'models') {
      const n = (stats.suitSettled ? 1 : 0) + (stats.roverSettled ? 1 : 0) + (stats.propSettled ? 1 : 0)
      return { value: 0.72 + 0.08 * n / 3, text: tr('解碼太空人與月球車模型', 'Decoding the astronaut and rover models') }
    }
    if (L.stage === 'warmup') {
      const [pr, pt] = L.programs || [0, 1], [xr, xt] = L.textures || [0, 1]
      return { value: 0.8 + 0.17 * (pr + xr) / Math.max(1, pt + xt), text: tr(`準備著色器與貼圖 · ${pr + xr} / ${pt + xt}`, `Preparing shaders and textures · ${pr + xr} / ${pt + xt}`) }
    }
    return { value: 0.98, text: tr('繪製第一個畫面', 'Drawing the first frame') }
  })()
  progressFloor.current = Math.max(progressFloor.current, Math.min(1, loadingView.value))
  const percent = Math.round(progressFloor.current * 100)

  const runAction = name => {
    const result = engine.current?.action(name)
    emit('action', { name, ok: !!result || name === 'flag' })
    if (name === 'scan' && result) setScan(result)
    if (name === 'photo' && result) showToast('photo')
  }

  useEffect(() => {
    const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')
    const down = e => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
      if (engine.current?.key(e.code, true)) { e.preventDefault(); if (help && e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') setHelp(false); return }
      if (e.repeat) return
      if (ACTION_KEYS[e.code]) { e.preventDefault(); runAction(ACTION_KEYS[e.code]); return }
      if (e.code === 'KeyH') { e.preventDefault(); setHelp(v => !v) }
    }
    const up = e => { if (engine.current?.key(e.code, false)) e.preventDefault() }
    const blur = () => engine.current?.releaseKeys()
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  }, [help])

  const teleport = e => {
    const rect = e.currentTarget.getBoundingClientRect(), u = (e.clientX - rect.left) / rect.width, v = (e.clientY - rect.top) / rect.height
    // While planning, a click on the minimap adds a route point instead of travelling there.
    if (routeOpen && stats && stats.world !== 'rover') { const S = stats.sizeKm * 1000; const pt = engine.current?.mapToWorld(u, v) || [(u - 0.5) * S, (v - 0.5) * S]; setRoutePoints(p => p.length >= 40 ? p : [...p, pt]); return }
    engine.current?.teleport(u, v)
    emit('action', { name: 'teleport' })
  }
  const refocus = () => requestAnimationFrame(() => host.current?.focus({ preventScroll: true }))
  const updateQuality = mode => { setQualityState(mode); engine.current?.setQuality(mode); refocus() }
  const updateExaggeration = value => { setExaggeration(value); engine.current?.setExaggeration(value); refocus() }

  const isEarth = stats?.world === 'earth', isRover = stats?.world === 'rover'
  const worldLabel = stats ? (isRover ? tr('真實火星地面', 'Real Mars ground') : isEarth ? tr('地球候選', 'Earth candidate') : tr(`${BODY_NAME[target.body][0]}選區`, `${BODY_NAME[target.body][1]} selection`)) : ''
  const otherLabel = isEarth || isRover ? tr(`${BODY_NAME[target.body][0]}選區`, `${BODY_NAME[target.body][1]} selection`) : tr('地球候選', 'Earth candidate')
  const scanRows = scan && [
    [tr('高程（約）', 'Elevation (approx.)'), r => `${fmt(r.elevation)} m`],
    [tr('DEM 坡度', 'DEM slope'), r => `${fmt(r.slope, 1)}°`],
    [tr('1 km 內起伏', 'Relief within 1 km'), r => `${fmt(r.relief500)} m`],
    [tr('300 m 內高程標準差', 'Elevation SD within 300 m'), r => `${fmt(r.roughness300, 1)} m`],
    [tr('原生格距', 'Native grid spacing'), r => `${fmt(r.nativeCell)} m`],
    [tr('腳印深度（估算）', 'Bootprint depth (est.)'), r => r.bootCm != null ? `${fmt(r.bootCm, 1)} cm` : '—'],
    [tr('車輪下陷（估算）', 'Wheel sinkage (est.)'), r => r.wheelCm != null ? `${fmt(r.wheelCm, 1)} cm` : '—'],
  ]

  return createPortal(<div className={`eva ${stats?.view === 'first' ? 'is-first' : ''} ${mobile ? 'is-touch' : ''} eva-${stats?.body || target.body}`} ref={dialog} role="dialog" aria-modal="true" aria-label={tr('太空人地形探索', 'Astronaut terrain exploration')}>
    <div className={`eva-canvas ${stats?.ready ? '' : 'is-hidden'}`} ref={host} tabIndex={0} role="application" aria-label={tr('3D 探索場景。用 WASD 或方向鍵移動，空白鍵跳躍，按 H 看操作說明。', '3D exploration scene. Move with WASD or arrow keys, Space to jump, H for controls.')} />
    {stats?.view === 'first' && <div className="eva-visor" aria-hidden="true" />}
    {!stats?.ready && !error && <div className="eva-loading">
      <div className="eva-loading-card">
        <strong>{tr('正在準備探索場景', 'Preparing the exploration scene')}</strong>
        <span className="eva-loading-place">{target.label}</span>
        <div className="eva-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}% · ${loadingView.text}`} aria-label={tr('探索場景載入進度', 'Exploration scene loading progress')}>
          <span style={{ transform: `scaleX(${progressFloor.current})` }} />
        </div>
        <div className="eva-progress-meta" aria-hidden="true"><span>{loadingView.text}</span><b>{percent}%</b></div>
      </div>
    </div>}
    {stats?.loading && <div className="eva-tiles-loading" role="status">{tr('正在從 NASA-AMMOS 載入 Dingo Gap 實測網格…', 'Loading the Dingo Gap mesh from NASA-AMMOS…')}</div>}
    {error && <div className="eva-error" role="alert"><p>{error}</p><button type="button" onClick={onClose}>{tr('返回地形比較', 'Back to comparison')}</button></div>}

    <header className="eva-top">
      <div className="eva-lead">
      <button type="button" className="eva-back" onClick={onClose} aria-label={tr('離開 3D', 'Exit 3D')}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>{tr('離開', 'Exit')}
      </button>
      <div className="eva-place">
        <span className={`eva-badge ${isEarth ? 'earth' : target.body}`}>{worldLabel}</span>
        <strong>{isRover ? tr('Dingo Gap · 蓋爾撞擊坑（好奇號第 528 火星日）', 'Dingo Gap · Gale crater (Curiosity sol 528)') : isEarth ? earth.label : target.label}</strong>
        {stats && !isRover && <small>{coord(stats.lat, stats.lon)}</small>}
        {isRover && <small>{tr('實測立體影像網格 · 不是你選的區域', 'Measured stereo mesh · not your selected region')}</small>}
      </div>
      </div>
      {stats && <Compass bearing={stats.look} />}
      <div className="eva-tools" role="toolbar" aria-label={tr('探索工具', 'Exploration tools')}>
        <button type="button" className="eva-switch" onClick={() => runAction(isRover ? 'rover' : 'switch')} title={tr('切換世界（T）', 'Switch world (T)')}>{tr('切換到', 'Go to')} {otherLabel}</button>
        {stats?.hasRover && !isRover && <button type="button" className="eva-rover" onClick={() => runAction('rover')} title={tr('好奇號 Dingo Gap 實測網格（M）', 'Curiosity Dingo Gap mesh (M)')}>{tr('真實火星地面', 'Real Mars ground')}</button>}
        <button type="button" aria-pressed={stats?.view === 'first'} onClick={() => runAction('view')} title={tr('切換視角（V）', 'Toggle view (V)')}>{stats?.view === 'first' ? tr('第一人稱', '1st person') : tr('第三人稱', '3rd person')}</button>
        <button type="button" aria-pressed={!!stats?.lamp} onClick={() => runAction('lamp')} title={tr('頭燈（L）', 'Headlamp (L)')}>{tr('頭燈', 'Lamp')}</button>
        {!isRover && <button type="button" className="eva-route-toggle" aria-expanded={routeOpen} onClick={() => { setRouteOpen(v => !v); setWeatherOpen(false); setSettings(false); setMissionOpen(false) }}>{tr('路線規劃', 'Route')}</button>}
        {!isRover && <button type="button" className="eva-mission-toggle" aria-expanded={missionOpen} onClick={() => { setMissionOpen(v => !v); setRouteOpen(false); setWeatherOpen(false); setSettings(false) }}>{tr('任務', 'Mission')}</button>}
        <button type="button" aria-expanded={weatherOpen} onClick={() => { setWeatherOpen(v => !v); setRouteOpen(false); setSettings(false); setMissionOpen(false) }}>{tr('時間天氣', 'Time & weather')}</button>
        <button type="button" aria-expanded={settings} onClick={() => { setSettings(v => !v); setRouteOpen(false); setWeatherOpen(false); setMissionOpen(false) }}>{tr('設定', 'Settings')}</button>
        <button type="button" onClick={() => runAction('photo')} title={tr('拍照下載 PNG（P）', 'Save a PNG photo (P)')}>{tr('拍照', 'Photo')}</button>
        <button type="button" aria-expanded={help} onClick={() => setHelp(v => !v)} title={tr('操作說明（H）', 'Controls (H)')}>?</button>
        <button type="button" className="eva-close" onClick={onClose} aria-label={tr('離開探索（Esc）', 'Exit exploration (Esc)')}>✕</button>
      </div>
    </header>

    {stats && <section className="eva-telemetry" aria-label={tr('即時讀數', 'Live readout')}>
      {stats.driving && stats.vehicle ? <dl>
        <div><dt>{tr('車速', 'Speed')}</dt><dd>{fmt(Math.abs(stats.vehicle.speed) * 3.6, 1)} km/h{stats.speedMult > 1 ? ` · ${stats.speedMult}×` : ''}</dd></div>
        <div><dt>{tr('高程', 'Elevation')}</dt><dd>{fmt(stats.elevation)} m</dd></div>
        <div><dt>{tr('俯仰', 'Pitch')}</dt><dd>{fmt(stats.vehicle.pitch, 1)}°</dd></div>
        <div><dt>{tr('側傾', 'Roll')}</dt><dd>{fmt(stats.vehicle.roll, 1)}°</dd></div>
        <div><dt>{tr('行駛距離', 'Driven')}</dt><dd>{stats.distance >= 1000 ? `${fmt(stats.distance / 1000, 2)} km` : `${fmt(stats.distance)} m`}</dd></div>
        <div><dt>{tr('距起點', 'From start')}</dt><dd>{stats.fromStart >= 1000 ? `${fmt(stats.fromStart / 1000, 2)} km` : `${fmt(stats.fromStart)} m`}</dd></div>
        {stats.vehicle.batteryPct != null && <div><dt>{tr('車用電池', 'Rover battery')}</dt><dd>{fmt(stats.vehicle.batteryPct, 1)}%</dd></div>}
        {stats.vehicle.powerW != null && <div><dt>{tr('驅動功率', 'Drive power')}</dt><dd>{fmt(stats.vehicle.powerW / 1000, 1)} kW</dd></div>}
        {stats.vehicle.slip != null && <div><dt>{tr('打滑', 'Wheel slip')}</dt><dd>{fmt(stats.vehicle.slip * 100)}%</dd></div>}
        {stats.vehicle.limitDeg != null && <div><dt>{tr('爬坡極限', 'Climb limit')}</dt><dd>{fmt(stats.vehicle.limitDeg)}°{stats.vehicle.whPerKm ? ` · ${fmt(stats.vehicle.whPerKm)} Wh/km` : ''}</dd></div>}
      </dl> : <dl>
        <div><dt>{tr('高程', 'Elevation')}</dt><dd>{fmt(stats.elevation)} m</dd></div>
        <div><dt>{tr('坡度', 'Slope')}</dt><dd>{fmt(stats.slope, 1)}°</dd></div>
        <div><dt>{tr('速度', 'Speed')}</dt><dd>{fmt(stats.speed, 1)} m/s{stats.speedMult > 1 ? ` · ${stats.speedMult}×` : ''}</dd></div>
        <div><dt>{tr('行走距離', 'Walked')}</dt><dd>{stats.distance >= 1000 ? `${fmt(stats.distance / 1000, 2)} km` : `${fmt(stats.distance)} m`}</dd></div>
        <div><dt>{tr('距起點', 'From start')}</dt><dd>{stats.fromStart >= 1000 ? `${fmt(stats.fromStart / 1000, 2)} km` : `${fmt(stats.fromStart)} m`}</dd></div>
        <div><dt>{tr('重力', 'Gravity')}</dt><dd>{fmt(stats.gravity, 2)} m/s²</dd></div>
        <div><dt>{tr('原地跳高', 'Jump height')}</dt><dd>{fmt(stats.jumpHeight, 2)} m</dd></div>
        {!stats.grounded && <div><dt>{tr('離地', 'Airborne')}</dt><dd>{fmt(stats.altitude, 2)} m</dd></div>}
      </dl>}
      {stats.weather && <p className="eva-wx-line">{hhmm(stats.time.hour)} · {tr(KIND[stats.weather.kind]?.[0] || '', KIND[stats.weather.kind]?.[1] || '')} · {Math.round(stats.weather.temperature)}°C{stats.sunVisHere < 0.5 && stats.sunElevation > 0 ? tr(' · 地形陰影中', ' · in terrain shadow') : ''}</p>}
      <div className="eva-suit">
        <span>{tr('生命維持（模擬）', 'Life support (simulated)')}</span>
        {stats.life ? <LifeSupport stats={stats} tr={tr} clock={clock} /> : <><div className="eva-bar"><i style={{ width: `${stats.o2}%` }} /></div>
        <small>O₂ {fmt(stats.o2, 1)}% · EVA {clock(stats.elapsed)}</small></>}
      </div>
      <CommLine stats={stats} tr={tr} />
    </section>}

    <aside className="eva-map">
      {!isRover && stats && <button type="button" className="eva-cover-toggle" aria-pressed={cover !== 'off'}
        onClick={() => setCover(c => c === 'off' ? 'base' : c === 'base' && stats.body === 'moon' ? 'earth' : 'off')}>
        {cover === 'base' ? tr('無線電（紅＝收不到）', 'Radio (red = no signal)') : cover === 'earth' ? (stats.body === 'moon' ? tr('地球直視（藍＝被擋）', 'Earth view (blue = hidden)') : tr('地球直視只適用月球', 'Earth view: Moon only')) : tr('通訊覆蓋', 'Comms coverage')}</button>}
      <canvas ref={map} width={256} height={256} onClick={teleport} aria-label={tr('窗格小地圖：點選即可移動到該處', 'Window minimap: click to move there')} />
      <span>{routeOpen && !isRover ? tr('點地圖加入路線點', 'Click to add a route point') : tr('北在上 · 點地圖可快速移動', 'North up · click to travel')}{stats ? ` · ${(stats.mapKm || stats.sizeKm) < 1 ? `${fmt((stats.mapKm || stats.sizeKm) * 1000)} m` : `${fmt(stats.mapKm || stats.sizeKm)} km`}` : ''}</span>
    </aside>

    <div className="eva-actions" role="group" aria-label={tr('動作', 'Actions')}>
      <button type="button" className={stats?.vehicleNear ? 'eva-attention' : ''} aria-pressed={!!stats?.driving} onClick={() => runAction('board')}>{stats?.driving ? tr('下車', 'Get out') : tr('上車', 'Board')}<kbd>B</kbd></button>
      {!stats?.driving && stats?.vehicleReady && !stats?.vehicleNear && <button type="button" onClick={() => runAction('summon')}>{tr('叫車', 'Call rover')}</button>}
      <button type="button" onClick={() => engine.current?.action('jump')}>{stats?.driving ? tr('煞車', 'Brake') : tr('跳躍', 'Jump')}<kbd>Space</kbd></button>
      {!stats?.driving && <button type="button" aria-pressed={!!stats?.run} onClick={() => runAction('run')}>{tr('奔跑', 'Run')}<kbd>Shift</kbd></button>}
      <button type="button" onClick={() => runAction('scan')}>{tr('地形掃描', 'Scan')}<kbd>C</kbd></button>
      <button type="button" onClick={() => runAction('flag')}>{tr('插旗', 'Flag')}<kbd>F</kbd></button>
      <button type="button" onClick={() => runAction('speed')}>{stats?.speedMult || 1}×<kbd>G</kbd></button>
    </div>
    {mobile && <Joystick engine={engine} />}

    {toast && <div className="eva-toast" role="status">{toast}</div>}

    {scan?.unsupported && <section className="eva-scan" aria-label={tr('地形掃描結果', 'Terrain scan')}>
      <header><strong>{tr('地形掃描', 'Terrain scan')}</strong><button type="button" onClick={() => setScan(null)} aria-label={tr('關閉掃描結果', 'Close scan')}>✕</button></header>
      <p>{tr('這裡是好奇號的實測網格，沒有窗格 DEM 可以和地球候選逐點對照。回到火星選區後即可掃描。', 'This is the Curiosity mesh; there is no window DEM to compare point by point with the Earth candidate. Return to the Mars selection to scan.')}</p>
    </section>}
    {scan && !scan.unsupported && <section className="eva-scan" aria-label={tr('地形掃描結果', 'Terrain scan')}>
      <header><strong>{tr('地形掃描', 'Terrain scan')}</strong><button type="button" onClick={() => setScan(null)} aria-label={tr('關閉掃描結果', 'Close scan')}>✕</button></header>
      <p>{tr('同一個窗格內位置，兩邊的 DEM 讀數：', 'DEM readings at the same position in both windows:')} {tr('東', 'E')} {fmt(Math.round(scan.x) || 0)} m · {tr('北', 'N')} {fmt(Math.round(-scan.z) || 0)} m</p>
      <table><thead><tr><th scope="col" /><th scope="col">{scan.active === 'earth' ? tr('地球候選', 'Earth') : tr(`${BODY_NAME[target.body][0]}選區`, BODY_NAME[target.body][1])}</th><th scope="col">{scan.active === 'earth' ? tr(`${BODY_NAME[target.body][0]}選區`, BODY_NAME[target.body][1]) : tr('地球候選', 'Earth')}</th></tr></thead>
        <tbody>{scanRows.map(([label, get]) => <tr key={label}><th scope="row">{label}</th><td>{get(scan.here)}</td><td>{get(scan.other)}</td></tr>)}</tbody></table>
      <small>{tr('數值只來自窗格 DEM；小於原生格距的起伏無法得知，示意岩塊不列入。', 'Values come only from the window DEM. Relief finer than the native grid is unknown; illustrative rocks are not counted.')}</small>
    </section>}

    {missionOpen && !isRover && stats && <MissionPanel engine={engine} stats={stats} target={target} earth={earth} tr={tr} mission={mission} setMission={setMission} onClose={() => setMissionOpen(false)} />}
    {routeOpen && !isRover && stats && <RoutePanel engine={engine} stats={stats} target={target} tr={tr} points={routePoints} setPoints={setRoutePoints} load={load} setLoad={setLoad} onClose={() => setRouteOpen(false)} />}
    {weatherOpen && stats?.weather && <WeatherPanel stats={stats} target={target} tr={tr} engine={engine} onClose={() => setWeatherOpen(false)} />}

    {settings && <section className="eva-settings" aria-label={tr('場景設定', 'Scene settings')}>
      <label>{tr('畫質', 'Quality')} <output>{stats ? `${Math.round(stats.fps)} fps · ${Math.round(stats.resScale * 100)}%` : ''}</output><select value={quality} onChange={e => updateQuality(e.target.value)}><option value="auto">{tr('自動（依流暢度調整）', 'Auto (adapts to frame rate)')}</option><option value="high">{tr('高', 'High')}</option><option value="low">{tr('低（較順）', 'Low (smoother)')}</option></select></label>
      {!isRover && <label>{tr('垂直比例', 'Vertical scale')}<select value={exaggeration} onChange={e => updateExaggeration(Number(e.target.value))}>{[1, 2, 3, 5].map(v => <option key={v} value={v}>{v}×{v === 1 ? tr('（真實）', ' (true)') : tr('（誇大）', ' (exaggerated)')}</option>)}</select></label>}
      {!isRover && <label className="eva-check"><input type="checkbox" checked={stats?.rocks ?? true} onChange={() => { runAction('rocks'); refocus() }} />{tr('顯示示意岩塊', 'Show illustrative rocks')}</label>}
      <button type="button" onClick={() => runAction('recenter')}>{tr('回到窗格中心', 'Return to window centre')}</button>
      <small>{tr('太陽位置依「時間天氣」的日期與當地時間計算；地形陰影由 DEM 地平線推算。', 'The sun follows the date and local time in Time & weather; terrain shadows come from the DEM horizon.')}</small>
    </section>}

    {help && <section className="eva-help" aria-label={tr('操作說明', 'Controls')}>
      <h2>{tr('太空人探索', 'Astronaut exploration')}</h2>
      <p>{tr('地形是這個窗格的實測 DEM，按真實水平尺度與各星球重力模擬步行。', 'The ground is this window’s measured DEM at true horizontal scale, walked under each body’s gravity.')}</p>
      <ul>
        <li><kbd>W A S D</kbd> / <kbd>↑ ↓ ← →</kbd> {tr('移動', 'Move')}</li>
        <li><kbd>Shift</kbd> {tr('奔跑（月球、火星為低重力跳步）', 'Run (low-gravity lope on Moon and Mars)')}</li>
        <li><kbd>Space</kbd> {tr('跳躍', 'Jump')}</li>
        <li>{tr('拖曳畫面', 'Drag')} / <kbd>Q</kbd> <kbd>E</kbd> {tr('轉動視角；滾輪或', 'Turn camera; wheel or')} <kbd>+</kbd> <kbd>−</kbd> {tr('縮放', 'zoom')}</li>
        <li><kbd>V</kbd> {tr('第一／第三人稱', '1st / 3rd person')} · <kbd>L</kbd> {tr('頭燈', 'Lamp')} · <kbd>T</kbd> {tr('切換火星或月球／地球', 'Switch target / Earth')}</li>
        <li><kbd>C</kbd> {tr('地形掃描', 'Scan')} · <kbd>F</kbd> {tr('插旗', 'Flag')} · <kbd>G</kbd> {tr('移動倍率', 'Speed')} · <kbd>P</kbd> {tr('拍照', 'Photo')} · <kbd>R</kbd> {tr('示意岩塊', 'Rocks')}</li>
        {target.body === 'mars' && <li><kbd>M</kbd> {tr('真實火星地面（好奇號 Dingo Gap 實測網格）', 'Real Mars ground (Curiosity Dingo Gap mesh)')}</li>}
        <li><kbd>B</kbd> {tr('上下月球車，開車時 W/S 前後、A/D 轉向、空白鍵煞車', 'Board or leave the rover; W/S drive, A/D steer, Space brakes')}</li>
        <li>{tr('「路線規劃」：在小地圖點出路線，同一條路線在兩地同時估算體力、時間與坡度，也能讓太空人沿路線走', '“Route”: click a route on the minimap; the same route is estimated on both sites (energy, time, slope), and the astronaut can walk it')}</li>
        <li>{tr('生命維持：O₂、冷卻水與電池隨活動與日照／陰影變化，剩餘量不夠走回時會警告；小地圖「通訊覆蓋」顯示基地無線電與地球直視範圍', 'Life support: O₂, cooling water and battery follow activity and sun or shade, with a warning when they may not cover the walk back; “Comms coverage” on the minimap shows radio and Earth line of sight')}</li>
        <li>{tr('「任務」：野外科學任務（採樣站、地震儀、坑壁照片）、基地選址檢查與現地資源估算；路線規劃可選「開車到某點再步行」', '“Mission”: a field-science task set (stations, seismometer, crater-wall photo), base-site checks and resource estimates; the route planner can drive part of the way')}</li>
        <li><kbd>Esc</kbd> {tr('離開', 'Exit')}</li>
      </ul>
      {stats && !isRover && <p className="eva-help-credits">
        {stats.textureState === 'ready' && stats.textureCredit && <span>{tr('地表影像', 'Surface imagery')}：{stats.textureCredit}</span>}
        {stats.prop && <span>{tr(`NASA 3D Resources ${stats.prop} 模型為比例參考的示意擺放`, `NASA 3D Resources ${stats.prop} model placed for scale only`)}</span>}
        {stats.earthInSky && <span>{tr(`天空中的地球依月面經緯度估算（仰角約 ${fmt(stats.earthElevation)}°，未計天平動）`, `Earth in the sky is placed from the site's selenographic position (elevation ≈ ${fmt(stats.earthElevation)}°, libration ignored)`)}</span>}
        {stats.suitModel && <span>{tr('太空人：NASA Z-2 太空衣（NASA 3D Resources，NASA/LaRC 先進概念實驗室，關節為執行時加入的示意骨架）；登月艙：NASA Apollo Lunar Module（NASA 3D Resources）', 'Astronaut: NASA Z-2 spacesuit (NASA 3D Resources, NASA/LaRC Advanced Concepts Lab; joints are an illustrative rig added at runtime); lunar module: NASA Apollo Lunar Module (NASA 3D Resources)')}</span>}
        <span>{tr('不代表實際可通行或任務安全', 'Not an assessment of trafficability or mission safety')}</span>
      </p>}
      <button type="button" className="eva-start" onClick={() => { setHelp(false); host.current?.focus() }}>{tr('開始探索', 'Start exploring')}</button>
    </section>}

    {stats && isRover && <footer className="eva-note">
      {tr('地形：NASA/JPL-Caltech 好奇號立體影像網格（NASA-AMMOS 3DTilesSampleData，執行時讀取、未轉散布）· 位置在蓋爾撞擊坑 Dingo Gap，不是你選的區域 · 網格外與相機死角沒有資料',
        'Terrain: NASA/JPL-Caltech Curiosity stereo mesh (NASA-AMMOS 3DTilesSampleData, streamed at runtime, not redistributed) · Dingo Gap in Gale crater, not your selected region · no data outside the mesh or in camera blind spots')}
      {stats.suitModel && <span> · {tr('太空人：NASA Z-2 太空衣（NASA 3D Resources，NASA/LaRC 先進概念實驗室，關節為執行時加入的示意骨架）；登月艙：NASA Apollo Lunar Module（NASA 3D Resources）', 'Astronaut: NASA Z-2 spacesuit (NASA 3D Resources, NASA/LaRC Advanced Concepts Lab; joints are an illustrative rig added at runtime); lunar module: NASA Apollo Lunar Module (NASA 3D Resources)')}</span>}
    </footer>}
    {stats && !isRover && <footer className="eva-note">
      {tr(`DEM 原生格距約 ${fmt(stats.nativeCell)} m · 垂直比例 ${stats.exaggeration}× · 地平線約 ${fmt(stats.horizonKm, 1)} km · 周圍的小坑、岩塊、腳印與塵土為示意，不是量測資料`,
        `DEM native spacing ≈ ${fmt(stats.nativeCell)} m · vertical scale ${stats.exaggeration}× · horizon ≈ ${fmt(stats.horizonKm, 1)} km · small craters, rocks, footprints and dust nearby are illustrative, not measured`)}
    </footer>}
  </div>, document.body)
}
