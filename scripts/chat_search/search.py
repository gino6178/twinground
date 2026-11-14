"""Rank Earth windows against a search spec (2026-11-12). Used by /api/chat-search.

Reads the per-window condition table of conditions_v1 (500,090 windows: aridity, land cover, Köppen shares, GLiM
lithology, soil, volcano distance, relief, slope, latitude) and the access table (road distance, nearest place).
Each condition is graded 2 (match), 1 (partial) or 0 with fixed thresholds; "must" conditions have to reach at
least partial, "avoid" conditions must not match. Windows are ranked by the weighted grade, ties broken by how far
past the thresholds the values sit, and picks are kept at least 150 km apart. Nothing here is learned: the language
model only writes the spec.
"""
import math
from functools import lru_cache

import numpy as np

from scripts.chat_search import spec as S
from scripts.conditions_v1 import service as cs
from scripts.known_analogs import service as known

# condition -> (fields -> value, match, partial, higher_is_better)
RULES = {
    'dry': (lambda e, a: e['aridity_index'], 0.2, 0.5, False),
    'hyperarid': (lambda e, a: e['aridity_index'], 0.05, 0.2, False),
    'bare': (lambda e, a: np.where(np.nan_to_num(e['glim_ig']) >= 0.5, 0.0, e['bare_sparse'] + e['moss_lichen']), 0.6, 0.3, True),
    'cold': (lambda e, a: e['cold'], 0.5, 0.2, True),
    'hot': (lambda e, a: e['hot'], 0.5, 0.2, True),
    'permafrost': (lambda e, a: e['koppen_ET'] + e['koppen_EF'], 0.5, 0.2, True),
    'ice_sheet': (lambda e, a: np.fmax(e['snow_ice'], e['glim_ig']), 0.5, 0.2, True),
    'low_sun': (lambda e, a: e['abs_lat'], 60.0, 50.0, True),
    'volcanic': (lambda e, a: e['basaltic_volcano_km'], 60.0, 150.0, False),
    'basalt': (lambda e, a: e['glim_vb'] + e['glim_py'], 0.4, 0.15, True),
    'anorthosite': (lambda e, a: e['glim_pb'], 0.25, 0.08, True),
    'sedimentary': (lambda e, a: e['glim_ss'] + e['glim_sm'] + e['glim_su'] + e['glim_sc'] + e['glim_ev'], 0.5, 0.25, True),
    'dunes': (lambda e, a: np.fmax(e['dune_share'] * 12.0, np.where(np.nan_to_num(e['sand']) >= 0.6, 0.12, 0.0)), 0.6, 0.12, True),
    'evaporite': (lambda e, a: e['glim_ev'], 0.05, 0.01, True),
    'clay': (lambda e, a: e['clay'], 0.35, 0.25, True),
    'rugged': (lambda e, a: e['relief_m'], 1500.0, 800.0, True),
    'flat': (lambda e, a: e['mean_slope_deg'], 2.0, 5.0, False),
    'accessible': (lambda e, a: a['road_km'], 25.0, 75.0, False),
    'remote': (lambda e, a: a['road_km'], 100.0, 50.0, True),
    # facets v6 table (same thresholds as scripts/facets_v6/service.py)
    'extreme_cold': (lambda e, a: e['t_cold_min_c'], -40.0, -20.0, False),
    'big_swing': (lambda e, a: e['t_diurnal_k'], 15.0, 10.0, True),
    'windy': (lambda e, a: e['wind_ms'], 6.0, 4.0, True),
    'dusty': (lambda e, a: e['aod'], 0.3, 0.15, True),
    'high_uv': (lambda e, a: e['uv_index'], 2.3, 2.0, True),
    'high_altitude': (lambda e, a: e['pressure_kpa'], 60.0, 75.0, False),
    'caves': (lambda e, a: e['karst_share'], 0.3, 0.1, True),
    'impact': (lambda e, a: e['impact_km'], 50.0, 150.0, False),
}
UNITS = {'dry': ('乾燥指數', 'aridity index', 2), 'hyperarid': ('乾燥指數', 'aridity index', 3), 'bare': ('裸露占比', 'bare share', '%'),
         'cold': ('寒冷氣候占比', 'cold-climate share', '%'), 'hot': ('炎熱氣候占比', 'hot-climate share', '%'),
         'permafrost': ('凍原或冰原氣候占比', 'tundra or ice-cap share', '%'), 'ice_sheet': ('冰雪覆蓋', 'ice or snow cover', '%'),
         'low_sun': ('緯度', 'latitude', '°'), 'volcanic': ('距玄武岩火山', 'to a basaltic volcano', 'km'),
         'basalt': ('玄武岩占比', 'basalt share', '%'), 'anorthosite': ('基性深成岩占比', 'mafic plutonic share', '%'),
         'sedimentary': ('沉積岩占比', 'sedimentary share', '%'), 'dunes': ('沙丘指標', 'dune index', 2),
         'evaporite': ('蒸發岩占比', 'evaporite share', '%'), 'clay': ('表土黏土', 'topsoil clay', '%'),
         'rugged': ('起伏', 'relief', 'm'), 'flat': ('平均坡度', 'mean slope', '°'), 'accessible': ('距道路', 'to a road', 'km'),
         'remote': ('距道路', 'to a road', 'km'),
         'extreme_cold': ('最冷月日最低溫', 'coldest-month daily minimum', ' °C'), 'big_swing': ('日夜溫差', 'diurnal range', ' K'),
         'windy': ('平均風速', 'mean wind', ' m/s'), 'dusty': ('氣膠光學厚度', 'aerosol optical depth', 2),
         'high_uv': ('紫外線指數（全日平均）', 'UV index (24 h mean)', 1), 'high_altitude': ('地面氣壓', 'surface pressure', ' kPa'),
         'caves': ('喀斯特占比', 'karst share', '%'), 'impact': ('距撞擊構造', 'to an impact structure', 'km')}
WEIGHT = {'must': 2.0, 'prefer': 1.0}
MIN_SEP_KM = 150.0
# conditions_v1 query conditions -> spec conditions (what a named Moon or Mars target asks of Earth)
FROM_PROFILE = {'dry': 'dry', 'bare': 'bare', 'cold': 'cold', 'low_sun': 'low_sun', 'ground_ice': 'permafrost', 'volcanic': 'volcanic',
                'aeolian': 'dunes', 'hydrated': 'evaporite'}
LITHOLOGY = {'basaltic': 'basalt', 'anorthositic': 'anorthosite'}


@lru_cache(maxsize=1)
def tables():
    e = dict(cs.earth())
    try:  # facets v6 columns (climate, pressure, karst, impact); without the table those conditions grade as unknown
        f = np.load(cs.ROOT / 'data/research/facets_v6/earth_facets.npz')
        assert (f['ids'] == e['ids']).all()
        e.update({k: f[k] for k in f.files if k not in ('ids', 'lat', 'lon')})
    except Exception as exc:  # noqa: BLE001
        print('facets table unavailable:', repr(exc), flush=True)
        nan = np.full(len(e['ids']), np.nan, np.float32)
        e.update({k: nan for k in ('t_cold_min_c', 't_diurnal_k', 'wind_ms', 'aod', 'uv_index', 'pressure_kpa', 'karst_share', 'impact_km')})
    acc, lookup = cs.access_data()
    return e, acc, lookup


_CENTRES = {}


def centres_from(rows):
    """Window centres in the order of the condition table (NaN where a window has no row)."""
    if 'lat' not in _CENTRES:
        e = tables()[0]
        by_id = {r['id']: r for r in rows if r.get('id')}
        lat = np.full(len(e['ids']), np.nan, np.float32); lon = lat.copy(); km = np.zeros(len(e['ids']), np.int16)
        for i, wid in enumerate(e['ids']):
            r = by_id.get(str(wid))
            if r and r.get('center'):
                lat[i] = r['center']['latitude']; lon[i] = r['center']['longitude_east']; km[i] = r.get('patch_km') or 0
        _CENTRES.update(lat=lat, lon=lon, km=km)
    return _CENTRES['lat'], _CENTRES['lon'], _CENTRES['km']


def grade(cid, e, a):
    fn, match, partial, higher = RULES[cid]
    v = np.asarray(fn(e, a), np.float32)
    g = np.where(v >= match, 2, np.where(v >= partial, 1, 0)) if higher else np.where(v <= match, 2, np.where(v <= partial, 1, 0))
    g = np.where(np.isfinite(v), g, -1).astype(np.int8)
    span = (match - partial) if higher else (partial - match)
    past = ((v - partial) if higher else (partial - v)) / max(span, 1e-6)  # 1 at the match threshold
    return g, v, np.clip(np.nan_to_num(past, nan=0), 0, 2) / 2


def resolve(spec):
    """Conditions actually applied: those implied by a named target or a body, then the user's own (which win)."""
    applied, implied = {}, []
    if spec['target']:
        body, lat, lon = S.TARGETS[spec['target']][:3]
        prof = cs.query_profile(body, lat, lon, 40)
        for c in prof['conditions']:
            cid = LITHOLOGY.get(c['params'].get('kind'), 'sedimentary') if c['id'] == 'lithology' else FROM_PROFILE.get(c['id'])
            if cid:
                applied[cid] = 'must'; implied.append(cid)
    elif spec['body'] and not spec['conditions']:
        for cid in (['dry', 'bare'] if spec['body'] == 'moon' else ['dry', 'bare', 'cold']):
            applied[cid] = 'must'; implied.append(cid)
    applied.update(spec['conditions'])
    return applied, [c for c in implied if c not in spec['conditions']]


COUNTRY = {'usa': 'United States of America', 'canada': 'Canada', 'mexico': 'Mexico', 'chile': 'Chile', 'argentina': 'Argentina',
           'peru': 'Peru', 'bolivia': 'Bolivia', 'china': 'China', 'mongolia': 'Mongolia', 'india': 'India', 'iran': 'Iran',
           'saudi_arabia': 'Saudi Arabia', 'egypt': 'Egypt', 'morocco': 'Morocco', 'algeria': 'Algeria', 'libya': 'Libya',
           'namibia': 'Namibia', 'south_africa': 'South Africa', 'ethiopia': 'Ethiopia', 'kenya': 'Kenya', 'iceland': 'Iceland',
           'greenland': 'Greenland', 'norway': 'Norway', 'russia': 'Russia', 'kazakhstan': 'Kazakhstan', 'turkey': 'Turkey',
           'spain': 'Spain', 'australia': 'Australia', 'new_zealand': 'New Zealand', 'japan': 'Japan', 'taiwan': 'Taiwan',
           'indonesia': 'Indonesia', 'hawaii': 'United States of America'}


@lru_cache(maxsize=1)
def window_country():
    """Country of each window's nearest populated place (Natural Earth), used to trim country boxes at borders."""
    e, a, lookup = tables()
    names = np.array([p['country'] for p in lookup['places']] + [''])
    idx = np.where(a['place_idx'] >= 0, a['place_idx'], len(names) - 1)
    return names[idx]


def in_region(rid, lat, lon):
    m = in_boxes(lat, lon, S.REGIONS[rid][2])
    if rid in COUNTRY:
        m &= window_country() == COUNTRY[rid]
    return m


def in_boxes(lat, lon, boxes):
    m = np.zeros(lat.shape, bool)
    for la0, la1, lo0, lo1 in boxes:
        m |= (lat >= la0) & (lat <= la1) & (lon >= lo0) & (lon <= lo1)
    return m


def hav_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    d = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(np.clip(d, 0, 1)))


def fmt_value(cid, v, zh):
    name_zh, name_en, unit = UNITS[cid]
    if not math.isfinite(v):
        return f"{name_zh if zh else name_en} —"
    text = f'{v * 100:.0f}%' if unit == '%' else f'{v:.{unit}f}' if isinstance(unit, int) else f'{v:,.0f} {unit}' if unit in ('km', 'm') else f'{v:.0f}{unit}'
    return f"{name_zh if zh else name_en} {text}"


def run(spec, rows, lang='zh'):
    spec = S.validate(spec)
    zh = lang != 'en'
    e, a, lookup = tables()
    lat, lon, km = centres_from(rows)
    applied, implied = resolve(spec)
    ok = np.isfinite(lat)
    if spec['region']:
        ok &= in_region(spec['region'], lat, lon)
    for r in spec['exclude_regions']:
        ok &= ~in_region(r, lat, lon)
    score = np.zeros(len(lat), np.float32); wsum = 0.0; tie = np.zeros(len(lat), np.float32); n_tie = 0
    grades, values = {}, {}
    must_ok = np.ones(len(lat), bool)
    for cid, imp in applied.items():
        g, v, past = grade(cid, e, a)
        grades[cid], values[cid] = g, v
        if imp == 'avoid':
            ok &= g != 2
            score -= 0.5 * np.clip(g, 0, 2) / 2
            continue
        w = WEIGHT[imp]
        score += w * np.clip(g, 0, 2) / 2; wsum += w
        tie += past; n_tie += 1
        if imp == 'must':
            must_ok &= g >= 1
    relaxed = False
    pool = ok & must_ok
    if pool.sum() < spec['top_k'] * 4 and any(v == 'must' for v in applied.values()):
        pool, relaxed = ok, True
    total = (score / max(wsum, 1e-6) if wsum else score + 1) + 0.05 * (tie / max(n_tie, 1))
    total = np.where(pool, total, -np.inf)
    order = np.argsort(-total)
    picks = []
    for i in order:
        if not np.isfinite(total[i]) or len(picks) >= spec['top_k']:
            break
        if spec['exclude_known']:
            bodies = [spec['body']] if spec['body'] else ['moon', 'mars']
            if any(known.nearest(float(lat[i]), float(lon[i]), b) for b in bodies):
                continue
        if any(hav_km(lat[i], lon[i], lat[j], lon[j]) < MIN_SEP_KM for j in picks):
            continue
        picks.append(int(i))
    places = lookup['places']
    out = []
    for i in picks:
        p = places[int(a['place_idx'][i])] if a['place_idx'][i] >= 0 else None
        kn = None
        for b in ([spec['body']] if spec['body'] else ['moon', 'mars']):
            kn = kn or known.nearest(float(lat[i]), float(lon[i]), b)
        out.append({
            'id': str(e['ids'][i]), 'lat': round(float(lat[i]), 4), 'lon': round(float(lon[i]), 4), 'patch_km': int(km[i]),
            'score': round(float(total[i]), 4),
            'place': ({'name': p['name'], 'country': p['country'], 'km': round(float(a['place_km'][i]), 0)} if p else None),
            'road_km': round(float(a['road_km'][i]), 1),
            'known_analog': ({'name': kn['name'], 'name_zh': kn.get('name_zh'), 'distance_km': kn['distance_km']} if kn else None),
            'conditions': [{'id': cid, 'importance': imp, 'grade': int(grades[cid][i]), 'text': fmt_value(cid, float(values[cid][i]), zh)}
                           for cid, imp in applied.items()],
        })
    li = 0 if zh else 1
    labels = {c: S.CONDITIONS[c][li] for c in S.CONDITIONS}
    region_labels = {r: S.REGIONS[r][li] for r in S.REGIONS}
    target_label = S.TARGETS[spec['target']][3 + li] if spec['target'] else None
    return {'spec': spec, 'applied': applied, 'implied': implied, 'relaxed': relaxed, 'pool': int(pool.sum()), 'results': out,
            'labels': labels, 'region_labels': region_labels, 'target_label': target_label,
            'reply': reply(spec, applied, implied, relaxed, out, zh)}


def reply(spec, applied, implied, relaxed, out, zh):
    lab = lambda c: S.CONDITIONS[c][0 if zh else 1]  # noqa: E731
    parts = []
    if spec['target']:
        t = S.TARGETS[spec['target']]
        parts.append((f'以{t[3]}為目標' if zh else f'Target: {t[4]}'))
    elif spec['body']:
        parts.append(('以月球為目標' if spec['body'] == 'moon' else '以火星為目標') if zh else f"Target: {'the Moon' if spec['body'] == 'moon' else 'Mars'}")
    groups = {imp: [lab(c) for c, v in applied.items() if v == imp] for imp in S.IMPORTANCE}
    names = {'must': ('必須', 'must'), 'prefer': ('偏好', 'prefer'), 'avoid': ('避開', 'avoid')}
    for imp in S.IMPORTANCE:
        if groups[imp]:
            parts.append(f"{names[imp][0 if zh else 1]}{'：' if zh else ': '}{('、' if zh else ', ').join(groups[imp])}")
    if implied:
        parts.append(('其中由目標推得：' if zh else 'implied by the target: ') + ('、' if zh else ', ').join(lab(c) for c in implied))
    if spec['region']:
        parts.append(('範圍：' if zh else 'region: ') + S.REGIONS[spec['region']][0 if zh else 1])
    if spec['exclude_regions']:
        parts.append(('排除：' if zh else 'excluding: ') + ('、' if zh else ', ').join(S.REGIONS[r][0 if zh else 1] for r in spec['exclude_regions']))
    if spec['exclude_known']:
        parts.append('排除已知類比場址' if zh else 'known analog sites excluded')
    head = ('；'.join(parts) + '。') if zh else ('; '.join(parts) + '.')
    if not out:
        return head + ('沒有符合的窗格，請放寬條件或範圍。' if zh else ' No window qualifies; relax a condition or the region.')
    tail = (f'找到 {len(out)} 個地點，彼此相距至少 {MIN_SEP_KM:.0f} km。' if zh else f' Found {len(out)} places at least {MIN_SEP_KM:.0f} km apart.')
    if relaxed:
        tail += ('符合所有必要條件的窗格太少，已改為依符合程度排序。' if zh else ' Too few windows met every required condition, so results are ranked by how well they match.')
    return head + tail
