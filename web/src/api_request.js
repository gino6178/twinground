// Deadline covers headers AND JSON body. Also reject cancelled work when a
// transport ignores AbortSignal, so stale results cannot update the interface.
export async function requestJson(url,{signal,timeoutMs=30000,fetchImpl=fetch}={}){
 if(signal?.aborted)throw new DOMException('Request cancelled','AbortError')
 const controller=new AbortController()
 let rejectCancellation,timer
 const cancelled=new Promise((_,reject)=>{rejectCancellation=reject})
 const cancel=()=>{
  rejectCancellation(new DOMException('Request cancelled','AbortError'))
  controller.abort()
 }
 signal?.addEventListener('abort',cancel,{once:true})
 timer=setTimeout(()=>{
  rejectCancellation(new DOMException('Request timed out','TimeoutError'))
  controller.abort()
 },timeoutMs)
 try{
  return await Promise.race([(async()=>{
   const response=await fetchImpl(url,{signal:controller.signal})
   let data
   try{data=await response.json()}catch{
    if(controller.signal.aborted)await cancelled
    throw new Error(response.ok?'Invalid JSON response':'HTTP '+response.status)
   }
   if(controller.signal.aborted)await cancelled
   if(!response.ok)throw Object.assign(new Error(data?.error||'HTTP '+response.status),{status:response.status,serverMessage:typeof data?.error==='string'})
   return data
  })(),cancelled])
 }finally{
  clearTimeout(timer)
  signal?.removeEventListener('abort',cancel)
 }
}
