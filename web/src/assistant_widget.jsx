// Site assistant (2026-11-14): a floating chat on every page. Answers come from a fine-tuned Llama 3.2 1B that reads
// passages retrieved from the TwinGround paper, its SI, the site text and the works it cites (RAG), and, on the results
// page, a brief of the candidate being viewed, so it can explain why that place was chosen. Every answer lists the
// passages it was given; numbers in brackets point to them.
import React, { useEffect, useRef, useState } from 'react'
import { MessageCircle, X, ArrowUp, RotateCcw, ExternalLink } from 'lucide-react'
import { getLanguage } from './i18n/core.js'
import './assistant_widget.css'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const HEAVY = new Set(['terrain', 'sampling_footprint', 'sampling_support', 'mesh', 'grid', 'display_grid', 'sampling'])

// Keep the evidence, drop meshes and rasters before sending the search answer.
function lightAnswer(data) {
  if (!data || !Array.isArray(data.matches)) return null
  const strip = o => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !HEAVY.has(k)))
  const { index_provenance, global_visual, ...rest } = data
  return { ...rest, window: strip(data.window), matches: data.matches.map(strip) }
}

function GENERAL() {
  return [
    tr('TwinGround 是做什麼的？怎麼用？', 'What does TwinGround do and how do I use it?'),
    tr('什麼是「地球上限」？', 'What is the "Earth ceiling"?'),
    tr('為什麼地球上找不到像月海玄武岩的地方？', 'Why does Earth have no match for lunar mare basalt?'),
    tr('網站用了哪些 NASA 資料？', 'Which NASA data does the site use?'),
  ]
}
function ABOUT_SITE() {
  return [
    tr('為什麼選這個地點？', 'Why was this site chosen?'),
    tr('這個地點哪些地方不符合？', 'What does not match at this site?'),
    tr('它跟其他候選比起來怎麼樣？', 'How does it compare with the other candidates?'),
    tr('這裡適合做什麼測試？', 'What could be tested here?'),
  ]
}

function Answer({ turn }) {
  const [open, setOpen] = useState(false)
  const cited = (turn.sources || []).filter(s => s.cited)
  const shown = open ? turn.sources || [] : cited
  return (
    <div className={`aw-turn is-bot${turn.failed ? ' is-failed' : ''}`}>
      <p>{turn.content}</p>
      {turn.sources?.length > 0 && (
        <div className="aw-sources">
          {shown.map(s => (
            <a key={s.n} href={s.url || undefined} target="_blank" rel="noreferrer" className={s.url ? '' : 'is-plain'}>
              <b>[{s.n}]</b> {s.title}{s.section && !['citation', 'full text'].includes(s.section) ? ` — ${s.section}` : ''}
              {s.url && <ExternalLink size={11} />}
            </a>
          ))}
          {turn.sources.length > cited.length && (
            <button type="button" onClick={() => setOpen(v => !v)}>
              {open ? tr('只看引用的資料', 'Cited sources only') : tr(`查看全部 ${turn.sources.length} 筆檢索資料`, `All ${turn.sources.length} retrieved sources`)}
            </button>
          )}
        </div>
      )}
      {turn.site && <small>{tr(`已參考：候選 #${turn.site}`, `Read: candidate #${turn.site}`)}</small>}
    </div>
  )
}

export default function AssistantWidget({ searchData, activeId, onResults }) {
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [useSite, setUseSite] = useState(true)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const matches = onResults && Array.isArray(searchData?.matches) ? searchData.matches : []
  const index = Math.max(0, matches.findIndex(m => m.id === activeId))
  const candidate = matches.length ? matches[index] : null

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [log, busy])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => {
    if (!open) return undefined
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  async function send(text) {
    const q = (text ?? draft).trim()
    if (!q || busy) return
    setDraft('')
    const withSite = useSite && candidate
    const userTurn = { role: 'user', content: q }
    const history = [...log.filter(t => !t.failed).map(t => ({ role: t.role, content: t.content })), userTurn].slice(-6)
    setLog(l => [...l, userTurn])
    setBusy(true)
    try {
      const r = await fetch('/api/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, lang: getLanguage() === 'en' ? 'en' : 'zh',
          site: withSite ? { answer: lightAnswer(searchData), index } : null }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.available === false || !j.answer) throw new Error(j.reason || j.error || `HTTP ${r.status}`)
      setLog(l => [...l, { role: 'assistant', content: j.answer, sources: j.sources, site: j.site_used ? index + 1 : null }])
    } catch (e) {
      setLog(l => [...l, { role: 'assistant', failed: true, content: tr(`抱歉，小助手暫時無法回答（${e.message}）。`, `Sorry, the assistant could not answer (${e.message}).`) }])
    } finally {
      setBusy(false)
    }
  }

  const suggestions = candidate && useSite ? ABOUT_SITE() : GENERAL()
  return (
    <>
      <button type="button" className={`aw-fab${open ? ' is-open' : ''}`} onClick={() => setOpen(v => !v)}
        aria-expanded={open} aria-label={open ? tr('關閉小助手', 'Close assistant') : tr('開啟小助手', 'Open assistant')}>
        {open ? <X size={20} /> : <MessageCircle size={20} />}
        {!open && <span>{tr('問小助手', 'Ask')}</span>}
      </button>
      {open && (
        <section className="aw-panel" role="dialog" aria-label={tr('TwinGround 小助手', 'TwinGround assistant')}>
          <header>
            <div>
              <b>{tr('TwinGround 小助手', 'TwinGround assistant')}</b>
              <small>{tr('根據論文與網站資料回答，附上來源', 'Answers from the paper and site, with sources')}</small>
            </div>
            {log.length > 0 && (
              <button type="button" onClick={() => setLog([])} aria-label={tr('清除對話', 'Clear chat')}><RotateCcw size={15} /></button>
            )}
          </header>
          {candidate && (
            <label className="aw-site">
              <input type="checkbox" checked={useSite} onChange={e => setUseSite(e.target.checked)} />
              <span>{tr(`一起參考目前的候選 #${index + 1}`, `Include the current candidate #${index + 1}`)}
                <em>{candidate.name}</em></span>
            </label>
          )}
          <div className="aw-log" ref={listRef} aria-live="polite">
            {log.length === 0 && (
              <div className="aw-suggest">
                <span>{tr('可以這樣問：', 'Try asking:')}</span>
                {suggestions.map(s => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            {log.map((t, i) => t.role === 'user'
              ? <div key={i} className="aw-turn is-user"><p>{t.content}</p></div>
              : <Answer key={i} turn={t} />)}
            {busy && <div className="aw-turn is-bot is-busy" aria-label={tr('思考中', 'Thinking')}><i /><i /><i /></div>}
          </div>
          <form className="aw-input" onSubmit={e => { e.preventDefault(); send() }}>
            <textarea ref={inputRef} rows={1} value={draft} maxLength={600}
              placeholder={tr('問任何關於 TwinGround 的問題…', 'Ask anything about TwinGround…')}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
            <button type="submit" disabled={busy || !draft.trim()} aria-label={tr('送出', 'Send')}><ArrowUp size={18} /></button>
          </form>
          <p className="aw-note">{tr('1B 小模型可能出錯，請以引用來源與結果頁數值為準。', 'A small 1B model can be wrong; check the cited sources and the values on the results page.')}</p>
        </section>
      )}
    </>
  )
}
