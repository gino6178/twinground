// i18n v2: display-string helpers from /i18n/static-i18n.js (identity fallback keeps the Chinese page working without it)
var __t = (typeof window !== 'undefined' && window.__t) || (s => s), __m = (typeof window !== 'undefined' && window.__m) || ((p, ...v) => p.map((x, i) => x + (i < v.length ? String(v[i]) : '')).join(''))
const $ = id => document.getElementById(id)
const coverageOptions = [['0',__t('無')],['1','<25%'],['2','25–75%'],['3','>75%'],['U',__t('無法判斷')]]
const confidenceOptions = [['1',__t('低')],['2',__t('中')],['3',__t('高')],['U',__t('無法判斷')]]
const axes = ['exposed_rock','loose_sediment','vegetation','shadow','confidence']
let pack, packHash, items = [], position = 0, reviewer = '', answers = {}
const current = () => items[position]
const currentAnswer = () => answers[current().review_id] || {}
const storageKey = () => `analog-cima-surface-v1:${packHash}:${reviewer}`
const completed = answer => axes.every(axis => answer?.[axis] != null)

function save() {
  if (!reviewer) return
  try { localStorage.setItem(storageKey(), JSON.stringify(answers)) }
  catch { $('message').textContent = __t('瀏覽器無法儲存草稿；請定期匯出 JSON。') }
}

function setAnswer(field, value) {
  answers[current().review_id] = {...currentAnswer(), [field]: value}
  save()
  render()
}

function renderRatings(axis) {
  const area = $(axis)
  area.replaceChildren()
  const choices = axis === 'confidence' ? confidenceOptions : coverageOptions
  for (const [value, label] of choices) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.title = `${axis}: ${label}`
    const selected = currentAnswer()[axis] === value
    button.className = selected ? 'selected' : ''
    button.setAttribute('aria-pressed', String(selected))
    button.addEventListener('click', () => setAnswer(axis, value))
    area.append(button)
  }
}

function render() {
  const item = current()
  if (!item) return
  const n = Object.values(answers).filter(completed).length
  $('counter').textContent = `WINDOW ${String(position + 1).padStart(2,'0')} / ${items.length}`
  $('review-id').textContent = __m`匿名窗格 ${item.review_id}`
  $('progress').textContent = __m`${n} / ${items.length} 完成 · ${reviewer}`
  $('photo-image').src = `./${item.image}`
  $('photo-link').href = `./${item.image}`
  $('note').value = currentAnswer().note || ''
  for (const axis of axes) renderRatings(axis)
  $('previous').disabled = position === 0
  $('next').disabled = position === items.length - 1
  $('message').textContent = ''
}

function startReviewer() {
  const value = $('reviewer').value.trim()
  if (value.length < 2) {
    $('setup-message').textContent = __t('請輸入至少兩個字元的評分者代號。')
    return
  }
  reviewer = value
  try { answers = JSON.parse(localStorage.getItem(storageKey()) || '{}') }
  catch { answers = {} }
  position = 0
  $('setup').hidden = true
  $('review').hidden = false
  render()
  window.scrollTo({top: 0, behavior: 'smooth'})
}

function switchReviewer() {
  save()
  $('reviewer').value = ''
  $('setup-message').textContent = ''
  $('review').hidden = true
  $('setup').hidden = false
  reviewer = ''
  answers = {}
  $('reviewer').focus()
}

function exportAnswers() {
  if (!reviewer) return
  save()
  const output = {
    version: 'cima-surface-v1', pack_sha256: packHash, reviewer,
    exported_at_utc: new Date().toISOString(),
    complete_count: Object.values(answers).filter(completed).length,
    item_count: items.length, answers,
    interpretation: 'RGB visual observations only; no mineral or exposed-lithology ground truth',
  }
  const blob = new Blob([JSON.stringify(output, null, 2)], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `cima-surface-review-${reviewer.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  $('message').textContent = output.complete_count === items.length
    ? __t('12 筆已完成並匯出。請將 JSON 交給研究團隊。')
    : __m`已匯出草稿：${output.complete_count} / ${items.length} 筆完成。`
}

async function importAnswers(file) {
  if (!file) return
  try {
    const input = JSON.parse(await file.text())
    if (input.version !== 'cima-surface-v1' || input.pack_sha256 !== packHash ||
        input.reviewer !== reviewer || !input.answers || Array.isArray(input.answers) ||
        typeof input.answers !== 'object') {
      throw new Error(__t('資料包版本或評分者代號不符'))
    }
    const ids = new Set(items.map(item => item.review_id))
    for (const [id, answer] of Object.entries(input.answers)) {
      if (!ids.has(id) || !answer || typeof answer !== 'object')
        throw new Error(__t('評分檔含未知窗格'))
      for (const axis of axes) {
        const choices = axis === 'confidence' ? confidenceOptions : coverageOptions
        if (answer[axis] != null && !choices.some(([choice]) => choice === answer[axis]))
          throw new Error(__t('評分檔含無效選項'))
      }
      if (answer.note != null && (typeof answer.note !== 'string' || answer.note.length > 2000))
        throw new Error(__t('評分檔備註無效'))
    }
    answers = input.answers
    save(); render()
    $('message').textContent = __t('已匯入相同資料包、相同評分者的草稿。')
  } catch (error) { $('message').textContent = __m`匯入失敗：${error.message}` }
  $('import').value = ''
}

async function start() {
  try {
    const response = await fetch('./pack.json', {cache: 'no-store'})
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw = await response.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', raw)
    packHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('')
    pack = JSON.parse(new TextDecoder().decode(raw))
    items = pack.items
    if (pack.count !== 12 || items.length !== 12 ||
        new Set(items.map(item => item.review_id)).size !== 12 ||
        items.some(item => item.mapped_units || item.stratum || item.gallery_index ||
          item.image !== `images/${item.review_id}.webp`)) {
      throw new Error(__t('匿名資料包內容不符'))
    }
    $('loading').hidden = true
    $('setup').hidden = false
  } catch (error) { $('loading').textContent = __m`資料包載入失敗：${error.message}` }
}

$('start').addEventListener('click', startReviewer)
$('reviewer').addEventListener('keydown', event => { if (event.key === 'Enter') startReviewer() })
$('switch').addEventListener('click', switchReviewer)
$('previous').addEventListener('click', () => { position--; render(); window.scrollTo({top:0,behavior:'smooth'}) })
$('next').addEventListener('click', () => { position++; render(); window.scrollTo({top:0,behavior:'smooth'}) })
$('export').addEventListener('click', exportAnswers)
$('import').addEventListener('change', event => importAnswers(event.target.files?.[0]))
$('note').addEventListener('input', () => {
  answers[current().review_id] = {...currentAnswer(), note: $('note').value}
  save()
})
document.addEventListener('keydown', event => {
  if ($('review').hidden || ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return
  if (event.key === 'ArrowLeft' && position > 0) { position--; render() }
  if (event.key === 'ArrowRight' && position < items.length - 1) { position++; render() }
})
start()
