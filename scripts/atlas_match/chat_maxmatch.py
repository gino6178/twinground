"""Conversational search, max-match mode (2026-11-14).

The fine-tuned 1B language model still only writes the search spec. When the spec names a Moon or Mars target, the
ranking is the max-match feature model (maxmatch.py): Earth 40 km windows ordered by how many measured properties
agree with the target. The user's own conditions act as filters ("must", "avoid") or tie-breaks ("prefer"); conditions
the target would imply are NOT added, because the measured properties already describe the target.
Output keeps the shape of search.run so the chat page renders it unchanged, plus a "measured" block per result."""
from functools import lru_cache

import numpy as np

from scripts.atlas_match import features as F, maxmatch as MM
from scripts.chat_search import search, spec as S


@lru_cache(maxsize=2)
def _pos(body, n_rows):
    e, _a, _l = search.tables()
    ids = {s: i for i, s in enumerate(e['ids'].tolist())}
    return np.array([ids.get(s, -1) for s in F.earth(body)['ids'].tolist()])


def run(spec, rows, lang='zh'):
    spec = S.validate(spec)
    zh = lang != 'en'
    body, tlat, tlon = S.TARGETS[spec['target']][:3]
    x = MM.query(body, tlat, tlon)
    ev = MM.evaluate(body, x)
    E = F.earth(body)
    lat, lon = E['lat'], E['lon']
    e, a, lookup = search.tables()
    lat_all, lon_all, _km = search.centres_from(rows)
    pos = _pos(body, len(e['ids']))
    have = pos >= 0
    take = lambda arr: np.where(have, np.asarray(arr)[np.maximum(pos, 0)], 0)  # noqa: E731
    ok = have.copy()
    if spec['region']:
        ok &= take(search.in_region(spec['region'], lat_all, lon_all)).astype(bool)
    for r in spec['exclude_regions']:
        ok &= ~take(search.in_region(r, lat_all, lon_all)).astype(bool)
    applied = dict(spec['conditions'])
    grades, values = {}, {}
    must_ok = np.ones(len(lat), bool)
    bonus = np.zeros(len(lat))
    for cid, imp in applied.items():
        g, v, _past = search.grade(cid, e, a)
        g, v = take(g), np.where(have, np.asarray(v, float)[np.maximum(pos, 0)], np.nan)
        grades[cid], values[cid] = g, v
        if imp == 'avoid':
            ok &= g != 2
        elif imp == 'must':
            must_ok &= g >= 1
            bonus += np.clip(g, 0, 2) / 2
        else:
            bonus += 0.5 * np.clip(g, 0, 2) / 2
    relaxed = False
    pool = ok & must_ok
    if pool.sum() < spec['top_k'] * 4 and any(v == 'must' for v in applied.values()):
        pool, relaxed = ok, True
    # matches first, then fewer misses, then the user's conditions, then the mean gap (see maxmatch.evaluate)
    total = np.where(pool, ev['score'] + 10.0 * bonus, -np.inf)
    order = np.argsort(-total, kind='stable')
    picks = []
    for i in order:
        if not np.isfinite(total[i]) or len(picks) >= spec['top_k']:
            break
        if spec['exclude_known'] and search.known.nearest(float(lat[i]), float(lon[i]), body):
            continue
        if any(search.hav_km(lat[i], lon[i], lat[j], lon[j]) < search.MIN_SEP_KM for j in picks):
            continue
        picks.append(int(i))
    places = lookup['places']
    out = []
    for i in picks:
        k = int(pos[i])
        p = places[int(a['place_idx'][k])] if a['place_idx'][k] >= 0 else None
        kn = search.known.nearest(float(lat[i]), float(lon[i]), body)
        m = MM.candidate(body, x, ev, i)
        out.append({
            'id': str(E['ids'][i]), 'lat': round(float(lat[i]), 4), 'lon': round(float(lon[i]), 4), 'patch_km': F.KM,
            'score': round(m['matched'] / max(m['properties'], 1), 4),
            'place': ({'name': p['name'], 'country': p['country'], 'km': round(float(a['place_km'][k]), 0)} if p else None),
            'road_km': round(float(a['road_km'][k]), 1),
            'known_analog': ({'name': kn['name'], 'name_zh': kn.get('name_zh'), 'distance_km': kn['distance_km']} if kn else None),
            'conditions': [{'id': cid, 'importance': imp, 'grade': int(grades[cid][i]), 'text': search.fmt_value(cid, float(values[cid][i]), zh)}
                           for cid, imp in applied.items()],
            'measured': m,
        })
    li = 0 if zh else 1
    t = S.TARGETS[spec['target']]
    limits = [MM.LABEL[p][li] for p in ev['limits']]
    best = out[0]['measured']['matched'] if out else 0
    n = len(ev['props'])
    head = (f'以{t[3]}為目標，比對 {n} 項實測資料（地形、化學、溫度、冰' + ('、塵、風、反照率' if body == 'mars' else '') +
            f'），最好的地方符合 {best} 項。' if zh else
            f'Target: {t[4]}. Compared {n} measured properties; the best place matches {best}.')
    if limits:
        head += (f'地球上沒有地方做得到：{"、".join(limits)}。' if zh else f' No place on Earth reaches: {", ".join(limits)}.')
    imp_txt = {'must': ('必須', 'must'), 'prefer': ('偏好', 'prefer'), 'avoid': ('避開', 'avoid')}
    bits = [f'{imp_txt[imp][li]}{"" if zh else " "}{S.CONDITIONS[cid][li]}' for cid, imp in applied.items()]
    if spec['region']:
        bits.insert(0, (f'範圍：{S.REGIONS[spec["region"]][0]}' if zh else f'region: {S.REGIONS[spec["region"]][1]}'))
    rest = (('你的條件：' + '、'.join(bits) + '。') if zh else ('Your conditions: ' + ', '.join(bits) + '.')) if bits else ''
    if not out:
        rest += '沒有符合的窗格，請放寬條件或範圍。' if zh else ' No window qualifies; relax a condition or the region.'
    return {'spec': spec, 'applied': applied, 'implied': [], 'relaxed': relaxed, 'pool': int(pool.sum()), 'results': out,
            'labels': {c: S.CONDITIONS[c][li] for c in S.CONDITIONS}, 'region_labels': {r: S.REGIONS[r][li] for r in S.REGIONS},
            'target_label': t[3 + li], 'target': {'id': spec['target'], 'body': body, 'lat': tlat, 'lon': tlon}, 'ranking': 'maxmatch', 'maxmatch': MM.summary(body, ev),
            'reply': (head + (' ' if rest and not zh else '') + rest).strip()}
