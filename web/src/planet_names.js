// A readable name for a Moon or Mars query point from the IAU gazetteer (web/public/gazetteer). Features have no
// sizes there, so distance is scaled by a typical radius per feature type: a mare counts from hundreds of kilometres
// away, a crater only from nearby.
const cache = new Map()
const MOON_R = 1737.4, MARS_R = 3389.5

const TYPE_RADIUS_KM = [
  [/^oceanus|ocean/i, 1300], [/^terra\b|terrae/i, 900], [/planitia|planitiae/i, 700], [/planum|plana/i, 550],
  [/^mare|maria/i, 330], [/lacus|sinus|palus/i, 140], [/chasma|chasmata|vallis|valles/i, 160], [/fossa|fossae|labyrinthus/i, 150],
  [/mons|montes|tholus|patera|dorsum|dorsa/i, 90], [/rupes|rima|rimae|catena/i, 50], [/crater/i, 28],
]
const ZH = {
  'Mare Tranquillitatis': '寧靜海', 'Mare Serenitatis': '澄海', 'Mare Imbrium': '雨海', 'Mare Crisium': '危海',
  'Mare Fecunditatis': '豐富海', 'Mare Nectaris': '酒海', 'Mare Nubium': '雲海', 'Mare Humorum': '濕海',
  'Mare Frigoris': '冷海', 'Mare Vaporum': '汽海', 'Oceanus Procellarum': '風暴洋', 'Mare Insularum': '島海',
  'Mare Cognitum': '知海', 'Mare Orientale': '東海', 'Mare Moscoviense': '莫斯科海', 'Mare Smythii': '史密斯海',
  'Mare Marginis': '界海', 'Mare Australe': '南海', 'Mare Ingenii': '智海', 'Sinus Medii': '中央灣', 'Sinus Iridum': '虹灣',
  'Lacus Somniorum': '夢湖', 'Palus Putredinis': '腐沼', 'Mare Spumans': '泡沫海', 'Mare Undarum': '浪海',
  'Olympus Mons': '奧林帕斯山', 'Valles Marineris': '水手號峽谷', 'Hellas Planitia': '希臘平原', 'Utopia Planitia': '烏托邦平原',
  'Arabia Terra': '阿拉伯台地', 'Syrtis Major Planum': '大瑟提斯高原', 'Elysium Planitia': '埃律西昂平原',
  'Acidalia Planitia': '阿西達利亞平原', 'Chryse Planitia': '克律塞平原', 'Arcadia Planitia': '阿卡迪亞平原',
  'Amazonis Planitia': '亞馬遜平原', 'Isidis Planitia': '伊希地平原', 'Meridiani Planum': '子午線高原', 'Tharsis Montes': '塔爾西斯山脈',
  'Gale': '蓋爾撞擊坑', 'Jezero': '傑澤羅撞擊坑', 'Shackleton': '沙克爾頓撞擊坑', 'Pavonis Mons': '孔雀山', 'Arsia Mons': '阿爾西亞山',
}

function radiusFor(type) {
  for (const [pattern, km] of TYPE_RADIUS_KM) if (pattern.test(type || '')) return km
  return 25
}

function load(body) {
  if (!cache.has(body)) cache.set(body, fetch(`/gazetteer/${body}.json`).then(r => (r.ok ? r.json() : null)).then(d => d?.rows || []).catch(() => []))
  return cache.get(body)
}

// { name, zh } of the best-matching named feature, or null.
export async function planetPlace(body, lat, lon) {
  if (body !== 'moon' && body !== 'mars') return null
  const rows = await load(body)
  const R = body === 'moon' ? MOON_R : MARS_R
  const toRad = Math.PI / 180, la = lat * toRad, lo = lon * toRad
  let best = null, bestScore = Infinity
  for (const row of rows) {
    const dLat = row.lat * toRad - la, dLon = row.lon * toRad - lo
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(row.lat * toRad) * Math.sin(dLon / 2) ** 2
    const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
    const score = km / radiusFor(row.type)
    if (score < bestScore) { bestScore = score; best = { name: row.name, km } }
  }
  if (!best || bestScore > 3) return null
  return { name: best.name, zh: ZH[best.name] || null, km: best.km }
}
