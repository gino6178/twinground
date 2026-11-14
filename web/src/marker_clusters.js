/** Screen-space proximity components. Counts are marker counts, never ranks or geological sites. */
export function clusterScreenPoints(points,radius=28,preferredId=null) {
 if(!Number.isFinite(radius)||radius<=0)throw Error('Invalid clustering radius')
 const valid=points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))
 const parent=valid.map((_,i)=>i)
 const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i]}return i}
 const bins=new Map()
 for(let i=0;i<valid.length;i++){
  const p=valid[i],bx=Math.floor(p.x/radius),by=Math.floor(p.y/radius)
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const j of bins.get((bx+dx)+','+(by+dy))||[]){
   const q=valid[j]
   if((p.x-q.x)**2+(p.y-q.y)**2<=radius**2)parent[root(i)]=root(j)
  }
  const key=bx+','+by
  if(!bins.has(key))bins.set(key,[])
  bins.get(key).push(i)
 }
 const groups=new Map()
 valid.forEach((p,i)=>{const key=root(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p)})
 return [...groups.values()].map(members=>({members,representative:members.find(p=>p.id===preferredId)||members[0],x:members.reduce((n,p)=>n+p.x,0)/members.length,y:members.reduce((n,p)=>n+p.y,0)/members.length}))
}
