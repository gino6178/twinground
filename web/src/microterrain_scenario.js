import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
// i18n v2: display-string helpers from /i18n/static-i18n.js (identity fallback keeps the Chinese page working without it)
var __t = (typeof window !== 'undefined' && window.__t) || (s => s), __m = (typeof window !== 'undefined' && window.__m) || ((p, ...v) => p.map((x, i) => x + (i < v.length ? String(v[i]) : '')).join(''))

const $ = id => document.getElementById(id)
const params = new URLSearchParams(location.search)
const returnParams = new URLSearchParams(params)
returnParams.set('autosearch', '1')
$('back-to-results').href = `/microterrain/?${returnParams}`
const source = {
  site: params.get('site') || 'MARIUS3',
  size_m: params.get('size_m') || '500',
  east_m: params.get('east_m') || '0',
  north_m: params.get('north_m') || '0',
  mode: 'native', ranker: params.get('ranker') || 'geomorphon',
  comparison: params.get('comparison') || 'shape', include_3d: '1',
  evidence_filter: params.get('evidence_filter') || 'off',
}
const selected = Math.max(0, Math.min(4, Number(params.get('match') || 0)))
const assetInfo = {
  apollo_lunar_module: { path: '/assets/nasa3d/apollo_lunar_module.glb', width: 9.4, page: 'https://science.nasa.gov/3d-resources/apollo-lunar-module/', dimension: __t('NASA PDS Apollo LM 著陸腳跨度約 9.4 m') },
  perseverance_rover: { path: '/assets/nasa3d/perseverance_rover.glb', width: 3, page: 'https://science.nasa.gov/3d-resources/mars-2020-perseverance-rover/', dimension: __t('NASA/JPL Perseverance 長約 3 m') },
  habitat_demo_part1: { path: '/assets/nasa3d/habitat_demo_part1.glb', width: 5, page: 'https://science.nasa.gov/3d-resources/habitat-demonstration-unit/', dimension: __t('HDU 依 NASA 設計概念約 5 m 尺度；此單一 GLB 為 part 1') },
}
const viewer = $('viewer')
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8))
renderer.outputColorSpace = THREE.SRGBColorSpace
viewer.prepend(renderer.domElement)
const scene = new THREE.Scene()
scene.add(new THREE.HemisphereLight(0xd6ebee, 0x374246, 2.1))
const sun = new THREE.DirectionalLight(0xffe9c2, 2.4)
sun.position.set(-1, 3, 2); scene.add(sun)
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 20000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.enablePan = true
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE
controls.mouseButtons.RIGHT = THREE.MOUSE.PAN
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let data, match, side, meshes = [], placed = null, model = null, modelToken = 0, placement = null, residualScaleM = 1, earthPhoto = null, referencePhoto = null
const draco = new DRACOLoader()
draco.setDecoderPath('/assets/draco/')
const loader = new GLTFLoader()
loader.setDRACOLoader(draco)
const modelCache = new Map()

function resize() {
  const width = viewer.clientWidth, height = viewer.clientHeight
  camera.aspect = width / height; camera.updateProjectionMatrix()
  renderer.setSize(width, height)
}
new ResizeObserver(resize).observe(viewer)
function frame() { requestAnimationFrame(frame); controls.update(); renderer.render(scene, camera) }
frame()

function terrainMesh(grid, xCenter, color, label, appearance = 'solid') {
  const n = grid.length
  const geometry = new THREE.PlaneGeometry(side, side, n - 1, n - 1)
  const vertices = geometry.attributes.position
  const exaggeration = Number($('exaggeration').value)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    vertices.setZ(r * n + c, Number(grid[r][c]) * exaggeration)
  }
  if (appearance === 'residual') {
    const colors = new Float32Array(n * n * 3)
    const low = new THREE.Color(0x4ec2df), mid = new THREE.Color(0xbac5c1), high = new THREE.Color(0xe9a46e)
    const pixel = new THREE.Color()
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const delta = Number(match.earth_aligned_height_m[r][c]) - Number(data.reference_height_m[r][c])
      const magnitude = Math.min(Math.abs(delta) / residualScaleM, 1)
      pixel.copy(mid).lerp(delta < 0 ? low : high, magnitude)
      const i = (r * n + c) * 3
      colors[i] = pixel.r; colors[i + 1] = pixel.g; colors[i + 2] = pixel.b
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }
  geometry.rotateX(-Math.PI / 2)
  geometry.computeVertexNormals()
  const material = appearance === 'wire' ?
    new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: .67, depthWrite: false, depthTest: false, side: THREE.DoubleSide }) :
    new THREE.MeshStandardMaterial({ color: appearance === 'solid' && ((label === 'earth' && earthPhoto) || (label !== 'earth' && referencePhoto)) ? 0xffffff : color,
      map: appearance === 'solid' ? (label === 'earth' ? earthPhoto : referencePhoto) : null,
      vertexColors: appearance === 'residual', roughness: 0.95, metalness: 0,
      side: THREE.DoubleSide, flatShading: n < 20 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.x = xCenter
  if (appearance === 'wire') mesh.renderOrder = 2
  mesh.userData = { label, grid }
  scene.add(mesh)
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(side, .05, side)), new THREE.LineBasicMaterial({ color: 0x8facaa, transparent: true, opacity: .45 }))
  edge.position.x = xCenter; edge.position.y = -2
  scene.add(edge); mesh.userData.edge = edge
  return mesh
}
function rebuildTerrain() {
  if (!data) return
  for (const mesh of meshes) {
    scene.remove(mesh, mesh.userData.edge)
    mesh.geometry.dispose(); mesh.material.dispose()
    mesh.userData.edge.geometry.dispose(); mesh.userData.edge.material.dispose()
  }
  const view = $('compare-view').value
  const referenceColor = data.body === 'mars' ? 0xa66f58 : 0x8ba5ad
  if (view === 'side') {
    meshes = [terrainMesh(data.reference_height_m, -side * .59, referenceColor, data.body),
              terrainMesh(match.earth_aligned_height_m, side * .59, 0xb29c79, 'earth')]
    $('compare-legend').textContent = __m`並排：兩側使用相同水平公尺尺度與垂直倍率；高程各自以中位值為零。${referencePhoto ? data.body === 'moon' ? __t('月球表面為 LROC NAC 灰階正射影像。') : source.site === 'JEZERO_HIRISE_023524' ? __t('火星表面為 HiRISE 灰階正射影像。') : __t('火星表面為 USGS CTX 灰階正射影像。') : __t('月／火表面為 DEM 純色。')}${earthPhoto ? __m`地球表面為 ${match.earth_orthophoto.year} USGS NAIP RGB 航照。` : __t('地球表面為 DEM 純色。')}影像僅表示外觀，不是材質分類或 Skyfall-GS 合成。`
  } else if (view === 'overlay') {
    meshes = [terrainMesh(data.reference_height_m, 0, referenceColor, data.body),
              terrainMesh(match.earth_aligned_height_m, 0, 0xfbc27d, 'earth', 'wire')]
    $('compare-legend').textContent = __t('疊合：實色為月／火 DEM，琥珀線框為已旋轉／鏡像的地球 DEM；兩者以同一公尺尺度重疊，交叉處可看出起伏差異。點擊放置資產時選月／火表面。')
  } else {
    if (placement?.body === 'earth') {
      placement = null; modelToken++; if (model) scene.remove(model); model = null
    }
    meshes = [terrainMesh(data.reference_height_m, 0, 0xffffff, data.body, 'residual')]
    $('compare-legend').textContent = __m`逐格相對高差：地球減月／火，兩側先各自扣中位高度。青色較低、橘色較高、灰色接近；顏色在 ±${residualScaleM.toFixed(2)} m 截斷。這不是同一地點的高程測量誤差或地質差異圖。`
  }
  if (placement) {
    const mesh = meshes.find(m => m.userData.label === placement.body)
    const local = placement.local
    const hitY = sampleHeight(mesh.userData.grid, local.x, local.z) * Number($('exaggeration').value)
    placement.point.set(mesh.position.x + local.x, hitY, local.z)
    if (model) model.position.copy(placement.point)
  }
}
function sampleHeight(grid, x, z) {
  const n = grid.length
  const c = Math.max(0, Math.min(n - 1, (x / side + .5) * (n - 1)))
  const r = Math.max(0, Math.min(n - 1, (z / side + .5) * (n - 1)))
  const x0 = Math.floor(c), y0 = Math.floor(r), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1)
  const tx = c - x0, ty = r - y0
  return (1 - ty) * ((1 - tx) * grid[y0][x0] + tx * grid[y0][x1]) + ty * ((1 - tx) * grid[y1][x0] + tx * grid[y1][x1])
}
function slopeAt(grid, x, z) {
  const step = side / Math.max(grid.length - 1, 1)
  const east = (sampleHeight(grid, x + step, z) - sampleHeight(grid, x - step, z)) / (2 * step)
  const north = (sampleHeight(grid, x, z + step) - sampleHeight(grid, x, z - step)) / (2 * step)
  return Math.atan(Math.hypot(east, north)) * 180 / Math.PI
}
function fit() {
  const distance = side * ($('compare-view').value === 'side' ? 2.15 : 1.35)
  camera.position.set(distance * .62, distance * .62, distance)
  controls.target.set(0, 0, 0); controls.minDistance = 1; controls.maxDistance = side * 10
  controls.update()
}
function focus() {
  if (!placement) return
  const width = assetInfo[$('asset').value].width
  controls.target.copy(placement.point)
  camera.position.copy(placement.point).add(new THREE.Vector3(width * 4, width * 3, width * 4))
  controls.update()
}
async function getModel(key) {
  if (modelCache.has(key)) return modelCache.get(key).clone(true)
  const object = await loader.loadAsync(assetInfo[key].path)
  modelCache.set(key, object.scene)
  return object.scene.clone(true)
}
async function updateModel() {
  const token = ++modelToken
  if (model) { scene.remove(model); model = null }
  if (!placement) return
  const key = $('asset').value, info = assetInfo[key]
  $('status').textContent = __m`載入 NASA 3D 資產：${key}…`
  try {
    const object = await getModel(key)
    if (token !== modelToken) return
    const box = new THREE.Box3().setFromObject(object)
    const dimensions = new THREE.Vector3(); box.getSize(dimensions)
    const horizontal = Math.max(dimensions.x, dimensions.z)
    if (!Number.isFinite(horizontal) || horizontal <= 0) throw Error(__t('模型幾何無法量測'))
    const scale = info.width / horizontal
    object.scale.setScalar(scale)
    const fitted = new THREE.Box3().setFromObject(object)
    const center = new THREE.Vector3(); fitted.getCenter(center)
    object.position.set(-center.x, -fitted.min.y, -center.z)
    model = new THREE.Group(); model.add(object)
    model.position.copy(placement.point)
    scene.add(model)
    $('status').textContent = __m`${placement.body === 'earth' ? __t('地球') : placement.body === 'mars' ? __t('火星') : __t('月球')}窗格已放置資產 · 局部 DEM 坡度約 ${placement.slope.toFixed(1)}°（3D 預覽約 ${(side / Math.max(data.reference_height_m.length - 1, 1)).toFixed(1)} m／格估算） · ${info.dimension}。此數值不能判斷著陸安全。`
    $('asset-credit').innerHTML = __m`資產：<a href="${info.page}" target="_blank" rel="noreferrer">NASA 3D Resources 原始頁 ↗</a>。${info.dimension}；GLB 幾何按這個公開尺度調整，僅供佈局概念。地形垂直倍率為 ${$('exaggeration').value}×；模型不隨垂直倍率變形。NASA 模型不是基地工程認證。`
  } catch (error) { $('status').textContent = __m`NASA 模型暫無法載入：${error.message}` }
}
let pointerDown = null
renderer.domElement.addEventListener('pointerdown', event => { pointerDown = [event.clientX, event.clientY] })
renderer.domElement.addEventListener('pointerup', event => {
  if (!data || !pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 8) return
  pointerDown = null
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects($('compare-view').value === 'side' ? meshes : meshes.slice(0, 1))[0]
  if (!hit) return
  const grid = hit.object.userData.grid
  const local = { x: hit.point.x - hit.object.position.x, z: hit.point.z }
  placement = { body: hit.object.userData.label, local, point: hit.point.clone(), slope: slopeAt(grid, local.x, local.z) }
  updateModel()
})
$('asset').addEventListener('change', updateModel)
$('exaggeration').addEventListener('change', () => { rebuildTerrain(); updateModel() })
$('compare-view').addEventListener('change', () => {
  rebuildTerrain(); fit()
  $('status').textContent = $('compare-view').value === 'side' ?
    __t('並排同尺度；點選月／火或地球表面放置 NASA 資產。') :
    __t('同位置比對；點選月／火表面放置 NASA 資產。切回並排可在地球表面放置。')
})
$('fit').addEventListener('click', fit)
$('focus').addEventListener('click', focus)
$('reset-placement').addEventListener('click', () => { placement = null; modelToken++; if (model) scene.remove(model); model = null; $('status').textContent = __t('資產已移除；點選任一地形重新放置。') })

async function start() {
  try {
    const response = await fetch(`/api/microterrain/search?${new URLSearchParams(source)}`)
    if (!response.ok) throw Error((await response.json()).error || `HTTP ${response.status}`)
    data = await response.json()
    match = data.matches[selected]
    if (!data.reference_height_m || !match?.earth_aligned_height_m) throw Error(__t('此查詢沒有真實高程網格'))
    side = data.actual_sampled_side_m
    const deviations = data.reference_height_m.flatMap((row, r) => row.map((value, c) =>
      Math.abs(Number(match.earth_aligned_height_m[r][c]) - Number(value)))).sort((a, b) => a - b)
    residualScaleM = Math.max(.1, deviations[Math.floor(.9 * (deviations.length - 1))])
    const visualSpacing = side / Math.max(data.reference_height_m.length - 1, 1)
    $('summary').textContent = __m`${data.site_label} × ${match.site_label} · ${data.size_m} m 實際方框 · 搜尋比較格距 ${data.comparison_spacing_m} m，3D 預覽約 ${visualSpacing.toFixed(1)} m／格 · ${data.comparison === 'meter' ? __t('真實高差') : __t('正規化形狀')}精排。兩側使用同一公尺尺度；地球已按 D4 比對結果旋轉或鏡像；中位高度對齊後的公尺 RMSE 為 ${match.height_rmse_m.toFixed(2)} m。`
    $('left-title').textContent = `${data.body === 'mars' ? __t('火星') : __t('月球')} · ${__t(data.site_label)}`
    $('left-detail').textContent = __m`原始 DEM 格距約 ${data.source_resolution_m} m；局部選區高程以中位值為零。`
    const hiriseImage = data.body === 'mars' && source.site === 'JEZERO_HIRISE_023524' && !!data.reference_orthophoto
    const ctxImage = data.body === 'mars' && !hiriseImage && !!data.reference_orthophoto
    const lrocImage = data.body === 'moon' && !!data.reference_orthophoto
    $('left-photo-detail').textContent = hiriseImage ? __m`影像：與 HiRISE DTM 同產品的灰階正射影像，原始約 ${data.reference_orthophoto.source_spacing_m.toFixed(1)} m 像元。亮暗含日照與陰影，不是自然色、岩性圖或額外的地形測量。` : ctxImage ? __m`影像：與 USGS CTX DTM 同產品的灰階正射影像，約 ${data.reference_orthophoto.source_spacing_m.toFixed(1)} m 像元；顯示固定灰階拉伸。它不是自然色、岩性圖或額外的地形測量。` : lrocImage ? __m`影像：與 LROC NAC DTM 對齊的 ${data.reference_orthophoto.source_spacing_m.toFixed(1)} m 灰階正射影像 ${data.reference_orthophoto.product_id}；顯示固定亮度 gamma。亮暗含日照及陰影，不等於礦物或表面材質。` : __t('此窗格尚無對齊的正射影像貼圖；表面為 DEM 純色視覺化。')
    $('left-photo-source').style.display = hiriseImage || ctxImage || lrocImage ? 'inline' : 'none'
    $('left-photo-source').href = hiriseImage || ctxImage || lrocImage ? data.reference_orthophoto.source_page : '#'
    $('right-title').textContent = __m`地球 · ${match.site_label}`
    const nps = match.earth_detailed_geologic_map_context
    const naip = match.earth_naip_vegetation_signal
    const earthPhotoMeta = match.earth_orthophoto
    $('right-detail').textContent = __m`${match.regional_context}。USGS 3DEP 裸地高程，原始 1 m，重建至 ${data.comparison_spacing_m} m 搜尋格網；材質與任務適用性仍未知。${nps?.mapped_units?.length ? __m`${nps.map_name||__t('詳細地質')} 1:${Number(nps.map_scale_denominator).toLocaleString('en-US')} 圖的主要單元為 ${nps.mapped_units[0].name}（約 ${(nps.mapped_units[0].fraction*100).toFixed(0)}% 方框）；這是多邊形標註，不是岩石露頭測量。` : ''}${naip ? __m`${naip.acquisition_dates.join("／")} USGS NAIP 的 NDVI ≥0.2 像元占 ${(naip.fraction_ndvi_ge_0_2*100).toFixed(2)}%，只是未校準的植被訊號，不是裸岩比例。` : ''}${match.surface_evidence_conflict ? __t('州圖沖積層與 NLCD 灌叢有雙重衝突，不應稱作裸岩類比。') : match.mapped_alluvium_dominant ? __t('州地質圖顯示沖積層主導；即使土地覆蓋歸為裸地，也不能證明裸岩或與月／火地質成因相同。') : ''}`
    $('earth-photo-detail').textContent = earthPhotoMeta ? __m`地球影像：${earthPhotoMeta.year} USGS NAIP 四波段航照的 RGB 裁切，來源場景解析度約 ${earthPhotoMeta.source_scene_resolution_m} m，本站以 ${earthPhotoMeta.texture_spacing_m} m 取樣貼在 3DEP DEM 上，並依檢索的旋轉／鏡像方向對齊。航照只能顯示表面外觀，無法確認礦物、岩性或露頭。` : __t('此候選尚無座標對齊的航照貼圖；3D 表面為 DEM 純色預覽。')
    $('earth-photo-source').style.display = earthPhotoMeta ? 'inline' : 'none'
    $('earth-photo-source').href = earthPhotoMeta?.source_page || '#'
    if (data.body === 'mars') $('asset').value = 'perseverance_rover'
    rebuildTerrain(); fit(); resize()
    const textureLoader = new THREE.TextureLoader()
    const imageLoads = []
    if (earthPhotoMeta && Number.isInteger(match.gallery_index)) {
      const url = `/api/microterrain/earth-orthophoto?${new URLSearchParams({body: data.body, size_m: data.size_m, index: match.gallery_index, orientation: match.orientation_code, fine: match.fine_gallery ? 1 : 0})}`
      imageLoads.push(textureLoader.loadAsync(url).then(texture => { earthPhoto = texture }, error => {
        $('earth-photo-detail').textContent = __m`地球航照無法載入：${error.message}。目前仍顯示 DEM 純色預覽。`
      }))
    }
    if (ctxImage) {
      const url = `/api/microterrain/ctx-orthophoto?${new URLSearchParams({site: source.site, size_m: data.size_m, east_m: source.east_m, north_m: source.north_m})}`
      imageLoads.push(textureLoader.loadAsync(url).then(texture => { referencePhoto = texture }, error => {
        $('left-photo-detail').textContent = __m`CTX 正射影像無法載入：${error.message}。目前仍顯示 DEM 純色預覽。`
      }))
    }
    if (hiriseImage) {
      const url = `/api/microterrain/hirise-orthophoto?${new URLSearchParams({site: source.site, size_m: data.size_m, east_m: source.east_m, north_m: source.north_m})}`
      imageLoads.push(textureLoader.loadAsync(url).then(texture => { referencePhoto = texture }, error => {
        $('left-photo-detail').textContent = __m`HiRISE 正射影像無法載入：${error.message}。目前仍顯示 DEM 純色預覽。`
      }))
    }
    if (lrocImage) {
      const url = `/api/microterrain/lroc-orthophoto?${new URLSearchParams({site: source.site, size_m: data.size_m, east_m: source.east_m, north_m: source.north_m})}`
      imageLoads.push(textureLoader.loadAsync(url).then(texture => { referencePhoto = texture }, error => {
        $('left-photo-detail').textContent = __m`LROC 正射影像無法載入：${error.message}。目前仍顯示 DEM 純色預覽。`
      }))
    }
    await Promise.all(imageLoads)
    for (const texture of [referencePhoto, earthPhoto]) if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
    }
    if (imageLoads.length) rebuildTerrain()
    $('status').textContent = __t('兩側 DEM 已並排：拖曳旋轉、滾輪或雙指縮放；點選任一表面放置 NASA 資產。可切換到同位置疊合或逐格高差。')
  } catch (error) { $('status').textContent = __m`情境載入失敗：${error.message}` }
}
start()
