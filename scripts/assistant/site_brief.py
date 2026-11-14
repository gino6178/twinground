"""Compact, deterministic text brief of one search result for the assistant (2026-11-14).

The web page already holds the /api/search (or /api/mars-search) answer. When the user asks the assistant about a
candidate, the page sends that answer (terrain meshes removed) and the candidate index; this module turns the evidence
into a short plain-text brief that the 1B model can explain. The same function builds the briefs used to generate
the training dialogues, so the model sees exactly this format at serving time.

Nothing here is inferred: every line restates a value the search already returned.
"""

STATUS = {'en': {'strong': 'match', 'partial': 'partial', 'breaks': 'does not match', 'unknown': 'no Earth data',
                 2: 'match', 1: 'partial', 0: 'does not match', None: 'no Earth data',
                 'met': 'within tolerance', 'not_met': 'outside tolerance', 'earth_cannot_supply':
                 'Earth cannot supply (no measured Earth window within tolerance)', 'estimated': 'estimated'},
          'zh': {'strong': '符合', 'partial': '部分符合', 'breaks': '不符合', 'unknown': '地球端無資料',
                 2: '符合', 1: '部分符合', 0: '不符合', None: '地球端無資料',
                 'met': '在容許範圍內', 'not_met': '超出容許範圍', 'earth_cannot_supply':
                 '地球做不到（沒有任何實測地球窗格落在容許範圍內）', 'estimated': '估計值'}}
BODY = {'en': {'moon': 'Moon', 'mars': 'Mars'}, 'zh': {'moon': '月球', 'mars': '火星'}}
PURPOSE = {'en': {'facets': 'ten-facet analog score', 'physical': 'measured physical properties', 'conditions':
                  'expert-style conditions', 'material': 'terrain + surface material', 'lavatube': 'lava tubes / skylights',
                  'morphology': 'terrain shape', 'maxmatch': 'property match', 'surface': 'surface', 'terrain_test': 'terrain'},
           'zh': {'facets': '十面向類比評分', 'physical': '實測物理性質', 'conditions': '專家式條件', 'material': '地形＋地表材質',
                  'lavatube': '熔岩管／天窗', 'morphology': '地形形狀', 'maxmatch': '性質比對', 'surface': '地表', 'terrain_test': '地形'}}


def _t(v, lang):
    if isinstance(v, dict):
        return v.get(lang) or v.get('en') or v.get('zh') or ''
    return '' if v is None else str(v)


def _num(v, nd=2):
    if v is None:
        return 'n/a'
    if isinstance(v, (int, float)):
        return f'{v:,.{nd}f}'.rstrip('0').rstrip('.') if isinstance(v, float) else f'{v:,}'
    return str(v)


def _ll(lat, lon):
    return f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'} {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}"


def query_lines(ans, lang):
    zh = lang == 'zh'
    w = ans.get('window') or {}
    body = w.get('body') or ('mars' if 'mars' in str(ans.get('model', '')).lower() else 'moon')
    out = []
    if 'lat' in w:
        purpose = ans.get('purpose', '')
        use = (ans.get('facets') or {}).get('use_label')
        line = (f"查詢窗格：{BODY[lang][body]} {_ll(w['lat'], w['lon'])}，{w.get('patch_km')} km 見方。搜尋目的：{PURPOSE[lang].get(purpose, purpose)}"
                if zh else f"Query window: {BODY[lang][body]} {_ll(w['lat'], w['lon'])}, {w.get('patch_km')} km square. "
                f"Search purpose: {PURPOSE[lang].get(purpose, purpose)}")
        if use:
            line += (f"（用途：{_t(use, lang)}）" if zh else f" (use: {_t(use, lang)})")
        out.append(line + ('。' if zh else '.'))
    geo = ans.get('moon_geology') or {}
    if geo.get('available') and geo.get('dominant_unit'):
        u = geo['dominant_unit']
        out.append((f"月面地質（USGS 2020）：主要單元 {u.get('code')}（{u.get('description')}，{u.get('period')}）。" if zh else
                    f"Lunar geology (USGS 2020 map): dominant unit {u.get('code')} ({u.get('description')}, {u.get('period')})."))
    gc = ans.get('moon_geochemistry') or {}
    if gc.get('available'):
        out.append((f"Lunar Prospector：FeO {_num(gc.get('feo_weight_percent'))} wt%，Ti {_num(gc.get('titanium_weight_percent'))} wt%。"
                    if zh else f"Lunar Prospector: FeO {_num(gc.get('feo_weight_percent'))} wt%, Ti {_num(gc.get('titanium_weight_percent'))} wt%."))
    pm = ans.get('physical_match') or {}
    qt = [t for t in pm.get('query_tokens', []) if t.get('value') is not None]
    if qt:
        vals = ', '.join(f"{_t(t['label'], lang)} {_num(t['value'])} {t.get('unit', '')} ({t.get('provenance', '')})".replace(' ()', '')
                         for t in qt[:9])
        out.append(('查詢窗格實測性質：' if zh else 'Measured query properties: ') + vals + ('。' if zh else '.'))
    if ans.get('searched_windows'):
        out.append((f"比對的地球窗格數：{ans['searched_windows']:,}。" if zh else
                    f"Earth windows compared: {ans['searched_windows']:,}."))
    fc = (ans.get('facets') or {}).get('ceiling') or {}
    if fc.get('score') is not None:
        out.append((f"地球上限（此用途任何實測地球窗格能達到的最高分）：{fc['score']:.2f}（{fc.get('scored_windows', 0):,} 個窗格）。" if zh else
                    f"Earth ceiling (best score any measured Earth window reaches for this use): {fc['score']:.2f} "
                    f"over {fc.get('scored_windows', 0):,} windows."))
    lim = (ans.get('facets') or {}).get('limits') or []
    if lim:
        s = '；'.join(f"{_t(x['label'], lang)}（目標 {_t(x['target'], lang)}，地球 {_t(x['earth'], lang)}）" for x in lim) if zh else \
            '; '.join(f"{_t(x['label'], lang)} (target {_t(x['target'], lang)}, Earth {_t(x['earth'], lang)})" for x in lim)
        out.append(('地球無法重現、不計分的條件：' if zh else 'Conditions Earth cannot reproduce (never scored): ') + s + ('。' if zh else '.'))
    return out


def candidate_lines(m, rank, lang):
    zh = lang == 'zh'
    st = STATUS[lang]
    c = m.get('center') or {}
    out = []
    head = (f"候選 #{rank}：{m.get('name', '')}，中心 {_ll(c.get('latitude', 0), c.get('longitude_east', 0))}，"
            f"顯示分數 {_num(m.get('score'), 1)}／100（排序分數，不是機率）。" if zh else
            f"Candidate #{rank}: {m.get('name', '')}, centre {_ll(c.get('latitude', 0), c.get('longitude_east', 0))}, "
            f"display score {_num(m.get('score'), 1)}/100 (a ranking score, not a probability).")
    out.append(head)
    f = m.get('facets') or {}
    if f.get('facets'):
        out.append((f"十面向總分 {(f.get('score') or 0):.2f}：" if zh else f"Ten-facet score {(f.get('score') or 0):.2f}:"))
        for fa in f['facets']:
            toks = [t for t in fa.get('tokens', []) if t.get('counted', True)]
            if not toks:
                continue
            parts = []
            for t in toks:
                ev = t.get('earth_value')
                ev = f"{_num(ev)}{(' ' + t['unit']) if t.get('unit') else ''}" if ev is not None else ('無資料' if zh else 'n/a')
                parts.append((f"{_t(t['label'], lang)}：目標 {_t(t.get('query'), lang)}；需要 {_t(t.get('need'), lang)}；地球 {ev} → {st.get(t.get('status'), t.get('status'))}"
                               if zh else f"{_t(t['label'], lang)}: target {_t(t.get('query'), lang)}; needs {_t(t.get('need'), lang)}; "
                               f"Earth {ev} -> {st.get(t.get('status'), t.get('status'))}"))
            out.append(f"- {fa['id']} {_t(fa['label'], lang)} ({st.get(fa.get('status'), fa.get('status'))}, {(fa.get('score') or 0):.2f}): "
                       + (' | '.join(parts)))
    cond = m.get('conditions') or {}
    if cond.get('available') and cond.get('rows') and not f.get('facets'):  # facets already restate the conditions
        out.append((f"條件檢查（符合度 {(cond.get('fit') or 0):.0%}）：" if zh else f"Condition checks (fit {(cond.get('fit') or 0):.0%}):"))
        for r in cond['rows']:
            out.append(f"- {_t(r['label'], lang)}: {_t(r.get('query'), lang)} / "
                       f"{('需要' if zh else 'needs')} {_t(r.get('need'), lang)} / {('地球' if zh else 'Earth')} {_t(r.get('earth'), lang)} -> "
                       f"{st.get(r.get('verdict'), r.get('verdict'))}")
    pm = m.get('physical_match') or {}
    if pm.get('tokens'):
        out.append('實測性質比對：' if zh else 'Same-unit property comparison:')
        for t in pm['tokens']:
            ev = _num(t.get('earth_value')) if t.get('earth_value') is not None else ('無資料' if zh else 'n/a')
            share = t.get('earth_share_within')
            share_txt = ((f"；全地球 {t.get('earth_within', 0):,}/{t.get('earth_measured', 0):,} 個實測窗格在容許範圍內" if zh else
                          f"; {t.get('earth_within', 0):,} of {t.get('earth_measured', 0):,} measured Earth windows within tolerance")
                         if share is not None else '')
            out.append(f"- {_t(t['label'], lang)}: {('目標' if zh else 'target')} {_num(t.get('query_value'))} {t.get('unit', '')}, "
                       f"{('此地' if zh else 'here')} {ev} ({('容許' if zh else 'tolerance')} ±{_num(t.get('tolerance'))}) -> "
                       f"{st.get(t.get('verdict'), t.get('verdict'))}{share_txt}")
    lith = m.get('earth_lithology') or {}
    if lith.get('available'):
        out.append((f"地球岩性（GLiM）：{lith.get('label')}，占 {(lith.get('sample_share') or 0):.0%}。" if zh else
                    f"Earth lithology (GLiM): {lith.get('label')} ({lith.get('code')}), {(lith.get('sample_share') or 0):.0%} of the window."))
    lf = m.get('earth_landform_context') or {}
    for key, name in (('holocene_volcano', ('全新世火山', 'Holocene volcano')), ('caldera', ('火山口', 'caldera')),
                      ('impact', ('撞擊構造', 'impact structure'))):
        x = lf.get(key)
        if x and x.get('distance_km') is not None and x['distance_km'] < 400:
            out.append((f"最近的{name[0]}：{x.get('name')}，{_num(x['distance_km'], 0)} km。" if zh else
                        f"Nearest {name[1]}: {x.get('name')}, {_num(x['distance_km'], 0)} km."))
    ga = m.get('geometry_audit') or {}
    if ga.get('reference_mean_slope_deg') is not None:
        out.append((f"平均坡度：查詢 {ga['reference_mean_slope_deg']}°，此地 {ga['earth_mean_slope_deg']}°；"
                    f"90 百分位粗糙度：查詢 {ga['reference_roughness_p90_m']} m，此地 {ga['earth_roughness_p90_m']} m。" if zh else
                    f"Mean slope: query {ga['reference_mean_slope_deg']}°, here {ga['earth_mean_slope_deg']}°; "
                    f"90th-percentile roughness: query {ga['reference_roughness_p90_m']} m, here {ga['earth_roughness_p90_m']} m."))
    ka = m.get('known_analog')
    if 'known_analog' in m:
        if ka:
            out.append((f"已知類比地：{ka.get('name_zh') or ka.get('name')}（{_num(ka.get('distance_km'), 0)} km）。" if zh else
                        f"Known analog site nearby: {ka.get('name')} ({_num(ka.get('distance_km'), 0)} km)."))
        else:
            near = m.get('catalogue_nearest') or {}
            out.append((f"附近沒有文獻已用的類比地（新候選）；最近的目錄地點是 {near.get('name_zh') or near.get('name')}，{_num(near.get('distance_km'), 0)} km。"
                        if zh and near else f"No catalogued analog nearby (a new candidate); nearest catalogued site: "
                        f"{near.get('name')}, {_num(near.get('distance_km'), 0)} km." if near else
                        ('附近沒有文獻已用的類比地（新候選）。' if zh else 'No catalogued analog nearby (a new candidate).')))
    return out


def brief(answer, index=0, lang='en', max_chars=None):
    """Brief for candidate `index` (0-based) of a search answer, plus one line per other candidate."""
    lang = 'zh' if lang == 'zh' else 'en'
    max_chars = max_chars or (3800 if lang == 'zh' else 6500)
    matches = answer.get('matches') or []
    lines = ['[SITE]'] + query_lines(answer, lang)
    if matches:
        index = max(0, min(index, len(matches) - 1))
        lines += candidate_lines(matches[index], index + 1, lang)
        others = [f"#{i + 1} {m.get('name', '')} ({_num(m.get('score'), 1)})" for i, m in enumerate(matches) if i != index]
        if others:
            lines.append(('其他候選：' if lang == 'zh' else 'Other candidates: ') + '; '.join(others[:6]))
    text = '\n'.join(lines)
    return text if len(text) <= max_chars else text[:max_chars - 20] + '\n[…truncated]'


def strip_answer(answer):
    """Drop heavy fields the brief never reads (meshes, rasters) before sending over the wire."""
    a = {k: v for k, v in answer.items() if k not in ('index_provenance', 'global_visual')}
    w = dict(a.get('window') or {})
    for k in ('terrain', 'mesh', 'grid', 'display_grid', 'sampling'):
        w.pop(k, None)
    a['window'] = w
    a['matches'] = [{k: v for k, v in m.items() if k not in ('terrain', 'sampling_footprint', 'sampling_support')}
                    for m in a.get('matches') or []]
    return a
