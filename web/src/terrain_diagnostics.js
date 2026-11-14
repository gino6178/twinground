export function terrainDiagnostics(terrain, km) {
  const n=terrain?.size, values=terrain?.heights_m
  if(!Number.isInteger(n)||n<3||values?.length!==n*n||!values.every(Number.isFinite)||!(km>0)) return null
  const sorted=[...values].sort((a,b)=>a-b)
  const median=(sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.ceil((sorted.length-1)/2)])/2
  const spacing=km*1000/(n-1), edges=[0,2,5,10,20,30,45,90], counts=Array(7).fill(0)
  let samples=0
  for(let y=1;y<n-1;y++)for(let x=1;x<n-1;x++){
    const dx=(values[y*n+x+1]-values[y*n+x-1])/(2*spacing)
    const dy=(values[(y+1)*n+x]-values[(y-1)*n+x])/(2*spacing)
    const slope=Math.atan(Math.hypot(dx,dy))*180/Math.PI
    const bin=edges.findIndex((e,i)=>i>0&&slope<e)
    counts[bin<0?6:bin-1]++;samples++
  }
  const y=(n-1)/2, lo=Math.floor(y), hi=Math.ceil(y)
  const profile=Array.from({length:n},(_,x)=>((values[lo*n+x]+values[hi*n+x])/2)-median)
  return {profile,spacing_m:spacing,median_m:median,edges,percent:counts.map(c=>100*c/samples),samples}
}
