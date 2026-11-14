// i18n v2: display-string helpers from /i18n/static-i18n.js (identity fallback keeps the Chinese page working without it)
var __t = (typeof window !== 'undefined' && window.__t) || (s => s), __m = (typeof window !== 'undefined' && window.__m) || ((p, ...v) => p.map((x, i) => x + (i < v.length ? String(v[i]) : '')).join(''))
const ratingLabels = [['0', __t('無關')], ['1', __t('弱')], ['2', __t('中')], ['3', __t('高')], ['U', __t('無法判定')]]
const $ = id => document.getElementById(id)
let pack, items = [], index = 0, answers = {}
let storeKey = ''
let activeReviewer = ''
const isolatedReview = () => ['v6', 'v7', 'v8'].includes(pack?.version)
const escapeHtml = value => String(value ?? __t('未提供')).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const current = () => items[index]
const answer = () => answers[current().pair.pair_id] || {}
const save = () => {
  localStorage.setItem(storeKey, JSON.stringify({reviewer: activeReviewer || $('reviewer').value.trim(), answers}))
  if (isolatedReview()) localStorage.setItem(`selene-review:${pack.sha256}:last-reviewer`, activeReviewer)
}
function reviewerKey(name) { return `selene-review:${pack.sha256}:reviewer:${name || 'draft'}` }
function switchReviewer() {
  if (!isolatedReview()) { save(); return }
  const next = $('reviewer').value.trim()
  if (next === activeReviewer) return
  const draft = answers
  localStorage.setItem(storeKey, JSON.stringify({reviewer: activeReviewer, answers: draft}))
  const nextKey = reviewerKey(next)
  const prior = JSON.parse(localStorage.getItem(nextKey) || '{}')
  answers = prior.answers || (activeReviewer === '' && next ? {...draft} : {})
  activeReviewer = next
  storeKey = nextKey
  save(); render()
}
const nativePack = () => ['v5', 'v6', 'v7', 'v8'].includes(pack.version)
function v6Evidence(e) {
  const map = e.earth_detailed_map
  const mapText = map ? __m`${escapeHtml(map.map_name)} 1:${Number(map.scale_denominator).toLocaleString('en-US')}，方框覆蓋 ${(map.mapped_fraction*100).toFixed(1)}%；${map.units.map(u=>`${escapeHtml(u.name)}（${escapeHtml(u.symbol)}）${(u.fraction*100).toFixed(1)}%`).join('；') || __t('無已繪單元')}` : __t('沒有同窗格的細尺度地表圖；粗州圖不足以判斷裸露材質')
  const cover = e.earth_nlcd_2024
  const coverText = cover ? __m`Annual NLCD 2024：${cover.sample_pixels} 個 30 m 像元；裸地（岩／砂／黏土混合）${(cover.barren_rock_sand_clay_fraction*100).toFixed(1)}%、灌叢 ${(cover.shrub_scrub_fraction*100).toFixed(1)}%。此分類不能區分裸岩與砂。` : __t('尚無土地覆蓋資料')
  return __m`<dl><dt>地球地表圖</dt><dd>${mapText}</dd><dt>地球土地覆蓋</dt><dd>${coverText}</dd><dt>月／火材質</dt><dd>此資料包沒有可與地球逐窗格比較的光譜或現地標註；材質評分通常應選「無法判定」</dd><dt>環境／任務</dt><dd>沒有逐窗格安全、資源或工程資料；任務評分通常應選「無法判定」</dd><dt>高程來源</dt><dd>行星：${escapeHtml(e.reference_dem_source)}；地球：${escapeHtml(e.earth_dem_source)}</dd></dl>`
}
function rating(axis) {
  const area = $(axis)
  area.replaceChildren()
  for (const [value, label] of ratingLabels) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `${value} · ${label}`
    button.className = answer()[axis] === value ? 'selected' : ''
    button.setAttribute('aria-pressed', answer()[axis] === value ? 'true' : 'false')
    button.addEventListener('click', () => {
      answers[current().pair.pair_id] = {...answer(), [axis]: value, note: $('note').value}
      save(); render()
    })
    area.append(button)
  }
}
function render() {
  const {query, pair, pairNumber} = current()
  const existing = answer()
  $('counter').textContent = `QUERY ${current().queryNumber} / ${pack.queries.length} · PAIR ${pairNumber} / ${current().pairTotal} · ${index + 1} / ${items.length}`
  $('query-title').textContent = nativePack()
    ? __m`${query.body === 'mars' ? __t('火星') : __t('月球')}場址 ${String(current().queryNumber).padStart(2, '0')} · ${query.scale_m} m`
    : pack.version === 'v4'
    ? __m`月球場址 ${String(current().queryNumber).padStart(2, '0')} · ${query.scale_km} km`
    : `${query.moon_window} · ${query.scale_km} km`
  $('reference-caption').textContent = pack.version === 'v8' ? 'MARS · HiRISE LOCAL DTM' : nativePack() ? `${query.body === 'mars' ? 'MARS · CTX' : 'MOON · NAC'} LOCAL DTM` : 'MOON · LOLA'
  $('earth-caption').textContent = nativePack() ? 'EARTH · USGS 3DEP' : 'EARTH · ETOPO / SRTM'
  $('render-note').textContent = pack.version === 'v8'
    ? __t('兩圖是 200／500／1000 公尺相同窗格、4 公尺比對格距的 DEM 顯示重採樣，共用一對相對高程灰階範圍。陰影的垂直起伏放大 8 倍；影像不能顯示礦物或基地安全。')
    : nativePack()
    ? __t('兩圖是相同公尺窗格、共用灰階高程範圍的原生 DEM 顯示重採樣。陰影的垂直起伏放大 8 倍；原始月地 5 m／火地 20 m 比對格距不因顯示重採樣而改變。影像不能顯示礦物或基地安全。')
    : __t('兩圖是相同公里窗格、同一對共用高程灰階範圍的 64×64 DEM 陰影展示；陰影的垂直起伏放大 8 倍以方便看形狀。它不能顯示礦物或基地安全。')
  $('progress').textContent = __m`${Object.values(answers).filter(a => a.morphology && a.material && a.mission).length} / ${items.length} 完成`
  $('moon').src = pair.moon_image
  $('earth').src = pair.earth_image
  $('moon-relief').textContent = __m`P90–P10 起伏 ${pair.moon_relief_m} m`
  $('earth-relief').textContent = __m`P90–P10 起伏 ${pair.earth_relief_m} m`
  $('note').value = existing.note || ''
  for (const axis of ['morphology', 'material', 'mission']) rating(axis)
  const revealed = !!existing.morphology
  $('evidence').hidden = !revealed
  $('other-ratings').hidden = !revealed
  const e = pair.evidence
  $('evidence-content').innerHTML = ['v6', 'v7', 'v8'].includes(pack.version) ? v6Evidence(e) : pack.version === 'v5'
    ? __m`<dl><dt>地質／材質</dt><dd>尚無窗格級可比較證據，請選「無法判定」或記錄其他獨立證據</dd><dt>環境／任務</dt><dd>尚無窗格級環境、安全或資源證據</dd><dt>高程來源</dt><dd>行星：${escapeHtml(e.moon_dem_source)}；地球：${escapeHtml(e.earth_dem_source)}</dd></dl>`
    : __m`<dl><dt>月球地質圖單元</dt><dd>${escapeHtml(e.moon_geologic_unit)} · ${escapeHtml(e.moon_geologic_period)}</dd><dt>月球光譜傾向</dt><dd>${escapeHtml(e.moon_spectral_tendency)}</dd><dt>地球區域岩性</dt><dd>${escapeHtml(e.earth_regional_lithology)}</dd><dt>地球附近官方目錄</dt><dd>撞擊構造：${e.near_cataloged_earth_impact ? __t('附近有中心') : __t('無附近中心')}；破火山口：${e.near_cataloged_earth_caldera ? __t('附近有中心') : __t('無附近中心')}</dd><dt>高程來源</dt><dd>月球：${escapeHtml(e.moon_dem_source)}；地球：${escapeHtml(e.earth_dem_source)}</dd></dl>`
  $('previous').disabled = index === 0
  $('next').disabled = index === items.length - 1
  $('message').textContent = ''
}
function move(delta) {
  const a = answer()
  if (delta > 0 && !(a.morphology && a.material && a.mission)) {
    $('message').textContent = __t('請先為三個問題各選一項；資料不足請選「無法判定」。')
    return
  }
  index = Math.max(0, Math.min(items.length - 1, index + delta))
  render(); window.scrollTo({top: 0, behavior: 'smooth'})
}
function exportAnswers() {
  switchReviewer()
  const reviewer = $('reviewer').value.trim()
  if (!reviewer) { $('message').textContent = __t('匯出前請填評分者代號。'); return }
  save()
  const output = {version: pack.version, pack_sha256: pack.sha256, reviewer,
    exported_at_utc: new Date().toISOString(), answers}
  const file = new Blob([JSON.stringify(output, null, 2)], {type: 'application/json'})
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url; link.download = `selene-review-${pack.version}-${reviewer}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function importAnswers(file) {
  if (!file) return
  try {
    const incoming = JSON.parse(await file.text())
    if (incoming.pack_sha256 !== pack.sha256 || !incoming.answers || typeof incoming.answers !== 'object') throw new Error(__t('評分檔版本或資料包不相符'))
    const allowed = new Set(items.map(item => item.pair.pair_id))
    if (Object.keys(incoming.answers).some(id => !allowed.has(id))) throw new Error(__t('評分檔含未知窗格'))
    $('reviewer').value = incoming.reviewer || ''
    switchReviewer()
    answers = incoming.answers
    save(); render()
  } catch (error) { $('message').textContent = __m`匯入失敗：${error.message}` }
}
// English display variant (pack_vN.en.json): same structure, ids and numbers; only Chinese label strings differ.
const hasHan = s => /[㐀-鿿]/.test(s)
function sameData(a, b) {
  if (typeof a === 'string') return typeof b === 'string' && (hasHan(a) || a === b)
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameData(x, b[i]))
  if (a && typeof a === 'object') return !!b && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => sameData(a[k], b[k]))
  return a === b
}
async function englishPack(revision, canonical) {
  if (window.ATLAS_I18N?.lang !== 'en' || !['v2', 'v3', 'v4'].includes(revision)) return canonical
  try {
    const response = await fetch(`./pack_${revision}.en.json`, {cache: 'no-store'})
    if (!response.ok) return canonical
    const english = await response.json()
    return sameData(canonical, english) ? english : canonical
  } catch { return canonical }
}
async function start() {
  try {
    const requested = new URLSearchParams(location.search).get('pack')
    const revision = ['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'].includes(requested) ? requested : 'v7'
    const response = await fetch(`./pack_${revision}.json`, {cache: 'no-store'})
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw = await response.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', raw)
    const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
    pack = JSON.parse(new TextDecoder().decode(raw))
    pack = await englishPack(revision, pack)
    pack.sha256 = sha
    items = pack.queries.flatMap((query, q) => query.pairs.map((pair, i) => ({query, pair, queryNumber: q + 1, pairNumber: i + 1, pairTotal: query.pairs.length})))
    const expected = revision === 'v3' ? 144 : 120
    if (pack.queries.length !== 24 || items.length !== expected || new Set(items.map(i => i.pair.pair_id)).size !== expected) throw new Error(__t('固定資料包數量不符'))
    $('study-description').textContent = revision === 'v8'
      ? __t('HiRISE Jezero 八個預先固定位置，各以 200／500／1000 公尺查詢，共 24 題／120 對。地球候選只來自保留地理區 Lava Beds 與 Pilot Valley 的 4 公尺 DEM 窗格；2014 地貌基線、自訓小模型和隨機對照亂序展示。先評地形，再評材質與任務；缺乏逐窗格證據時請選「無法判定」。地球地理區為保留集，但 Jezero 場址曾用於開發；這不是全球準確率驗證。')
      : revision === 'v7'
      ? __t('六個月球與兩個火星局部 DTM 場址、三種小尺度，共 24 題／120 對。地球候選只來自未參與模型開發的 Lava Beds 與 Pilot Valley 兩處固定地理保留區，傳統地貌簽章、小模型和抽樣對照亂序展示。方法、地球場址及排名隱藏；先評地形，再記錄材質與任務是否有足夠證據。此包沒有逐窗格材質或安全真值，資料不足請選「無法判定」。月／火查詢仍是既有開發場址，請勿把結果視為全球類比準確率。')
      : revision === 'v6'
      ? __t('六個月球、兩個火星局部 DTM 場址，各以 200／500／1000 公尺查詢，共 24 題、120 對。候選來自目前八處地球研究區的 2014 地貌基線、自訓小模型及按場址抽樣的對照。先只評地形；評完形狀才看可用的地球地表圖和土地覆蓋。方法、排名及地球場址名稱另存，評分頁不揭露。這是開發場址的有限候選池評估，不是全新地理保留集。')
      : revision === 'v5'
      ? __t('六個月球、兩個火星局部 DTM 場址，各以 200／500／1000 公尺查詢，共 24 個問題與 120 對窗格。每題取兩種方法的候選與隨機對照，方法、排名與場址名稱均隱藏。先評形狀，再看來源證據；材質與任務資料不足時請選「無法判定」。此資料包固定於擴庫前 Meteor Crater 與 Kilbourne Hole 兩處地球候選，是有限候選池的方法比較，尚不能證明發現新地球類比地點。')
      : revision === 'v4'
      ? __t('八個月球場址、三種尺度，共 24 個查詢。每個查詢從同一批地球窗格選出三種地形檢索方法及兩種對照，亂序後共 120 對。先只評地貌形狀，再看來源資料評材質與基地情境；資料不足時選「無法判定」。場址類型、方法與排名均不在此頁揭露。')
      : revision === 'v3'
        ? __t('24 個固定月球查詢，每個查詢從同一批地球窗格選出神經向量、傳統地形描述子和隨機對照候選，亂序後共 144 對。先評形狀，再看來源資料評材質與基地情境。請分開判斷；資料不足時選「無法判定」。原始排名與分數不在此頁。')
        : __t('24 個固定月球查詢，每個查詢有 5 個亂序的目前模型全球前列候選，共 120 對。先評形狀，再看來源資料評材質與基地情境。請分開判斷；資料不足時選「無法判定」。原始排名與分數不在此頁。')
    storeKey = `selene-review:${sha}`
    if (['v6', 'v7', 'v8'].includes(revision)) {
      activeReviewer = localStorage.getItem(`${storeKey}:last-reviewer`) || ''
      storeKey = reviewerKey(activeReviewer)
    }
    const stored = JSON.parse(localStorage.getItem(storeKey) || '{}')
    answers = stored.answers || {}
    $('reviewer').value = isolatedReview() ? activeReviewer : (stored.reviewer || '')
    $('loading').hidden = true; $('card').hidden = false
    render()
  } catch (error) { $('loading').textContent = __m`評估資料載入失敗：${error.message}` }
}
$('previous').addEventListener('click', () => move(-1))
$('next').addEventListener('click', () => move(1))
$('export').addEventListener('click', exportAnswers)
$('import').addEventListener('change', event => importAnswers(event.target.files?.[0]))
$('reviewer').addEventListener('change', switchReviewer)
$('reviewer').addEventListener('input', () => { if (!isolatedReview()) save() })
$('note').addEventListener('input', () => { answers[current().pair.pair_id] = {...answer(), note: $('note').value}; save() })
start()
