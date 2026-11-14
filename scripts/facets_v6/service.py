"""Facets v6: every consideration on the challenge page as a scored facet of one model (frozen rule set RULES_VERSION).

Ten facets (A terrain, B surface material, C thermal, D sunlight, E water and ice, F dust and wind, G surface processes,
H habitability, I subsurface, J operations). Each facet is the mean of its tokens; a token is 1 (match), 0.5 (partial),
0 (breaks down) or unknown (no Earth data - never counted as 0). A use is a fixed set of facet weights.
Condition tokens reuse the frozen conditions-v1.1 verdicts; new tokens use the Earth facet table (build.py).
Things Earth cannot reproduce anywhere (gravity, vacuum, radiation, day length) are listed as limits and never scored.
The known-analog catalogue is not an input."""
import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from scripts.conditions_v1 import service as C

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data/research/facets_v6'
RULES_VERSION = 'facets-v6.0'

FACETS = [('A', '地形', 'Terrain'), ('B', '表面材質', 'Surface material'), ('C', '熱環境', 'Thermal'),
          ('D', '日照', 'Sunlight'), ('E', '水與冰', 'Water and ice'), ('F', '沙塵與風', 'Dust and wind'),
          ('G', '地表作用', 'Surface processes'), ('H', '適居性', 'Habitability'), ('I', '地下', 'Subsurface'),
          ('J', '作業', 'Operations')]
USES = {
    'overall': {'A': .15, 'B': .15, 'C': .10, 'D': .05, 'E': .15, 'F': .10, 'G': .10, 'H': .05, 'I': .05, 'J': .10},
    'astrobiology': {'H': .40, 'E': .30, 'B': .10, 'G': .10, 'C': .10},
    'subsurface': {'I': .50, 'B': .20, 'G': .15, 'J': .15},
    'crew_ops': {'J': .35, 'D': .20, 'F': .15, 'C': .15, 'A': .15},
}
USE_TEXT = {'overall': ('全面向', 'All facets'), 'astrobiology': ('天體生物', 'Astrobiology'),
            'subsurface': ('地下探測', 'Subsurface'), 'crew_ops': ('乘員作業', 'Crew operations')}
TOL_MEAN_TEMP_K = 20.0   # same tolerance as physmatch v5.2
LIMITS = {
    'moon': [('gravity', '重力', 'Gravity', '0.17 g', '1 g'), ('pressure', '氣壓', 'Pressure', '真空', '50–101 kPa'),
             ('radiation', '輻射', 'Radiation', '無磁場與大氣屏蔽', '有屏蔽'), ('day', '晝夜', 'Day length', '29.5 地球日', '24 小時'),
             ('wind', '風', 'Wind', '無大氣，沒有風', '有風'), ('biology', '生物', 'Biology', '無已知生物', '到處有生物')],
    'mars': [('gravity', '重力', 'Gravity', '0.38 g', '1 g'), ('pressure', '氣壓', 'Pressure', '約 0.6 kPa', '50–101 kPa'),
             ('radiation', '輻射', 'Radiation', '地表劑量遠高於地球', '有屏蔽'), ('atmosphere', '大氣成分', 'Atmosphere', '95% CO₂', '氮氧大氣')],
}
LIMITS_EN = {'真空': 'vacuum', '無磁場與大氣屏蔽': 'no magnetic or atmospheric shielding', '有屏蔽': 'shielded',
             '29.5 地球日': '29.5 Earth days', '24 小時': '24 hours', '無大氣，沒有風': 'no atmosphere, no wind', '有風': 'windy',
             '無已知生物': 'no known life', '到處有生物': 'life everywhere', '約 0.6 kPa': 'about 0.6 kPa',
             '地表劑量遠高於地球': 'surface dose far above Earth', '氮氧大氣': 'nitrogen-oxygen air'}
PROCESS = {  # geologic setting -> the surface process an analog should show
    'mare': 'volcanic', 'pyroclastic': 'volcanic', 'crater': 'impact', 'basin': 'impact', 'terra': 'impact', 'plains': 'impact',
    'volcanic': 'volcanic', 'highland': 'impact', 'impact': 'impact', 'lowland': 'sedimentary', 'basin_mars': 'sedimentary',
    'outflow': 'fluvial', 'apron': 'glacial', 'polar': 'glacial', 'polar_dunes': 'aeolian',
}
PROCESS_TEXT = {'volcanic': ('火山作用', 'Volcanism'), 'impact': ('撞擊作用', 'Impact cratering'),
                'sedimentary': ('沉積作用', 'Sedimentation'), 'fluvial': ('水流作用', 'Fluvial activity'),
                'glacial': ('冰川與冰緣作用', 'Glacial and periglacial activity'), 'aeolian': ('風成作用', 'Aeolian activity')}
LAVA_SETTINGS = ('mare', 'pyroclastic', 'volcanic')


@lru_cache(maxsize=1)
def earth():
    z = np.load(DATA / 'earth_facets.npz')
    F = {k: z[k] for k in z.files}
    e = C.earth()
    assert (F['ids'] == e['ids']).all(), 'facet and condition tables are not aligned'
    acc, _ = C.access_data()
    F['road_km'], F['airport_km'] = acc['road_km'], acc['airport_km']
    return F


def model_mean_temp_k(body, abs_lat):
    """Approximate annual-mean surface temperature by latitude (model, not a measurement at the window)."""
    c = max(math.cos(math.radians(min(abs_lat, 89.0))), 0.0)
    return 215.0 * c ** 0.25 if body == 'moon' else 155.0 + 60.0 * c ** 1.5


def _g(v, match, partial, higher=True):
    v = np.asarray(v, np.float32)
    s = np.where(v >= match, 1.0, np.where(v >= partial, 0.5, 0.0)) if higher else np.where(v <= match, 1.0, np.where(v <= partial, 0.5, 0.0))
    return np.where(np.isfinite(v), s, np.nan).astype(np.float32)


def _tok(tid, facet, zh, en, q_zh, q_en, need_zh, need_en, unit='', uses=None, **params):
    return {'id': tid, 'facet': facet, 'label': {'zh': zh, 'en': en}, 'query': {'zh': q_zh, 'en': q_en},
            'need': {'zh': need_zh, 'en': need_en}, 'unit': unit, 'only_uses': uses, 'params': params}


def profile(body, lat, lon, km, cond_profile):
    """The query's tokens (frozen rules). cond_profile: conditions_v1 profile of the same window."""
    q = cond_profile['query']
    st = q.get('setting')
    abs_lat = abs(float(lat))
    toks = []
    cond_ids = {c['id']: c for c in cond_profile['conditions']}

    def cond(cid, facet):
        if cid in cond_ids:
            c = cond_ids[cid]
            toks.append({'id': cid, 'facet': facet, 'label': c['label'], 'query': c['query'], 'need': c['need'], 'unit': '',
                         'only_uses': None, 'params': {'condition': True, **c['params']}})

    toks.append(_tok('terrain_shape', 'A', '地形形狀', 'Terrain shape', '此窗格的 DEM 形狀', "this window's DEM shape",
                     '地形編碼相似度高', 'high terrain-encoder similarity'))
    cond('bare', 'B'); cond('lithology', 'B')
    tq = model_mean_temp_k(body, abs_lat)
    toks.append(_tok('mean_temp', 'C', '年均溫', 'Mean temperature', f'約 {tq - 273.15:.0f} °C（緯度模型）', f'about {tq - 273.15:.0f} °C (latitude model)',
                     f'年均溫差距在 {TOL_MEAN_TEMP_K:.0f} K 內', f'annual mean within {TOL_MEAN_TEMP_K:.0f} K', '°C', target_k=tq))
    toks.append(_tok('cold_floor', 'C', '極低溫', 'Extreme cold', '夜間約 −180 °C' if body == 'moon' else '夜間可低於 −100 °C',
                     'about −180 °C at night' if body == 'moon' else 'below −100 °C at night',
                     '最冷月平均日最低溫 ≤ −40 °C', 'coldest-month mean daily minimum ≤ −40 °C', '°C'))
    toks.append(_tok('diurnal', 'C', '日夜溫差', 'Day-night swing', '日夜溫差約 280 K' if body == 'moon' else '日夜溫差約 60–90 K',
                     'day-night swing about 280 K' if body == 'moon' else 'day-night swing about 60–90 K',
                     '平均日夜溫差 ≥ 15 K', 'mean diurnal range ≥ 15 K', 'K'))
    toks.append(_tok('noon_sun', 'D', '正午太陽仰角', 'Noon Sun elevation', f'春秋分正午約 {90 - abs_lat:.0f}°', f'about {90 - abs_lat:.0f}° at equinox noon',
                     '差距在 10° 內', 'within 10°', '°', target=90 - abs_lat))
    cond('low_sun', 'D')
    cond('dry', 'E'); cond('ground_ice', 'E'); cond('hydrated', 'E')
    if body == 'mars':
        cond('aeolian', 'F')
        if q.get('dusty') or st == 'polar_dunes':
            toks.append(_tok('dust_load', 'F', '空氣中的沙塵', 'Airborne dust', '塵覆蓋區，常有沙塵活動', 'dust-covered, frequent dust activity',
                             '氣膠光學厚度 ≥ 0.3', 'aerosol optical depth ≥ 0.3'))
            toks.append(_tok('wind', 'F', '風速', 'Wind', '風足以揚起沙塵', 'winds strong enough to lift dust',
                             '10 m 平均風速 ≥ 6 m/s', 'mean 10 m wind ≥ 6 m/s', 'm/s'))
    else:
        toks.append(_tok('loose_fines', 'F', '細粒鬆散表土', 'Loose fine soil', '細粒月壤，粉塵附著性強', 'fine regolith with clinging dust',
                         '表土粗碎屑 ≤ 15%', 'coarse fragments in topsoil ≤ 15%'))
    proc = PROCESS.get(st)
    if proc:
        pz, pe = PROCESS_TEXT[proc]
        st_zh, st_en = cond_profile['setting_text']['zh'], cond_profile['setting_text']['en']
        need = {'volcanic': ('距全新世火山 ≤ 60 km', '≤ 60 km from a Holocene volcano'),
                'impact': ('距已確認撞擊構造 ≤ 50 km', '≤ 50 km from a confirmed impact structure'),
                'sedimentary': ('沉積岩占一半以上', 'sedimentary rock over half the window'),
                'fluvial': ('未固結沉積物 ≥ 30%', 'unconsolidated sediment ≥ 30%'),
                'glacial': ('冰原、冰川或苔原氣候占一半以上', 'ice, glacier or tundra over half the window'),
                'aeolian': ('沙丘 ≥ 5%', 'dunes ≥ 5%')}[proc]
        toks.append(_tok('process', 'G', pz, pe, st_zh, st_en, need[0], need[1], process=proc))
    if body == 'mars':
        toks.append(_tok('water_limited', 'H', '缺水', 'Water-limited', '地表沒有穩定的液態水', 'no stable liquid water at the surface',
                         '極度乾燥（乾燥指數 ≤ 0.05）', 'hyper-arid (aridity index ≤ 0.05)'))
        toks.append(_tok('freezing', 'H', '長年冰凍', 'Freezing', '年均溫遠低於冰點', 'mean temperature far below freezing',
                         '年均溫 ≤ −10 °C', 'annual mean ≤ −10 °C', '°C'))
        toks.append(_tok('uv', 'H', '紫外線', 'Ultraviolet', '地表紫外線很強', 'strong surface ultraviolet',
                         '全日平均紫外線指數 ≥ 2.3（地球上最高的 5%）', '24-hour mean UV index ≥ 2.3 (the top 5% on Earth)'))
        toks.append(_tok('thin_air', 'H', '低氣壓', 'Low pressure', '氣壓約 0.6 kPa', 'pressure about 0.6 kPa',
                         '地面氣壓 ≤ 60 kPa（地球上最低的一端，仍是火星的 100 倍）', 'surface pressure ≤ 60 kPa (lowest on Earth, still 100 × Mars)', 'kPa'))
        if q.get('hydrated') or st == 'basin_mars':
            toks.append(_tok('salts', 'H', '鹽類', 'Salts', '含水礦物或盆地沉積', 'hydrated minerals or basin deposits',
                             '蒸發岩 ≥ 5%', 'evaporites ≥ 5%'))
    lava = st in LAVA_SETTINGS
    if lava:
        toks.append(_tok('lava_tube_terrain', 'I', '熔岩管地形', 'Lava-tube terrain', '玄武岩熔岩流區，可能有熔岩管', 'basaltic lava plains, lava tubes possible',
                         '距玄武岩全新世火山 ≤ 60 km 且玄武岩 ≥ 15%', '≤ 60 km from a basaltic Holocene volcano and basalt ≥ 15%'))
    toks.append(_tok('cave_access', 'I', '洞穴或坑道', 'Caves or mines', '地下空間可遮蔽輻射與溫差', 'underground space shields radiation and temperature swings',
                     '喀斯特 ≥ 30%，或 50 km 內有地下礦坑', 'karst ≥ 30%, or an underground mine within 50 km',
                     uses=None if lava else ('subsurface',)))
    toks.append(_tok('field_access', 'J', '野外可到達', 'Field access', '任務前需要反覆實地測試', 'needs repeated field testing before a mission',
                     '距道路 ≤ 30 km', '≤ 30 km from a road', 'km'))
    toks.append(_tok('airport', 'J', '後勤', 'Logistics', '設備與人員需要運補', 'equipment and crew need resupply',
                     '距機場 ≤ 300 km', '≤ 300 km from an airport', 'km'))
    return {'rules': RULES_VERSION, 'body': body, 'setting': st, 'abs_lat': abs_lat, 'tokens': toks,
            'limits': [{'id': i, 'label': {'zh': z, 'en': e}, 'target': {'zh': t, 'en': LIMITS_EN.get(t, t)},
                        'earth': {'zh': ea, 'en': LIMITS_EN.get(ea, ea)}} for i, z, e, t, ea in LIMITS[body]]}


def measure(tok, idx, cos=None):
    """token score (1 / 0.5 / 0 / NaN) and the Earth value shown, at table positions idx (-1 = window not in the table)."""
    F, e = earth(), C.earth()
    ok = idx >= 0
    j = np.where(ok, idx, 0)
    p, tid = tok['params'], tok['id']
    g = lambda k: F[k][j]
    ge = lambda k: e[k][j]
    if p.get('condition'):
        v, val = C.measure(tid, p, e, j)
        s = np.where(v >= 0, v / 2.0, np.nan)
    elif tid == 'terrain_shape':
        val = np.full(len(idx), np.nan) if cos is None else np.asarray(cos, np.float32)
        s = np.clip((val + 1) / 2, 0, 1)
        return s.astype(np.float32), val
    elif tid == 'mean_temp':
        val = g('t_mean_c'); s = np.where(np.isfinite(val), (np.abs(val + 273.15 - p['target_k']) <= TOL_MEAN_TEMP_K).astype(np.float32), np.nan)
    elif tid == 'cold_floor':
        val = g('t_cold_min_c'); s = _g(val, -40, -20, higher=False)
    elif tid == 'diurnal':
        val = g('t_diurnal_k'); s = _g(val, 15, 10)
    elif tid == 'noon_sun':
        val = 90 - ge('abs_lat'); s = _g(np.abs(val - p['target']), 10, 20, higher=False)
    elif tid == 'dust_load':
        val = g('aod'); s = _g(val, 0.3, 0.15)
    elif tid == 'wind':
        val = g('wind_ms'); s = _g(val, 6, 4)
    elif tid == 'loose_fines':
        val = ge('coarse_fragments'); s = _g(val, 0.15, 0.30, higher=False)
    elif tid == 'process':
        k = p['process']
        if k == 'volcanic':
            val = ge('volcano_km'); s = _g(val, 60, 150, higher=False)
        elif k == 'impact':
            val = g('impact_km'); s = _g(val, 50, 150, higher=False)
        elif k == 'sedimentary':
            val = ge('glim_ss') + ge('glim_sm') + ge('glim_su') + ge('glim_sc') + ge('glim_ev'); s = _g(val, 0.5, 0.25)
        elif k == 'fluvial':
            val = ge('glim_su'); s = _g(val, 0.3, 0.1)
        elif k == 'glacial':
            val = np.maximum(ge('koppen_ET') + ge('koppen_EF'), np.nan_to_num(ge('glim_ig'))); s = _g(val, 0.5, 0.2)
        else:
            val = ge('dune_share'); s = _g(val, 0.05, 0.01)
    elif tid == 'water_limited':
        val = ge('aridity_index'); s = _g(val, 0.05, 0.2, higher=False)
    elif tid == 'freezing':
        val = g('t_mean_c'); s = _g(val, -10, 0, higher=False)
    elif tid == 'uv':
        val = g('uv_index'); s = _g(val, 2.3, 2.0)
    elif tid == 'thin_air':
        val = g('pressure_kpa'); s = _g(val, 60, 75, higher=False)
    elif tid == 'salts':
        val = ge('glim_ev'); s = _g(val, 0.05, 0.01)
    elif tid == 'lava_tube_terrain':
        d, b = ge('basaltic_volcano_km'), ge('glim_vb') + ge('glim_py')
        val = d
        s = np.where((d <= 60) & (b >= 0.15), 1.0, np.where((d <= 150) | (b >= 0.15), 0.5, 0.0))
        s = np.where(np.isfinite(d) & np.isfinite(b), s, np.nan)
    elif tid == 'cave_access':
        kshare, mine = g('karst_share'), g('mine_km')
        val = kshare
        s = np.where((kshare >= 0.3) | (mine <= 50), 1.0, np.where((kshare >= 0.1) | (mine <= 150), 0.5, 0.0))
        s = np.where(np.isfinite(kshare), s, np.nan)
    elif tid == 'field_access':
        val = g('road_km'); s = _g(val, 30, 100, higher=False)
    elif tid == 'airport':
        val = g('airport_km'); s = _g(val, 300, 800, higher=False)
    else:
        raise KeyError(tid)
    return np.where(ok, s, np.nan).astype(np.float32), np.where(ok, val, np.nan)


def facet_scores(prof, idx, cos=None, use='overall'):
    """{facet: score array (NaN unknown)} over idx, counting only the tokens that belong to this use."""
    acc = {}
    for t in prof['tokens']:
        if t['only_uses'] and use not in t['only_uses']:
            continue
        s, _ = measure(t, idx, cos)
        a = acc.setdefault(t['facet'], [np.zeros(len(idx), np.float32), np.zeros(len(idx), np.float32)])
        k = np.isfinite(s)
        a[0] += np.where(k, s, 0); a[1] += k
    return {f: np.where(n > 0, tot / np.maximum(n, 1), np.nan).astype(np.float32) for f, (tot, n) in acc.items()}


def use_score(prof, idx, cos=None, use='overall'):
    """weighted mean of the facets of this use; NaN when under half of the applicable weight is known."""
    fs = facet_scores(prof, idx, cos, use)
    w = {f: wf for f, wf in USES[use].items() if f in fs}
    num = np.zeros(len(idx), np.float32); den = np.zeros(len(idx), np.float32)
    for f, wf in w.items():
        k = np.isfinite(fs[f])
        num += np.where(k, fs[f] * wf, 0); den += k * wf
    total = sum(w.values())
    return np.where(den >= 0.5 * total, num / np.maximum(den, 1e-9), np.nan).astype(np.float32), fs


_POS = {}


def positions(rows, row_indices, key=None):
    """table position of every row of one search scale (cached per scale), -1 when the window is not in the table."""
    k = (key, len(row_indices))
    if k not in _POS:
        pos = C.earth()['pos']
        _POS[k] = np.array([pos.get(rows[int(i)]['id'], -1) for i in row_indices])
    return _POS[k]


def _status(s):
    return 'unknown' if s is None or not np.isfinite(s) else 'strong' if s >= 0.99 else 'breaks' if s <= 0.01 else 'partial'


def _num(v):
    return None if v is None or not np.isfinite(v) else round(float(v), 3)


def candidate(prof, row_id, cos=None, use='overall'):
    """facet block of one Earth window for display: every token with the target, the Earth value and the verdict."""
    i = C.earth()['pos'].get(row_id, -1)
    idx = np.array([i]); cs = None if cos is None else np.array([cos], np.float32)
    S, fs = use_score(prof, idx, cs, use)
    items = {}
    for t in prof['tokens']:
        s, val = measure(t, idx, cs)
        counted = not (t['only_uses'] and use not in t['only_uses'])
        items.setdefault(t['facet'], []).append({'id': t['id'], 'label': t['label'], 'query': t['query'], 'need': t['need'],
                                                 'earth_value': _num(val[0]), 'unit': t['unit'], 'score': _num(s[0]),
                                                 'status': _status(s[0]), 'counted': counted})
    facets = []
    for f, zh, en in FACETS:
        if f not in items:
            facets.append({'id': f, 'label': {'zh': zh, 'en': en}, 'status': 'not_applicable', 'score': None, 'weight': 0, 'tokens': []})
            continue
        sc = fs[f][0] if f in fs else np.nan
        facets.append({'id': f, 'label': {'zh': zh, 'en': en}, 'status': _status(sc), 'score': _num(sc),
                       'weight': USES[use].get(f, 0), 'tokens': items[f]})
    flat = [x for f in facets for x in f['tokens'] if x['counted']]
    return {'rules': RULES_VERSION, 'use': use, 'score': _num(S[0]), 'facets': facets,
            'strong': [x['id'] for x in flat if x['status'] == 'strong'], 'partial': [x['id'] for x in flat if x['status'] == 'partial'],
            'breaks': [x['id'] for x in flat if x['status'] == 'breaks'], 'unknown': [x['id'] for x in flat if x['status'] == 'unknown']}


def summary(prof, S=None, fs=None, use='overall'):
    """query-level block: tokens asked, the limits Earth cannot reproduce, and the best Earth reaches (ceiling)."""
    out = {'rules': RULES_VERSION, 'body': prof['body'], 'use': use, 'use_label': dict(zip(('zh', 'en'), USE_TEXT[use])),
           'uses': [{'id': u, 'label': dict(zip(('zh', 'en'), t))} for u, t in USE_TEXT.items()],
           'facets': [{'id': f, 'label': {'zh': zh, 'en': en}, 'weight': USES[use].get(f, 0),
                       'tokens': [t['id'] for t in prof['tokens'] if t['facet'] == f]} for f, zh, en in FACETS],
           'limits': prof['limits']}
    if S is not None:
        out['ceiling'] = {'score': _num(np.nanmax(S)) if np.isfinite(S).any() else None,
                          'scored_windows': int(np.isfinite(S).sum()),
                          'facets': {f: _num(np.nanmax(a)) if np.isfinite(a).any() else None for f, a in fs.items()}}
    return out
