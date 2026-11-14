export const normalizePlace = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').trim().replace(/\s+/g, ' ')
const suggestions = {moon:['Mare Tranquillitatis','Mare Imbrium','Oceanus Procellarum','Tycho','Copernicus'],mars:['Jezero','Gale','Olympus Mons','Valles Marineris']}
export function findPlaces(rows, query, body, limit=8) {
  const term=normalizePlace(query)
  const preferred=suggestions[body] || []
  return rows.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat)<=89.5 && Math.abs(p.lon)<=180)
    .map(p => {const names=[p.name,...(p.aliases || [])].map(normalizePlace); return {p,rank:!term ? preferred.indexOf(p.name) : names.some(n=>n===term)?0:names.some(n=>n.startsWith(term))?1:names.some(n=>n.includes(term))?2:-1}})
    .filter(x=>x.rank>=0).sort((a,b)=>a.rank-b.rank || a.p.name.localeCompare(b.p.name,'en')).slice(0,limit).map(x=>x.p)
}
