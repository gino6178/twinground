import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowDown, ArrowRight, MessageCircle, Layers } from 'lucide-react'
import { LanguageSwitch } from './i18n/language.jsx'
import { MusicToggle } from './music_player.jsx'
import { getLanguage } from './i18n/core.js'
import { createEntryScene } from './entry_scene.js'
import { MissionStart } from './mission_start.jsx'
import './landing.css'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)

// Section parts rise into view once, staggered. They stay visible without JavaScript and with reduced motion: the
// hidden start state only applies after this hook adds .reveal-ready.
function useReveal(root) {
  useEffect(() => {
    const el = root.current
    if (!el || !('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.classList.add('reveal-ready')
    const io = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target) }
    }), { rootMargin: '0px 0px -6% 0px', threshold: 0.08 })
    el.querySelectorAll('[data-reveal]').forEach(item => io.observe(item))
    return () => io.disconnect()
  }, [])
}

const delay = ms => ({ '--d': `${ms}ms` })

function EntryCosmos({ onPick }) {
  const host = useRef(null), label = useRef(null), pickRef = useRef(onPick)
  pickRef.current = onPick
  const [hover, setHover] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let scene
    try {
      scene = createEntryScene({
        container: host.current, mobile: window.innerWidth < 768,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        onPick: body => pickRef.current(body),
        onHover: (body, at) => {
          setHover(current => current === body ? current : body)
          if (at && label.current) label.current.style.transform = `translate(${at.x}px, ${at.y}px)`
        },
      })
    } catch { setFailed(true); return }
    // The scene drifts back as the reader scrolls, fades out before the first opaque section covers it, then stops
    // rendering. The Mission Start screen sits above the hero, so scroll is measured from its bottom edge, and the
    // scene does not render while that screen still fills the viewport.
    const onScroll = () => {
      const start = document.getElementById('mission-start')?.offsetHeight || 0
      const y = window.scrollY
      const p = Math.min(1, Math.max(0, y - start) / Math.max(1, window.innerHeight))
      scene.setScroll(p)
      scene.setVisible(p < 0.98 && y + window.innerHeight > start + 1)
      if (host.current) host.current.style.opacity = String(1 - Math.min(1, Math.max(0, (p - 0.3) / 0.6)))
    }
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll()
    // The start screen unmounts after START MISSION, which changes the offset without a scroll event.
    const poll = setInterval(onScroll, 1000)
    return () => { window.removeEventListener('scroll', onScroll); clearInterval(poll); scene.dispose() }
  }, [])
  return <div className={`landing-scene ${failed ? 'is-fallback' : ''}`} aria-hidden="true">
    <div className="landing-canvas" ref={host} />
    <div className={`landing-scene-label ${hover ? 'is-on' : ''}`} ref={label}>{hover === 'mars' ? tr('火星 · 點選進入', 'Mars · click to enter') : hover === 'moon' ? tr('月球 · 點選進入', 'Moon · click to enter') : ''}</div>
  </div>
}

// Landing page: the solar system is the way in (click the Moon or Mars), then the two worlds and the footer.
// Worked examples and validation numbers belong on the methods page, not here.
export function Landing({ Globe, onStart, onStartMars, onChat, onAsk, onGame, candidatesHref, onPickMoon, onPickMars, selected, selectedMars }) {
  const en = getLanguage() === 'en'
  const lang = en ? 'en' : 'zh'
  const method = '/technology/paper-en.html'
  const root = useRef(null)
  useReveal(root)
  return (
    <motion.main key="hero" ref={root} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="landing" aria-label={tr('選擇月球或火星', 'Choose the Moon or Mars')}>
      <EntryCosmos onPick={body => (body === 'mars' ? onStartMars() : onStart())} />
      <MissionStart onStart={onGame} />

      <header id="landing-hero" className="landing-hero">
        <nav className="landing-nav" aria-label={tr('網站導覽', 'Site navigation')}>
          <span className="landing-brand">TwinGround</span>
          <div className="landing-links">
            <a href="#landing-worlds">{tr('月球與火星', 'Moon and Mars')}</a>
            <a href={method}>{tr('方法與原理', 'Methods')}</a>
          </div>
          <MusicToggle track="home" />
          <LanguageSwitch />
        </nav>

        <div className="landing-hero-text">
          <h1>{en ? <><span>Find the Moon</span> <span>and Mars on Earth</span></> : <><span>在地球上找出</span><span>像月球與火星的地方</span></>}</h1>
          <p className="landing-lead">{tr(
            '在月球或火星上選一塊地，先找出地球上屬於同類環境與地質場域的地方，再依地形排序，並排比較兩邊的 3D 地形，最後以太空人的視角走進去。',
            'Pick a patch of the Moon or Mars. TwinGround first finds places on Earth in the same kind of environmental and geological setting, ranks them by terrain, sets the two side by side in 3D, and lets you walk in as an astronaut.')}</p>
          <div className="landing-cta">
            <button type="button" className="landing-primary" onClick={onStart}>{tr('從月球開始', 'Start on the Moon')} <ArrowRight size={18} aria-hidden="true" /></button>
            <button type="button" className="landing-secondary" onClick={onStartMars}>{tr('從火星開始', 'Start on Mars')}</button>
            {onChat && <button type="button" className="landing-secondary" onClick={onChat}>{tr('用對話描述條件', 'Describe it in words')}</button>}
          </div>
          <p className="landing-note">{tr('2026 NASA Space Apps Challenge 參賽作品，題目：', '2026 NASA Space Apps Challenge entry for ')}<a href="https://www.spaceappschallenge.org/2026/challenges/permanent-moon-base-locations-and-mars/" target="_blank" rel="noreferrer">Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars</a></p>
        </div>
        <div className="landing-features">
          {onAsk && <button type="button" className="landing-feature landing-ask" onClick={onAsk}>
            <span className="landing-feature-icon"><MessageCircle size={24} aria-hidden="true" /></span>
            <span className="landing-feature-text"><b>{tr('直接詢問 Agent', 'Ask the Agent')}</b><small>{tr('回答方法、資料與結果問題的 AI 助手。', 'An AI assistant for guidance and questions.')}</small></span>
          </button>}
          {candidatesHref && <a className="landing-feature landing-candidates" href={candidatesHref}>
            <span className="landing-feature-icon"><Layers size={24} aria-hidden="true" /></span>
            <span className="landing-feature-text"><b>{tr('搜尋候選地點', 'Search Candidates')}</b><small>{tr('尋找並比較候選地點。', 'A way to find and compare candidate locations.')}</small></span>
          </a>}
        </div>
        <a className="landing-cue" href="#landing-worlds"><ArrowDown size={16} aria-hidden="true" />{tr('或直接在球面上選點', 'Or pick a spot on the globe')}</a>
      </header>

      <section id="landing-worlds" className="landing-worlds" aria-labelledby="landing-worlds-title">
        <h2 id="landing-worlds-title" data-reveal>{tr('或直接在球面上點一個地點', 'Or pick a spot right on the globe')}</h2>
        <div className="landing-pair">
          <article className="landing-world is-moon" data-reveal style={delay(80)}>
            <div className="landing-orb"><Globe selected={selected} onPick={onPickMoon} compact /></div>
            <h3>{tr('月球', 'Moon')}</h3>
            <p>{tr('LRO LOLA 全球高程與 LROC 影像，另有六處 NAC 高解析地形。', 'LRO LOLA global elevation and LROC imagery, plus six high-resolution NAC terrain models.')}</p>
            <button type="button" className="landing-text-button" onClick={onStart}>{tr('選擇月球地區', 'Choose a Moon region')} <ArrowRight size={18} aria-hidden="true" /></button>
          </article>
          <article className="landing-world is-mars" data-reveal style={delay(160)}>
            <div className="landing-orb"><Globe body="mars" selected={selectedMars} onPick={onPickMars} compact /></div>
            <h3>{tr('火星', 'Mars')}</h3>
            <p>{tr('MGS MOLA 全球高程，Jezero 等地另有 CTX 與 HiRISE 局部地形。', 'MGS MOLA global elevation, with CTX and HiRISE terrain for Jezero and other sites.')}</p>
            <button type="button" className="landing-text-button" onClick={onStartMars}>{tr('選擇火星地區', 'Choose a Mars region')} <ArrowRight size={18} aria-hidden="true" /></button>
          </article>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-brand" data-reveal>
          <b>TwinGround</b>
          <p className="brand-tagline">{tr('在地球上找出月球與火星的雙胞胎', 'Finding Earth’s twins of the Moon and Mars')}</p>
          <p>{tr('候選地點是同類場域的提案，實測物理性質（例如化學成分）不一定相符，也不代表已驗證的類比場址。本網站未經 NASA 背書。', 'Candidates are proposals of the same kind of setting; measured properties such as chemistry may not match, and they are not validated analog sites. This site is not endorsed by NASA.')}</p>
        </div>
        <div className="landing-footer-links" data-reveal style={delay(80)}>
          <div><b>{tr('開始', 'Start')}</b><button type="button" onClick={onStart}>{tr('月球', 'Moon')}</button><button type="button" onClick={onStartMars}>{tr('火星', 'Mars')}</button></div>
          <div><b>{tr('了解', 'Learn')}</b><a href={method}>{tr('方法與原理', 'Methods')}</a></div>
          <div><b>NASA</b><a href="https://science.nasa.gov/solar-system/analog-explorer/" target="_blank" rel="noreferrer">Planetary Analog Explorer</a><a href="https://www.nasa.gov/analog-missions/" target="_blank" rel="noreferrer">Analog Missions</a></div>
          <div><b>{tr('資料', 'Data')}</b><a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">{tr('月球貼圖（SVS）', 'Moon maps (SVS)')}</a><a href="https://maps.jpl.nasa.gov/tmaps/mars.html" target="_blank" rel="noreferrer">{tr('火星貼圖（JPL）', 'Mars maps (JPL)')}</a></div>
        </div>
      </footer>
    </motion.main>
  )
}
