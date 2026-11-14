import {UI_MESSAGES} from './ui_messages.js'
import {REPORT_MESSAGES,REPORT_TEXT} from './report_catalog.js'
import {EN} from './catalog.js'
import {SERVER_TEXT,SERVER_PATTERNS} from './server_catalog.js'
export const LANGUAGE_KEY='analog-atlas:language:v1'
export function initialLanguage(search='',storage=null){
 const requested=new URLSearchParams(search).get('lang')
 if(requested==='en'||requested==='zh-Hant')return requested
 try{return storage?.getItem(LANGUAGE_KEY)==='en'?'en':'zh-Hant'}catch{return 'zh-Hant'}
}
let language=typeof window==='undefined'?'zh-Hant':initialLanguage(window.location.search,{getItem:key=>window.localStorage.getItem(key)})
const listeners=new Set()
export const getLanguage=()=>language
export const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)}
export function setLanguage(next){
 if(!['en','zh-Hant'].includes(next)||next===language)return
 language=next
 if(typeof window!=='undefined'){
  try{window.localStorage.setItem(LANGUAGE_KEY,next)}catch{}
  try{const url=new URL(window.location.href);url.searchParams.set('lang',next);window.history.replaceState(window.history.state,'',url)}catch{}
  document.documentElement.lang=next
 }
 listeners.forEach(fn=>fn())
}
const patterns=[
 [/^約 ([\d.]+) km 原始格網（全球粗篩）$/,(v)=>'Approx. '+v+' km native grid (global screening)'],
 [/^原始南北格距約 ([\d.]+) m；畫面網格間距約 ([\d.]+) m（地表模型含植被與建物）(?:；接縫缺測 ([\d.]+)% 以鄰近高程填補)?$/,(native,display,filled)=>'Approx. '+native+' m native north–south spacing; '+display+' m display spacing (surface model includes vegetation and buildings)'+(filled===undefined?'':'; '+filled+'% missing at seams filled from neighboring elevations')],

 [/^中央剖面：長度([\d.]+)公里；相對高程([-\d.]+)至([-\d.]+)公尺$/,(km,a,b)=>'Central profile: '+km+' km; relative elevation '+a+' to '+b+' m'],

 [/^(月球|火星)所選地區DEM 平面高程$/,(b)=>(b==='月球'?'Moon':'Mars')+' selected region DEM elevation map'],
 [/^(月球|火星)窗格 DEM 平面高程$/,(b)=>(b==='月球'?'Moon':'Mars')+' window DEM elevation map'],
 [/^地球候選 DEM 平面高程$/,()=> 'Earth candidate DEM elevation map'],

 [/^已定位 (.+)$/,(v)=>'Located '+v],
 [/^已收藏 (.+)$/,(v)=>'Saved '+v],
 [/^選區 (.+)$/,(v)=>'Selection '+v],
 [/^點此選取 (.+)$/,(v)=>'Select here '+v],
 [/^(月球|火星)平面定位圖：點選位置；方向鍵微調，Enter 選取$/,(b)=>(b==='月球'?'Moon':'Mars')+' locator: click a location; arrow keys adjust; Enter selects'],
 [/^(月球|火星)全球等距矩形定位影像$/,(b)=>(b==='月球'?'Moon':'Mars')+' global equirectangular locator image'],
 [/^平面定位候選：(.+)$/,(v)=>'Candidate on flat map: '+v],
 [/^(月球|火星)窗格 DEM 三維重建$/,(b)=>(b==='月球'?'Moon':'Mars')+' window DEM 3D reconstruction'],
 [/^(.*?)，北在上；相對窗格中位數高程 ([-\d.]+) 至 ([-\d.]+) 公尺$/,(l,a,b)=>translate(l,'en')+', north up; elevation relative to window median '+a+' to '+b+' m'],
 [/^([\d.]+)% 區域取樣格點符合指定條件$/,(v)=>v+'% of regional probes meet the criterion'],
 [/^([\d.]+)% 取樣點落在「已記錄有沙丘」的格網內。$/,(v)=>v+'% of probes fall in cells with published dune presence. '],
 [/^(\d+) 個候選聚合，放大並展開$/,(n)=>n+' clustered candidates; zoom and expand'],
 [/^(\d+) 個候選 · 點擊展開$/,(n)=>n+' candidates · Click to expand'],
 [/^定位候選：(.+)$/,(v)=>'Locate candidate: '+v],
 [/^(.+) · 點選放大$/,(v)=>v+' · Click to zoom'],
]
// Page-level catalogs (e.g. the microterrain scenario) register extra exact-match text and message templates.
const ALL_PATTERNS=[...patterns,...SERVER_PATTERNS]
const EXTRA_TEXT=Object.create(null),EXTRA_MESSAGES=Object.create(null)
export function registerCatalog(text={},messages={}){Object.assign(EXTRA_TEXT,text);Object.assign(EXTRA_MESSAGES,messages)}
function lookupExact(key){
 if(Object.hasOwn(EN,key))return EN[key]
 if(Object.hasOwn(REPORT_TEXT,key))return REPORT_TEXT[key]
 if(Object.hasOwn(SERVER_TEXT,key))return SERVER_TEXT[key]
 if(key in EXTRA_TEXT)return EXTRA_TEXT[key]
 for(const [regex,render] of ALL_PATTERNS){const match=key.match(regex);if(match)return render(...match.slice(1))}
 return undefined
}
export function translate(value,lang=language){
 if(typeof value!=='string'||lang!=='en')return value
 const key=value.trim()
 let translated=lookupExact(key)
 // Server labels such as "Nassau 附近 · 東 +1.5 km／北 -0.75 km" are joined with " · "; translate known parts only.
 if(translated===undefined&&key.includes(' · ')){
  const parts=key.split(' · '),mapped=parts.map(p=>{const t=lookupExact(p.trim());return t===undefined?p:t})
  if(mapped.some((p,i)=>p!==parts[i]))translated=mapped.join(' · ')
 }
 if(translated===undefined)return value
 return value.slice(0,value.indexOf(key))+translated+value.slice(value.indexOf(key)+key.length)
}
const translateChildren=v=>typeof v==='string'?translate(v):Array.isArray(v)?v.map(translateChildren):v
export function localizedProps(type,props){
 if(!props||language!=='en')return props
 // Display-only props: never translate values, keys, IDs, data or event payloads.
 const result={...props,children:translateChildren(props.children)}
 for(const key of ['aria-label','aria-description','title','alt','placeholder']){
  if(typeof props[key]==='string')result[key]=translate(props[key])
 }
 return result
}


// Tagged templates preserve each value as one token; replacement values are not re-parsed.
export function message(parts,...values){
 const key=parts.map((p,i)=>p+(i<values.length?'{'+i+'}':'')).join('')
 const template=language==='en'?(Object.hasOwn(REPORT_MESSAGES,key)?REPORT_MESSAGES[key]:Object.hasOwn(UI_MESSAGES,key)?UI_MESSAGES[key]:key in EXTRA_MESSAGES?EXTRA_MESSAGES[key]:undefined):undefined
 if(template!==undefined)return template.replace(/\{(\d+)\}/g,(_,i)=>String(translate(values[Number(i)])))
 return parts.map((p,i)=>p+(i<values.length?String(language==='en'?translate(values[i]):values[i]):'')).join('')
}
