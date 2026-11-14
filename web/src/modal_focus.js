import {useEffect,useRef} from 'react'

export function usePageHeading(){
 const heading=useRef(null)
 useEffect(()=>{heading.current?.focus({preventScroll:true})},[])
 return heading
}

// The dialog is portaled to body. Keep background siblings inert while open,
// preserve their prior states, and restore the invoking control on close.
export function useModalFocus(open,dialogRef,onClose){
 const closeRef=useRef(onClose)
 closeRef.current=onClose
 useEffect(()=>{
  if(!open||!dialogRef.current)return
  const dialog=dialogRef.current,previous=document.activeElement
  let portal=dialog
  while(portal.parentElement&&portal.parentElement!==document.body)portal=portal.parentElement
  const background=[...document.body.children].filter(node=>node!==portal)
  const prior=background.map(node=>[node,node.inert])
  const overflow=document.body.style.overflow
  background.forEach(node=>{node.inert=true})
  document.body.style.overflow='hidden'
  const controls=()=>[...dialog.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]')]
   .filter(node=>!node.disabled&&node.tabIndex>=0&&!node.closest('[inert]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden')
  const initial=()=>controls()[0]||dialog
  initial().focus()
  const keydown=event=>{
   if(event.key==='Escape'){
    event.preventDefault();event.stopPropagation();closeRef.current();return
   }
   if(event.key!=='Tab')return
   const items=controls(),first=items[0]||dialog,last=items.at(-1)||dialog
   const active=document.activeElement
   if(!items.length||!dialog.contains(active)||active===dialog||
      (event.shiftKey&&active===first)||(!event.shiftKey&&active===last)){
    event.preventDefault();(event.shiftKey?last:first).focus()
   }
  }
  const contain=event=>{if(!dialog.contains(event.target))initial().focus()}
  document.addEventListener('keydown',keydown,true)
  document.addEventListener('focusin',contain)
  return()=>{
   document.removeEventListener('keydown',keydown,true)
   document.removeEventListener('focusin',contain)
   prior.forEach(([node,inert])=>{node.inert=inert})
   document.body.style.overflow=overflow
   if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus()
  }
 },[open,dialogRef])
}
