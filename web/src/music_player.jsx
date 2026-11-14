// Header music toggle: soundtrack from our 2025 Space Apps entry (Cosmic Seekers), one track per part of the site,
// cross-faded on navigation. Off until the visitor turns it on (browsers block autoplay); the choice is remembered.
import React, { useEffect, useState } from 'react'
import { getLanguage } from './i18n/core.js'
import './music_player.css'

const TRACKS = {
  home: { src: '/music/start.mp3', zh: 'Stardust Echoes', en: 'Stardust Echoes' },
  moon: { src: '/music/planet_rocky.mp3', zh: 'Cosmic Drift', en: 'Cosmic Drift' },
  mars: { src: '/music/planet_lava.mp3', zh: '星際深淵', en: 'Interstellar Abyss' },
  results: { src: '/music/music7.mp3', zh: 'Waves of Alpha', en: 'Waves of Alpha' },
  chat: { src: '/music/planet_ice.mp3', zh: '星海低語', en: 'Whispers of the Star Sea' },
}
const VOLUME = 0.35, KEY = 'analog-atlas-music'
// one shared player for the whole page, so the music survives header/landing remounts
const P = { el: null, src: null, fade: null }
const read = () => { try { return localStorage.getItem(KEY) === 'on' } catch { return false } }
const write = on => { try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* private mode */ } }

export function trackFor(stage, body) {
  if (stage === 2) return 'results'
  if (stage === 3) return 'chat'
  if (stage === 1) return body === 'mars' ? 'mars' : 'moon'
  return 'home'
}

export function MusicToggle({ track = 'home' }) {
  const [on, setOn] = useState(read)
  const en = getLanguage() === 'en'

  const ramp = (el, to, ms, done) => {
    clearInterval(P.fade)
    const from = el.volume, t0 = performance.now()
    P.fade = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      el.volume = from + (to - from) * k
      if (k >= 1) { clearInterval(P.fade); done?.() }
    }, 40)
  }

  // play / switch track (cross-fade through silence)
  useEffect(() => {
    if (!on) return
    if (!P.el) { P.el = new Audio(); P.el.loop = true; P.el.preload = 'none'; P.el.volume = 0 }
    const el = P.el, want = TRACKS[track] || TRACKS.home
    const start = () => {
      if (P.src !== want.src) { el.src = want.src; P.src = want.src }
      el.volume = 0
      el.play().then(() => ramp(el, VOLUME, 1200)).catch(() => {
        // autoplay blocked after a reload: start on the visitor's next interaction
        const once = () => { el.play().then(() => ramp(el, VOLUME, 1200)).catch(() => {}); window.removeEventListener('pointerdown', once) }
        window.addEventListener('pointerdown', once)
      })
    }
    if (!el.paused && P.src !== want.src) ramp(el, 0, 600, start)
    else if (el.paused) start()
  }, [on, track])

  useEffect(() => {
    if (on || !P.el) return
    const el = P.el
    ramp(el, 0, 500, () => el.pause())
  }, [on])

  const t = TRACKS[track] || TRACKS.home
  const title = (on ? (en ? `Now playing: ${t.en}` : `播放中：${t.zh}`) : (en ? 'Play the soundtrack' : '播放原聲帶'))
    + (en ? ' (Cosmic Seekers, 2025 Space Apps)' : '（Cosmic Seekers，2025 Space Apps）')
  return (
    <button type="button" className={`music-toggle${on ? ' is-on' : ''}`} aria-pressed={on} title={title} aria-label={title}
      onClick={() => { const v = !on; setOn(v); write(v) }}>
      <span className="music-bars" aria-hidden="true"><i /><i /><i /><i /></span>
      <span className="music-label">{on ? (en ? t.en : t.zh) : (en ? 'Music' : '音樂')}</span>
    </button>
  )
}
