// Time of day, sun position and weather for the astronaut explorer.
// Earth weather comes from NASA POWER monthly climatology at the candidate point (2001-2025);
// Mars and Moon conditions are physical approximations, labelled as such in the interface.
const RAD = Math.PI / 180
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

export const SOL_HOURS = { earth: 24, mars: 24.6597, moon: 24 }

// Sun elevation and azimuth (degrees, azimuth clockwise from north) from latitude, solar
// declination and local solar time in body hours (12 = local noon).
export function sunFrom(latDeg, declDeg, localHour) {
  const phi = latDeg * RAD, dec = declDeg * RAD, H = (localHour - 12) * 15 * RAD
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const el = Math.asin(clamp(sinEl, -1, 1))
  const az = Math.atan2(-Math.sin(H) * Math.cos(dec), Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(H))
  return { elevation: el / RAD, azimuth: ((az / RAD) + 360) % 360 }
}

export function dayLengthHours(latDeg, declDeg, solHours = 24) {
  const x = -Math.tan(latDeg * RAD) * Math.tan(declDeg * RAD)
  if (x <= -1) return solHours
  if (x >= 1) return 0
  return 2 * Math.acos(x) / RAD / 15 * solHours / 24
}

export const earthDeclination = month => -23.44 * Math.cos(2 * Math.PI / 365 * ((month - 0.5) * 30.44 + 10))
export const marsDeclination = ls => Math.asin(Math.sin(25.19 * RAD) * Math.sin(ls * RAD)) / RAD

// Current Mars season (Ls) and local mean solar time; Allison & McEwen (2000) / Mars24.
export function marsNow(lonEastDeg, date = new Date()) {
  const jdTT = date.getTime() / 86400000 + 2440587.5 + 69.184 / 86400
  const dt = jdTT - 2451545.0
  const M = (19.3871 + 0.52402073 * dt) * RAD
  const alphaFMS = 270.3871 + 0.524038496 * dt
  let pbs = 0
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018], tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493], phi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095]
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos((0.985626 * dt / tau[i] + phi[i]) * RAD)
  const nu = (10.691 + 3.0e-7 * dt) * Math.sin(M) + 0.623 * Math.sin(2 * M) + 0.050 * Math.sin(3 * M) + 0.005 * Math.sin(4 * M) + 0.0005 * Math.sin(5 * M) + pbs
  const ls = ((alphaFMS + nu) % 360 + 360) % 360
  const msd = (jdTT - 2405522.0028779) / 1.0274912517
  const mtc = ((24 * msd) % 24 + 24) % 24
  const lmst = ((mtc + lonEastDeg / 15) % 24 + 24) % 24
  return { ls, localHour: lmst }
}

// Moon: subsolar longitude follows the synodic month (180° at new moon, 0° at full moon).
export function moonNow(lonEastDeg, date = new Date()) {
  const age = ((date.getTime() / 86400000 - 10962.76) % 29.530588 + 29.530588) % 29.530588
  const subsolar = 180 - 360 * age / 29.530588
  const localHour = (((lonEastDeg - subsolar) / 15 + 12) % 24 + 24) % 24
  return { localHour, age }
}

export function earthNow(lonEastDeg, date = new Date()) {
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60
  return { month: date.getUTCMonth() + 1, localHour: ((utcHours + lonEastDeg / 15) % 24 + 24) % 24 }
}

const POWER = 'https://power.larc.nasa.gov/api/temporal/climatology/point'
const POWER_PARAMS = ['T2M', 'T2M_RANGE', 'PRECTOTCORR', 'WS2M', 'RH2M', 'CLOUD_AMT', 'PS']
export async function loadEarthClimate(lat, lon, signal) {
  const url = `${POWER}?parameters=${POWER_PARAMS.join(',')}&community=RE&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}&format=JSON`
  const response = await fetch(url, { signal })
  if (!response.ok) throw Error('NASA POWER ' + response.status)
  const data = await response.json()
  const p = data.properties.parameter, fill = data.header?.fill_value ?? -999
  const months = MONTHS.map(m => Object.fromEntries(POWER_PARAMS.map(k => [k, p[k]?.[m] === fill ? null : p[k]?.[m]])))
  return { months, source: 'NASA POWER climatology 2001-2025', url }
}

// Deterministic draw for a given day so the same date always shows the same weather.
const unit = seed => { let t = (seed * 2654435761) >>> 0; t ^= t >>> 15; t = Math.imul(t, 2246822519) >>> 0; t ^= t >>> 13; return (t >>> 0) / 4294967296 }

export function earthWeather(climate, month, localHour, day = 15, override = 'auto', elevationM = 0) {
  const m = climate?.months?.[month - 1]
  const T = m?.T2M ?? 15, range = m?.T2M_RANGE ?? 10, precip = m?.PRECTOTCORR ?? 1, wind = m?.WS2M ?? 3
  const rh = m?.RH2M ?? 50, cloudPct = m?.CLOUD_AMT ?? 40
  const pressure = m?.PS ?? 101.3 * Math.exp(-elevationM / 8400)
  const temperature = T + range / 2 * Math.cos(2 * Math.PI * (localHour - 15) / 24)
  // Heuristic daily draws from monthly means; shown as an estimate, not a forecast.
  const r = unit(month * 97 + day)
  const wetChance = clamp(1 - Math.exp(-precip / 2.2), 0, 0.92)
  let kind = 'clear'
  if (r < wetChance) kind = temperature < 0.5 ? 'snow' : 'rain'
  else if (unit(month * 31 + day + 7) < cloudPct / 100 * 0.8) kind = 'cloudy'
  if (rh > 82 && localHour > 4 && localHour < 9 && kind !== 'rain' && kind !== 'snow') kind = 'fog'
  const gust = wind * (1 + 0.6 * unit(month * 13 + day + Math.floor(localHour)))
  if (kind === 'clear' && gust > 7 && precip < 0.6) kind = 'dust'
  if (override !== 'auto') kind = override
  const cloud = kind === 'clear' ? cloudPct / 100 * 0.35 : kind === 'cloudy' ? 0.55 + cloudPct / 250 : kind === 'rain' || kind === 'snow' ? 0.95 : kind === 'fog' ? 0.6 : cloudPct / 100 * 0.4
  return {
    body: 'earth', kind, temperature, tempMin: T - range / 2, tempMax: T + range / 2, wind: kind === 'dust' ? Math.max(gust, 8) : gust,
    precipitation: precip, humidity: rh, cloud: clamp(cloud, 0, 1), pressureKPa: pressure, dust: kind === 'dust' ? 0.6 : 0,
    estimated: !m, wetChance,
  }
}

export function marsWeather(latDeg, ls, localHour, elevationM = 0, override = 'auto') {
  const dec = marsDeclination(ls)
  // Dust opacity: clear aphelion season, dusty perihelion season (peak near Ls 250°).
  let tau = 0.4 + 0.45 * Math.max(0, Math.sin((ls - 160) * RAD)) ** 2
  let kind = tau > 0.75 ? 'dusty' : 'clear'
  if (override === 'storm') { tau = 3.5; kind = 'storm' } else if (override === 'clear') { tau = 0.35; kind = 'clear' } else if (override === 'dusty') { tau = 1.0; kind = 'dusty' }
  const noonSun = Math.cos((latDeg - dec) * RAD)
  const tMean = -68 + 18 * Math.max(0, noonSun) - 6 * (tau - 0.5)
  const swing = 32 / (1 + 0.6 * tau)
  const temperature = tMean + swing * Math.cos(2 * Math.PI * (localHour - 14) / 24)
  const pressure = 0.61 * Math.exp(-elevationM / 11100) * (1 + 0.1 * Math.cos((ls - 250) * RAD))
  const dustDevils = kind !== 'storm' && localHour > 11 && localHour < 16.5 && noonSun > 0.6
  return { body: 'mars', kind, tau, temperature, tempMin: tMean - swing, tempMax: tMean + swing, wind: kind === 'storm' ? 25 : 4 + 3 * Math.sin(localHour / 24 * 2 * Math.PI), pressureKPa: pressure, cloud: 0, dust: clamp(tau / 4, 0.08, 1), dustDevils, precipitation: 0, humidity: 0, estimated: true }
}

export function moonWeather(sunElevationDeg) {
  // Equilibrium surface temperature ~ 390 K (cos z)^(1/4) in daylight, ~95 K at night (Diviner range).
  const cz = Math.sin(Math.max(0, sunElevationDeg) * RAD)
  const kelvin = sunElevationDeg > 0 ? Math.max(95, 390 * Math.pow(cz, 0.25)) : 95 + 15 * Math.exp(sunElevationDeg / 20)
  return { body: 'moon', kind: 'vacuum', temperature: kelvin - 273.15, tempMin: -178, tempMax: 117, wind: 0, pressureKPa: 3e-15, cloud: 0, dust: 0, precipitation: 0, humidity: 0, estimated: true, surface: true }
}

// Compare the active world's conditions with the other world's.
export function compareConditions(target, earth) {
  const rows = []
  const band = (a, b, close, near) => { const d = Math.abs(a - b); return d <= close ? 'match' : d <= near ? 'partial' : 'differ' }
  rows.push({ key: 'temperature', target: target.temperature, earth: earth.temperature, status: band(target.temperature, earth.temperature, 10, 30) })
  rows.push({ key: 'swing', target: target.tempMax - target.tempMin, earth: earth.tempMax - earth.tempMin, status: band(target.tempMax - target.tempMin, earth.tempMax - earth.tempMin, 10, 25) })
  rows.push({ key: 'dryness', target: target.precipitation, earth: earth.precipitation, status: earth.precipitation < 0.3 ? 'match' : earth.precipitation < 1.5 ? 'partial' : 'differ' })
  rows.push({ key: 'wind', target: target.wind, earth: earth.wind, status: band(target.wind, earth.wind, 3, 8) })
  rows.push({ key: 'pressure', target: target.pressureKPa, earth: earth.pressureKPa, status: 'never' })
  return rows
}
