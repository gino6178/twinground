export function mapCoordinate(x,y) {
  if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error('Invalid map point')
  return {lat:Math.max(-89.5,Math.min(89.5,90-Math.max(0,Math.min(1,y))*180)),lon:Math.max(-180,Math.min(180,x*360-180))}
}
export function terrainRaster(terrain,scale=null) {
  const n=terrain?.size, h=terrain?.heights_m
  if(!Number.isInteger(n)||n<2||!Array.isArray(h)||h.length!==n*n||h.some(v=>!Number.isFinite(v)))return null
  const bound=Number.isFinite(scale)&&scale>0?scale:Math.max(300,...h.map(Math.abs))
  const rgba=new Uint8ClampedArray(n*n*4)
  const low=[38,58,70],mid=[112,136,151],high=[208,216,212]
  h.forEach((v,i)=>{const t=Math.max(-1,Math.min(1,v/bound));const a=t<0?low:mid,b=t<0?mid:high,f=t<0?t+1:t;for(let c=0;c<3;c++)rgba[4*i+c]=a[c]+(b[c]-a[c])*f;rgba[4*i+3]=255})
  return {size:n,rgba,bound,min:Math.min(...h),max:Math.max(...h)}
}
