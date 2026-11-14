/* Analog Atlas static-page i18n (v2).
 * Same language rule as the explorer (web/src/i18n/core.js): ?lang=en|zh-Hant wins, otherwise the
 * saved choice in localStorage 'analog-atlas:language:v1', otherwise Traditional Chinese.
 * Chinese mode is an identity: __t returns its input and __m rebuilds the original template.
 * English mode looks strings up in dictionaries registered with ATLAS_I18N.add(); unknown text is
 * left unchanged (never guessed). Only display text and display attributes are translated;
 * values, ids, classes, data-* and exported data are not touched.
 * English strings are machine-proposed translations, not expert reviewed (see i18n_v2 evidence).
 */
(function () {
  var KEY = 'analog-atlas:language:v1'
  var forced = document.documentElement.getAttribute('data-atlas-lang')
  function initial() {
    if (forced === 'en' || forced === 'zh-Hant') return forced
    var q = null
    try { q = new URLSearchParams(window.location.search).get('lang') } catch (e) {}
    if (q === 'en' || q === 'zh-Hant') return q
    try { return window.localStorage.getItem(KEY) === 'en' ? 'en' : 'zh-Hant' } catch (e) { return 'zh-Hant' }
  }
  var lang = initial()
  var dict = Object.create(null), messages = Object.create(null), patterns = []
  function exact(key) {
    if (key in dict) return dict[key]
    for (var i = 0; i < patterns.length; i++) {
      var m = key.match(patterns[i][0])
      if (m) return patterns[i][1].apply(null, m.slice(1))
    }
    return undefined
  }
  function lookup(key) {
    var out = exact(key)
    // Server labels such as "Nassau 附近 · 東 +1.5 km／北 -0.75 km": translate the known parts only.
    if (out === undefined && key.indexOf(' · ') >= 0) {
      var parts = key.split(' · '), changed = false
      var mapped = parts.map(function (p) { var x = exact(p.trim()); if (x === undefined) return p; changed = true; return x })
      if (changed) out = mapped.join(' · ')
    }
    return out
  }
  // English sentence junctions: "...unknown.In 2021" -> "...unknown. In 2021" (only lowercase/) + .;!? + capital).
  function spaceJunctions(s) { return s.replace(/([a-z)\]][.;!?])(?=[A-Z])/g, '$1 ') }
  function t(value) {
    if (lang !== 'en' || typeof value !== 'string') return value
    var key = value.trim()
    if (!key) return value
    var out = lookup(key)
    if (out === undefined) { var collapsed = key.replace(/\s+/g, ' '); if (collapsed !== key) out = lookup(collapsed) }
    if (out === undefined) return value
    var at = value.indexOf(key)
    return value.slice(0, at) + out + value.slice(at + key.length)
  }
  function m(parts) {
    var values = Array.prototype.slice.call(arguments, 1)
    var cooked = parts.slice ? parts : [parts]
    if (lang === 'en') {
      var key = ''
      for (var i = 0; i < cooked.length; i++) key += cooked[i] + (i < values.length ? '{' + i + '}' : '')
      var tpl = key in messages ? messages[key] : key in dict ? dict[key] : undefined
      if (tpl !== undefined) return spaceJunctions(tpl.replace(/\{(\d+)\}/g, function (_, n) { return String(t(values[Number(n)])) }))
      var direct = ''
      for (var j = 0; j < cooked.length; j++) direct += cooked[j] + (j < values.length ? String(t(values[j])) : '')
      return t(direct)
    }
    var s = ''
    for (var k = 0; k < cooked.length; k++) s += cooked[k] + (k < values.length ? String(values[k]) : '')
    return s
  }
  var ATTRS = ['title', 'aria-label', 'alt', 'placeholder', 'aria-description', 'label', 'aria-valuetext']
  function translateDom(root) {
    if (lang !== 'en' || !root) return
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    var nodes = []
    for (var n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n)
    nodes.forEach(function (node) {
      var p = node.parentElement
      if (!p || p.closest('script,style,[data-i18n-skip],[lang^="zh"]:not(html)')) return
      var next = t(node.nodeValue)
      if (next !== node.nodeValue) node.nodeValue = next
    })
    var els = root.querySelectorAll ? root.querySelectorAll('*') : []
    Array.prototype.forEach.call(els, function (el) {
      if (el.closest('[data-i18n-skip],[lang^="zh"]:not(html)')) return
      ATTRS.forEach(function (a) {
        var v = el.getAttribute(a)
        if (v) { var next = t(v); if (next !== v) el.setAttribute(a, next) }
      })
      if (el.tagName === 'META' && el.getAttribute('name') === 'description') {
        var c = el.getAttribute('content'); var nc = t(c); if (nc !== c) el.setAttribute('content', nc)
      }
    })
  }
  // English mode keeps the language when following internal links to bilingual pages.
  var LANG_PAGES = ['/', '/microterrain/', '/microterrain-scenario.html', '/research-review/', '/material-review/']
  function englishHref(href) {
    try {
      var url = new URL(href, window.location.href)
      if (url.origin !== window.location.origin) return null
      if (url.pathname === '/technology/' || url.pathname === '/technology/index.html') return '/technology/en-full.html' + url.search + url.hash
      if (LANG_PAGES.indexOf(url.pathname) < 0 || url.searchParams.get('lang')) return null
      url.searchParams.set('lang', 'en')
      return url.pathname + url.search + url.hash
    } catch (e) { return null }
  }
  function onLinkActivate(event) {
    if (lang !== 'en') return
    var a = event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (!a || a.hasAttribute('download') || a.closest('[lang^="zh"]:not(html),[data-keep-href]')) return
    var next = englishHref(a.getAttribute('href'))
    if (next) a.setAttribute('href', next)
  }
  document.addEventListener('click', onLinkActivate, true)
  document.addEventListener('auxclick', onLinkActivate, true)
  document.addEventListener('contextmenu', onLinkActivate, true)
  function setLanguage(next) {
    if (next !== 'en' && next !== 'zh-Hant') return
    try { window.localStorage.setItem(KEY, next) } catch (e) {}
    try { var url = new URL(window.location.href); url.searchParams.set('lang', next); window.location.replace(url.toString()) } catch (e) { window.location.reload() }
  }
  function mountSwitch() {
    var holders = document.querySelectorAll('[data-language-switch]')
    if (holders.length && !document.getElementById('atlas-static-i18n-style')) {
      var st = document.createElement('style'); st.id = 'atlas-static-i18n-style'
      st.textContent = '.language-switch{display:inline-flex;gap:3px;border:1px solid #ffffff30;border-radius:8px;padding:3px;flex-shrink:0;margin-left:auto}' +
        '.language-switch button{border:0;border-radius:5px;background:transparent;color:#a8bdc7;padding:6px 9px;font:inherit;font-size:12px;line-height:1.2;cursor:pointer;min-height:32px}' +
        '.language-switch button[aria-pressed=true]{background:#b4ddce;color:#0a2026}.language-switch button:focus-visible{outline:2px solid #f0cb91;outline-offset:2px}'
      document.head.appendChild(st)
    }
    Array.prototype.forEach.call(holders, function (holder) {
      if (holder.childElementCount) return
      holder.classList.add('language-switch')
      holder.setAttribute('role', 'group')
      holder.setAttribute('aria-label', 'Language / 語言')
      ;[['zh-Hant', '繁中'], ['en', 'English']].forEach(function (pair) {
        var b = document.createElement('button')
        b.type = 'button'; b.lang = pair[0]; b.textContent = pair[1]
        b.setAttribute('aria-pressed', String(lang === pair[0]))
        b.addEventListener('click', function () { if (lang !== pair[0]) setLanguage(pair[0]) })
        holder.appendChild(b)
      })
    })
  }
  function apply() {
    document.documentElement.lang = lang
    if (lang === 'en') {
      var title = document.title, nt = t(title)
      if (nt !== title) document.title = nt
      translateDom(document.head)
      translateDom(document.body)
      Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) { if (a.closest('[lang^="zh"]:not(html),[data-keep-href]')) return; var n = englishHref(a.getAttribute('href')); if (n) a.setAttribute('href', n) })
    }
    mountSwitch()
  }
  window.ATLAS_I18N = {
    lang: lang,
    add: function (d, msgs, pats) {
      if (d) for (var k in d) dict[k] = d[k]
      if (msgs) for (var j in msgs) messages[j] = msgs[j]
      if (pats) patterns.push.apply(patterns, pats)
    },
    t: t, m: m, translateDom: translateDom, setLanguage: setLanguage, apply: apply, englishHref: englishHref
  }
  window.__t = t
  window.__m = m
  document.documentElement.lang = lang
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply)
  else apply()
})()
