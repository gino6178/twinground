import React,{useState,useRef,useEffect} from 'react'
import {getLanguage} from './i18n/core.js'
import {INITIAL_IMAGE_VIEW,imageView,zoomImage} from './imagery_view.js'
import './imagery_comparison.css'
const text=(zh,en)=>getLanguage()==='en'?en:zh
function ImagePanel({url,label,credit,view,setView}){
 const [state,setState]=useState(url?'loading':'missing')
 const [attempt,setAttempt]=useState(0)
 const drag=useRef(null)
 const pan=(x,y)=>setView(v=>imageView({...v,x:v.x+x,y:v.y+y}))
 return <figure className="image-compare-panel"><figcaption><strong>{label}</strong><span>{credit}</span></figcaption>
 <div className="image-compare-window" tabIndex={url?0:undefined} role={url?'group':undefined} aria-label={label+' · '+text('方向鍵平移；加減鍵縮放；Home重設','Arrow keys pan; plus/minus zoom; Home resets')}
  onKeyDown={e=>{const moves={ArrowLeft:[.08,0],ArrowRight:[-.08,0],ArrowUp:[0,.08],ArrowDown:[0,-.08]};if(moves[e.key]){e.preventDefault();pan(...moves[e.key])}else if(['+','=','-','Home'].includes(e.key)){e.preventDefault();setView(v=>e.key==='Home'?INITIAL_IMAGE_VIEW:zoomImage(v,e.key==='-'?.8:1.25))}}}
  onPointerDown={e=>{if(state!=='ready'||e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,x:e.clientX,y:e.clientY}}}
  onPointerMove={e=>{if(!drag.current||drag.current.id!==e.pointerId)return;const rect=e.currentTarget.getBoundingClientRect();pan((e.clientX-drag.current.x)/rect.width,(e.clientY-drag.current.y)/rect.height);drag.current={id:e.pointerId,x:e.clientX,y:e.clientY}}}
  onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}} onLostPointerCapture={()=>{drag.current=null}}>
  {url&&<img key={attempt} src={url+(attempt?'&retry='+attempt:'')} alt={label} draggable="false" onLoad={()=>setState('ready')} onError={()=>setState('error')} style={{visibility:state==='ready'?'visible':'hidden',transform:'translate('+view.x*100+'%,'+view.y*100+'%) scale('+view.zoom+')'}}/>}
  {state!=='ready'&&<div className="image-compare-placeholder" role="status">{state==='missing'?text('此火星選區尚無可追溯的窗格影像。保留高程比對，不使用其他地點代替。','No traceable window imagery is connected for this Mars selection. Elevation comparison remains available; another location is not substituted.'):state==='loading'?text('正在載入來源影像…','Loading source imagery…'):text('來源影像暫不可用，地形比對仍可使用。','Source imagery is unavailable; terrain comparison remains usable.')}{state==='error'&&<button type="button" onClick={()=>{setState('loading');setAttempt(n=>n+1)}}>{text('重試影像','Retry image')}</button>}</div>}
  <span className="image-north" aria-hidden="true">N ↑</span>
 </div></figure>
}
function Pair({query,active,moonUrl,earthUrl}){
 const [view,setView]=useState(INITIAL_IMAGE_VIEW)
 const mars=query.body==='mars'
 const [marsImage,setMarsImage]=useState(null)
 const [marsError,setMarsError]=useState(false)
 const [retry,setRetry]=useState(0)
 const marsBase='/api/mars-imagery?lat='+query.lat+'&lon='+query.lon+'&size_km='+query.patch_km
 useEffect(()=>{
  if(!mars)return
  const abort=new AbortController();setMarsImage(null);setMarsError(false)
  fetch(marsBase,{signal:abort.signal}).then(r=>{if(!r.ok)throw new Error('Imagery metadata unavailable');return r.json()}).then(setMarsImage).catch(e=>{if(e.name!=='AbortError')setMarsError(true)})
  return()=>abort.abort()
 },[mars,marsBase,retry])
 const referenceUrl=mars?(marsImage?.available?marsBase+'&format=png&version='+marsImage.render_sha256:null):moonUrl
 return <><p>{text('同步顯示同一相對位置。拖曳任一影像可同步平移；用按鈕或鍵盤縮放。放大不會增加來源細節。','Both images share the same relative view. Drag either image to pan both; use buttons or the keyboard to zoom. Magnification does not add source detail.')}</p>
 <div className="image-compare-controls" role="group" aria-label={text('影像同步控制','Linked image controls')}><button type="button" disabled={view.zoom>=8} onClick={()=>setView(v=>zoomImage(v,1.5))}>{text('放大','Zoom in')}</button><button type="button" disabled={view.zoom<=1} onClick={()=>setView(v=>zoomImage(v,1/1.5))}>{text('縮小','Zoom out')}</button><button type="button" onClick={()=>setView(INITIAL_IMAGE_VIEW)}>{text('重設影像','Reset images')}</button><output aria-live="polite">{view.zoom.toFixed(1)}× · {text('可視寬約','View width approx.')} {(query.patch_km/view.zoom).toFixed(1)} km</output></div>
 <div className="image-compare-pair">
 {mars&&!marsImage?<div className="image-compare-panel" role="status">{marsError?text('無法讀取火星影像覆蓋資料。','Mars imagery coverage could not be loaded.'):text('正在確認火星影像覆蓋…','Checking Mars imagery coverage…')}{marsError&&<button type="button" onClick={()=>setRetry(n=>n+1)}>{text('重試','Retry')}</button>}</div>:<ImagePanel key={referenceUrl||'missing'} url={referenceUrl} label={(mars?text('火星選區影像','Mars selection imagery'):text('月球選區影像','Moon selection imagery'))+' · '+query.lat.toFixed(2)+', '+query.lon.toFixed(2)} credit={mars?(marsImage?.attribution||text('影像缺資料','No imagery coverage')):'NASA SVS / LROC WAC · '+text('融合展示影像','blended display imagery')} view={view} setView={setView}/>}
 <ImagePanel url={earthUrl} label={text('地球候選影像','Earth candidate imagery')+' · '+active.center.latitude.toFixed(2)+', '+active.center.longitude_east.toFixed(2)} credit="Esri, Vantor / Maxar, Earthstar Geographics, GIS User Community" view={view} setView={setView}/>
 </div>{marsImage?.available&&<div className="mars-image-coverage"><p>{text('火星有效影像格','Valid Mars image pixels')}: {(marsImage.valid_fraction*100).toFixed(2)}% · {text('來源格距','Source grid')}: {marsImage.source.source_grid_m[0].toFixed(2)} m · {text('顯示格距','Display grid')}: {marsImage.display_spacing_m.toFixed(2)} m</p><p>{text('棋盤格是缺資料，未填補。有效比例按投影後顯示格計算；不代表整個來源完整度。灰階依本窗格P2–P98拉伸，不是真實色彩或材質預測。','Checkerboard areas have no data and are not filled. Coverage counts projected display pixels, not source completeness. Grayscale uses a per-window P2–P98 stretch, not natural color or material prediction.')}</p></div>}<p className="image-compare-limit">{text('北在上；兩側為相同名義公里範圍，並非逐像元跨星球配準。月球為切平面取樣的融合貼圖，WAC明暗細節不可用時退回全球色圖；地球為依服務回傳範圍裁切的經緯度影像。月／地球來源原生解析度、日期與精細有效範圍未逐像元確認；不能判定相同材質。','North up; the windows share a nominal width in kilometers, not pixel-level cross-planet registration. Moon imagery blends tangent-plane samples, falling back to global color if WAC detail is unavailable. Earth imagery is cropped using the actual extent returned by its service. Moon/Earth native resolution, acquisition date and fine validity coverage are not verified per pixel; matching materials cannot be inferred.')}</p>
 <a href="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" target="_blank" rel="noreferrer">Esri World Imagery</a> · <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">NASA SVS / LROC</a></>
}
export function ImageryComparison(props){
 const [open,setOpen]=useState(false)
 const identity=[props.query.body,props.query.lat,props.query.lon,props.query.patch_km,props.active.id].join(':')
 return <details className="linked-imagery" onToggle={e=>setOpen(e.currentTarget.open)}><summary>{text('2D 影像並排｜同步縮放與平移','2D imagery comparison · linked zoom and pan')}</summary>{open&&<Pair key={identity} {...props}/>}</details>
}
