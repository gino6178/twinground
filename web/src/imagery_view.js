export const INITIAL_IMAGE_VIEW=Object.freeze({zoom:1,x:0,y:0})
export function imageView(view){
 const finite=(n,fallback)=>Number.isFinite(n)?n:fallback
 const zoom=Math.max(1,Math.min(8,finite(view.zoom,1)))
 if(zoom===1)return {...INITIAL_IMAGE_VIEW}
 const bound=(zoom-1)/2
 return {zoom,x:Math.max(-bound,Math.min(bound,finite(view.x,0))),y:Math.max(-bound,Math.min(bound,finite(view.y,0)))}
}
export function zoomImage(view,factor){
 const zoom=Math.max(1,Math.min(8,view.zoom*factor))
 return imageView({zoom,x:view.x*zoom/view.zoom,y:view.y*zoom/view.zoom})
}
