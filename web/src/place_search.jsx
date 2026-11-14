import React, {useState, useEffect} from 'react'
import {findPlaces} from './place_search.js'
const catalogues = new Map()
function loadPlaces(body) {
  if (!catalogues.has(body)) catalogues.set(body, fetch('/gazetteer/'+body+'.json').then(r=>{if(!r.ok)throw new Error('catalogue');return r.json()}).then(data=>{if(data.body!==body||!Array.isArray(data.rows))throw new Error('catalogue');return data}).catch(error=>{catalogues.delete(body);throw error}))
  return catalogues.get(body)
}
export function PlaceSearch({body,onPick}) {
  const [query,setQuery]=useState('')
  const [data,setData]=useState(null)
  const [error,setError]=useState(false)
  const [attempt,setAttempt]=useState(0)
  const [open,setOpen]=useState(false)
  const [selection,setSelection]=useState('')
  useEffect(()=>{let current=true;setData(null);setError(false);loadPlaces(body).then(x=>{if(current)setData(x)}).catch(()=>{if(current)setError(true)});return()=>{current=false}},[body,attempt])
  const matches=data?findPlaces(data.rows,query,body):[]
  function choose(p){onPick(p.lat,p.lon);setQuery(p.name);setSelection('已定位 '+p.name);setOpen(false)}
  return <section className="place-search" aria-label={body==='moon'?'月球地名搜尋':'火星地名搜尋'}>
    <label htmlFor={'place-'+body}>以地名定位</label>
    <div className="place-search-field"><input id={'place-'+body} type="search" autoComplete="off" value={query} placeholder={body==='moon'?'搜尋地名，例如 Tycho／寧靜海':'搜尋地名，例如 Jezero／奧林帕斯山'} aria-controls={'places-'+body} aria-expanded={open} onFocus={()=>setOpen(true)} onChange={e=>{setQuery(e.target.value);setOpen(true);setSelection('')}} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.stopPropagation()}if(e.key==='Enter'&&open&&matches.length){e.preventDefault();choose(matches[0])}}}/><button type="button" aria-label="顯示地名搜尋結果" onClick={()=>setOpen(x=>!x)}>{open?'收起':'搜尋'}</button></div>
    {open&&<div id={'places-'+body} className="place-results">
      {error?<p role="alert">地名資料暫時無法載入。<button type="button" onClick={()=>setAttempt(x=>x+1)}>重試</button>仍可點球面或輸入座標。</p>:!data?<p role="status">載入地名…</p>:<>
        <p className="place-result-summary">{query.trim()?'顯示最多 8 個符合地名；輸入更多字可縮小範圍。':'常用地名 · 也可輸入其他正式名稱'}</p>
        {matches.length?<ul>{matches.map(p=><li key={p.id}><button type="button" onClick={()=>choose(p)}><strong>{p.name}{p.aliases.length>0&&<small> · {p.aliases.join('／')}</small>}</strong><span>{Math.abs(p.lat).toFixed(2)}°{p.lat>=0?'N':'S'} · {Math.abs(p.lon).toFixed(2)}°{p.lon>=0?'E':'W'} · {p.type}</span></button></li>)}</ul>:<p role="status">找不到符合的地名。試試正式英文名稱，或改用球面／座標選區。</p>}
        <small>定位地理中心；中文為本站搜尋別名。高解析度覆蓋另行檢查。</small>
      </>}
    </div>}
    <span className="place-selection-status" role="status">{selection}</span>
  </section>
}
