import React,{useEffect,useRef,useState} from 'react'
import {mapCoordinate,terrainRaster} from './flat_view.js'
export function useFlatView(){
  const [flat,setFlat]=useState(()=>new URLSearchParams(location.search).get('view')==='2d')
  return [flat,setFlat]
}
export function ViewToggle({flat,onChange}){
 return <button type="button" className="flat-view-toggle" aria-label={flat?'切換為 3D 顯示':'切換為 2D 顯示'} onClick={()=>onChange(!flat)}>{flat?'3D':'2D'}</button>
}
export function FlatPlanet({body,selected,onPick}){
 const point=selected||{lat:0,lon:0}
 const name=body==='mars'?'火星':'月球'
 return <div className="flat-planet"><div className="flat-world-map" role="button" tabIndex={0} aria-label={name+'平面定位圖：點選位置；方向鍵微調，Enter 選取'} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();const p=mapCoordinate((e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height);onPick?.(p.lat,p.lon)}} onKeyDown={e=>{const d=e.shiftKey?1:.1;const moves={ArrowUp:[d,0],ArrowDown:[-d,0],ArrowLeft:[0,-d],ArrowRight:[0,d]};if(moves[e.key]){e.preventDefault();const [a,b]=moves[e.key];onPick?.(Math.max(-89.5,Math.min(89.5,point.lat+a)),Math.max(-180,Math.min(180,point.lon+b)))}else if(e.key==='Enter'||e.key===' '){e.preventDefault();onPick?.(point.lat,point.lon)}}}>
 <img src={body==='mars'?'/mars-viking.jpg':'/moon-color.webp'} alt={name+'全球等距矩形定位影像'} draggable="false"/>
 <span className="flat-map-marker" style={{left:(point.lon+180)/360*100+'%',top:(90-point.lat)/180*100+'%'}}/>
 </div><p>2D 定位 · 北在上 · 點選位置或使用地名／座標選區</p></div>
}
export function FlatTerrain({terrain,heightScaleM,label}){
 const ref=useRef(null);const raster=terrainRaster(terrain,heightScaleM)
 useEffect(()=>{if(!raster||!ref.current)return;const context=ref.current.getContext('2d');if(context)context.putImageData(new ImageData(raster.rgba,raster.size,raster.size),0,0)},[terrain,heightScaleM])
 if(!raster)return <p role="status">高程資料不完整，無法繪製平面地形。</p>
 return <figure className="flat-terrain"><canvas ref={ref} width={raster.size} height={raster.size} role="img" aria-label={(label||'地形')+'，北在上；相對窗格中位數高程 '+raster.min.toFixed(1)+' 至 '+raster.max.toFixed(1)+' 公尺'}/><figcaption>北 ↑ · DEM 相對高程（m）<span className="flat-elevation-scale"/><span className="flat-elevation-labels"><span>−{Math.round(raster.bound)}</span><span>0</span><span>+{Math.round(raster.bound)}</span></span>以窗格中位數為零；配色不代表材質。</figcaption></figure>
}
export function FlatEarth({matches,activeId,onActive}){
 return <div className="flat-planet"><div className="flat-world-map"><img src="/earth-color.jpg" alt="地球全球等距矩形定位影像" draggable="false"/>{matches.map(row=><button type="button" className="flat-map-marker" key={row.id} aria-pressed={row.id===activeId} aria-label={'平面定位候選：'+row.center.latitude.toFixed(2)+', '+row.center.longitude_east.toFixed(2)} title={row.name} style={{left:(row.center.longitude_east+180)/360*100+'%',top:(90-row.center.latitude)/180*100+'%'}} onClick={()=>onActive(row.id)}/>)}</div><p>2D 定位 · 北在上 · 紅點可切換候選；重疊點可從候選清單選取。</p></div>
}
