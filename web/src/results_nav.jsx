// Section navigation for the results page: a sticky row of jump links with the current section marked and a thin
// reading-progress line. Sections are looked up in the DOM, so panels that are not rendered get no link.
import React, { useEffect, useRef, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import { useLanguage } from './i18n/language.jsx'

const SECTIONS = [
  ['.glance', '候選摘要', 'Summary'],
  ['#current-terrain-comparison', '3D 對照', '3D comparison'],
  ['#conditions-panel', '條件對照', 'Conditions'],
  ['#facets-panel', '十個面向', 'Ten facets'],
  ['#resource-panel', '衛星與雷達', 'Satellite and radar'],
  ['#physical-match-panel', '物理相符', 'Physical match'],
  ['.lavatube-panel', '熔岩管', 'Lava tubes'],
  ['.terrain-diagnostics', '地形細節', 'Terrain detail'],
]

export function ResultsNav({ signal }) {
  useLanguage()
  const en = getLanguage() === 'en'
  const [present, setPresent] = useState([])
  const [current, setCurrent] = useState(0)
  const bar = useRef(null), row = useRef(null)

  // Panels arrive after their data, so look again for a few seconds after each change of candidate.
  useEffect(() => {
    const scan = () => setPresent(prev => {
      const next = SECTIONS.map((s, i) => (document.querySelector(s[0]) ? i : -1)).filter(i => i >= 0)
      return next.join() === prev.join() ? prev : next
    })
    scan()
    const timer = setInterval(scan, 800), stop = setTimeout(() => clearInterval(timer), 12000)
    return () => { clearInterval(timer); clearTimeout(stop) }
  }, [signal])

  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      const doc = document.documentElement, span = Math.max(1, doc.scrollHeight - window.innerHeight)
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, Math.max(0, window.scrollY / span))})`
      let hit = present[0] ?? 0
      for (const i of present) {
        const el = document.querySelector(SECTIONS[i][0])
        if (el && el.getBoundingClientRect().top <= 130) hit = i
      }
      setCurrent(hit)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    update()
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(frame) }
  }, [present])

  // Keep the current link in view when the row scrolls sideways on a phone.
  useEffect(() => {
    const host = row.current, link = host?.querySelector('[aria-current="true"]')
    if (!host || !link || host.scrollWidth <= host.clientWidth) return
    host.scrollTo({ left: link.offsetLeft - (host.clientWidth - link.offsetWidth) / 2, behavior: 'smooth' })
  }, [current])

  if (present.length < 2) return null
  const go = i => {
    const el = document.querySelector(SECTIONS[i][0])
    if (!el) return
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' })
  }
  return <nav className="results-nav" aria-label={en ? 'Sections of this result' : '結果頁章節'}>
    <div className="results-nav-row" ref={row}>
      {present.map(i => <button key={i} type="button" aria-current={i === current ? 'true' : undefined} onClick={() => go(i)}>{en ? SECTIONS[i][2] : SECTIONS[i][1]}</button>)}
    </div>
    <i className="results-nav-progress" ref={bar} aria-hidden="true" />
  </nav>
}
