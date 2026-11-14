// Runs only through diagnostics/graphics.html, never the normal entry.
const params=new URLSearchParams(location.search)
const graphics=params.get('graphics')==='unavailable'?'unavailable':'available'
const storage=['denied','quota'].includes(params.get('storage'))?params.get('storage'):'normal'
const contexts=new Map()
let created=0,lost=0,denied=0,requestedLoss=0
const status=document.getElementById('fault-status')
const show=()=>{status.textContent='WebGL contexts created: '+created+'; live: '+contexts.size+'; context-loss events: '+lost+'; blocked context requests: '+denied+'; loss requests: '+requestedLoss+'.'}
const original=HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext=function(type,...args){
 const webgl=['webgl','webgl2','experimental-webgl'].includes(type)
 if(webgl&&graphics==='unavailable'){denied++;show();return null}
 const context=original.call(this,type,...args)
 if(webgl&&context&&!contexts.has(this)){
  created++;contexts.set(this,context);show()
  this.addEventListener('webglcontextlost',()=>{lost++;contexts.delete(this);show()},{once:true})
 }
 return context
}
if(storage==='denied'){
 Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Diagnostic storage access denied','SecurityError')}})
}else if(storage==='quota'){
 const real=window.localStorage
 Object.defineProperty(window,'localStorage',{configurable:true,value:{
  getItem:key=>real.getItem(key),
  setItem(){throw new DOMException('Diagnostic quota exhausted','QuotaExceededError')},
  removeItem(){throw new DOMException('Diagnostic writes blocked','QuotaExceededError')},
 }})
}
document.getElementById('fault-mode').textContent='Graphics: '+graphics+'; storage: '+storage+'. This page does not change browser permissions.'
document.getElementById('lose-graphics').disabled=graphics==='unavailable'
document.getElementById('lose-graphics').addEventListener('click',()=>{
 requestedLoss=0
 for(const [canvas,context]of [...contexts]){
  if(!canvas.isConnected){contexts.delete(canvas);continue}
  const extension=context.getExtension('WEBGL_lose_context')
  if(extension){requestedLoss++;extension.loseContext()}
 }
 show()
})
const networkMode=document.getElementById('network-mode')
if(['normal','offline','slow','stall'].includes(params.get('network')))networkMode.value=params.get('network')
const realFetch=window.fetch.bind(window)
let networkRequests=0,networkFailures=0,networkDelays=0,networkStalls=0
const networkStatus=document.getElementById('network-status')
const showNetwork=()=>{networkStatus.textContent=`Intercepted API requests: ${networkRequests}; failed: ${networkFailures}; delayed: ${networkDelays}; stalled: ${networkStalls}. Faults apply only to status, window and search requests.`}
window.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href)
 if(url.origin!==location.origin||!/^\/api\/(status|window|search|mars-window|mars-search)$/.test(url.pathname))return realFetch(input,options)
 networkRequests++
 const mode=networkMode.value
 if(mode==='offline'){networkFailures++;showNetwork();throw new TypeError('Diagnostic network failure')}
 if(mode==='stall'){networkStalls++;showNetwork();return new Promise(()=>{})}
 if(mode==='slow'){
  networkDelays++;showNetwork()
  // Deliberately ignore cancellation to exercise stale-response protection.
  const response=await realFetch(input,{...options,signal:undefined})
  await new Promise(resolve=>setTimeout(resolve,2000))
  return response
 }
 showNetwork();return realFetch(input,options)
}
showNetwork();show()
import('./main.jsx').catch(error=>{status.textContent='Application failed to load: '+error.message})
