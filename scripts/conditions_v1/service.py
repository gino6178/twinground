"""Conditions v1: what a Moon or Mars window asks of an Earth analog (environment, geology, resources), checked
against open Earth data for every gallery window, plus the site dossier (what can be tested there, how to get there).

Query side (Moon): USGS Unified Geologic Map unit setting, Lunar Prospector FeO and Ti, latitude.
Query side (Mars): USGS SIM 3292 unit setting, OMEGA/CRISM descriptors (dust, hydrated minerals), SWIM ice consistency.
Earth side (every window): GLiM lithology, ESA WorldCover, Koppen, aridity index, temperature regime, aeolian dunes,
SoilGrids, GVP volcano distance (material-v5 covariates), Natural Earth roads, towns and airports.

Every threshold below is part of the frozen rule set RULES_VERSION; the validation protocol records this file's hash.
Verdicts: 2 match, 1 partial, 0 mismatch, -1 no Earth data. A condition that does not apply to the query is absent."""
import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data/research/conditions_v1'
RULES_VERSION = 'conditions-v1.1'  # v1.1: ice sheets and glaciers (GLiM) are not bare ground; v1 frozen in service_v1_frozen.py
GATE_LEVELS = (0.75, 0.6, 0.5)
MIN_POOL = 600  # above the 512-window shortlist, so the shortlist never reaches outside the pool

MOON_SETTING = {
    'mare': 'Im1 Im2 Em Imd EIp', 'pyroclastic': 'Id',
    'crater': 'Cc Ec Ic Ic1 Ic2 Nc pNc Icc Ecc Ccc Icf Iic Isc Esc Csc',
    'terra': 'Nt pNt INt It Ntp Itd',
    'basin': 'pNb Ib Nb Nbl Nbm pNbm Ibm Nbsc Iohi Ioho Iohs Iork Iorm Iom Iif Iia Iiap Nnj Ig',
    'plains': 'Ip INp Np',
}
MOON_UNIT_SETTING = {u: s for s, units in MOON_SETTING.items() for u in units.split()}
SETTING_TEXT = {
    'mare': ('月海玄武岩', 'mare basalt'), 'pyroclastic': ('火山碎屑（暗色披覆）', 'pyroclastic dark mantle'),
    'crater': ('撞擊坑物質', 'crater material'), 'terra': ('高地', 'highland terra'), 'basin': ('盆地噴出物', 'basin ejecta'),
    'plains': ('高地平原', 'highland plains'), 'volcanic': ('火山單元', 'volcanic unit'),
    'highland': ('古老高地地殼', 'ancient highland crust'), 'lowland': ('北部低地平原', 'northern lowland plains'),
    'outflow': ('過渡帶與外流河道', 'transition and outflow channels'), 'basin_mars': ('盆地沉積', 'basin fill'),
    'apron': ('岩屑裙（富冰）', 'debris apron (ice-rich)'), 'polar': ('極區沉積', 'polar deposits'),
    'polar_dunes': ('極區沙丘', 'polar dunes'), 'impact': ('撞擊單元', 'impact unit'),
}
LITHOLOGY_TEXT = {
    'basaltic': ('基性火山岩（玄武岩）', 'basic volcanic rock (basalt)'),
    'anorthositic': ('基性深成岩（輝長岩、斜長岩）', 'basic plutonic rock (gabbro, anorthosite)'),
    'sedimentary': ('沉積岩與未固結沉積物', 'sedimentary rock and unconsolidated sediment'),
}


# ------------------------------------------------------------------------------------------------ data
@lru_cache(maxsize=1)
def earth():
    d = np.load(DATA / 'earth_conditions.npz')
    e = {k: d[k] for k in d.files}
    e['pos'] = {str(i): n for n, i in enumerate(e['ids'])}
    return e


@lru_cache(maxsize=1)
def access_data():
    d = np.load(DATA / 'earth_access.npz')
    acc = {k: d[k] for k in d.files}
    assert (acc['ids'] == earth()['ids']).all(), 'access and condition tables are not aligned'
    return acc, json.loads((DATA / 'earth_access_lookup.json').read_text(encoding='utf-8'))


@lru_cache(maxsize=1)
def mars_geology():
    return np.load(DATA / 'mars_geology_01deg.npz')['grid'], json.loads((DATA / 'mars_geology_01deg.json').read_text(encoding='utf-8'))


@lru_cache(maxsize=1)
def swim():
    import rasterio
    out = {}
    for depth in ('0_1', '1_5'):
        with rasterio.open(DATA / f'sources/SWIM4MIM_Ci_{depth}.tif') as src:
            a = src.read(1).astype(np.float32)
            a[a <= -29] = np.nan
            out[depth] = a
    return out  # 0.05 deg, rows from 60N, columns from 180W (simple cylindrical, east-positive)


def window_points(lat, lon, km, radius_km, n=9):
    half = km / 2 / (math.pi * radius_km / 180)
    lats = np.clip(lat + np.linspace(-half, half, n), -89.99, 89.99)
    lons = lon + np.linspace(-half, half, n) / max(math.cos(math.radians(lat)), 0.05)
    la, lo = np.meshgrid(lats, lons, indexing='ij')
    return la.ravel(), ((lo.ravel() + 180) % 360) - 180


# ------------------------------------------------------------------------------------------------ query side
def _moon_query(lat, lon, km):
    import sys
    sys.path.insert(0, str(ROOT / 'src'))
    from moon_geology import geology_observation
    from lunar_pipeline import lunar_geochemistry_observation
    geo = geology_observation(lat, lon, km)
    unit = (geo.get('dominant_unit') or {}) if geo.get('available') else {}
    code = unit.get('code')
    setting = MOON_UNIT_SETTING.get(code)
    try:
        chem = lunar_geochemistry_observation(lat, lon, km)
    except Exception:
        chem = {'available': False}
    feo = chem.get('feo_weight_percent') if chem.get('available') else None
    ti = chem.get('titanium_weight_percent') if chem.get('available') else None
    if feo is not None and feo >= 14:
        comp = 'basaltic'
    elif feo is not None and feo <= 9:
        comp = 'anorthositic'
    else:
        comp = 'basaltic' if setting in ('mare', 'pyroclastic') else 'anorthositic' if setting else None
    return {'body': 'moon', 'unit': {'code': code, 'description': unit.get('description'), 'source': geo.get('source')},
            'setting': setting, 'composition': comp, 'feo_wt': feo, 'ti_wt': ti, 'polar': abs(lat) >= 75,
            'abs_lat': abs(lat)}


def _mars_query(lat, lon, km):
    from scripts.material_v5 import material_query as mq
    grid, meta = mars_geology()
    la, lo = window_points(lat, lon, km, 3389.5)
    rows = np.clip(((90 - la) / 0.1).astype(int), 0, grid.shape[0] - 1)
    cols = np.clip(((lo + 180) / 0.1).astype(int), 0, grid.shape[1] - 1)
    ids, counts = np.unique(grid[rows, cols], return_counts=True)
    keep = ids > 0
    ids, counts = ids[keep], counts[keep]
    units = [{**meta['units'][str(int(i))], 'share': round(float(c / counts.sum()), 2)} for i, c in sorted(zip(ids, counts), key=lambda x: -x[1])]
    setting = units[0]['setting'] if units else None
    if setting == 'basin':
        setting = 'basin_mars'
    try:
        desc = mq.mars_descriptor(lat, lon, km)
    except Exception:
        desc = {}
    ice01 = ice15 = None
    if abs(lat) <= 60:
        s = swim()
        r = np.clip(((60 - la) / 0.05).astype(int), 0, s['0_1'].shape[0] - 1)
        c = np.clip(((lo + 180) / 0.05).astype(int), 0, s['0_1'].shape[1] - 1)
        v01, v15 = s['0_1'][r, c], s['1_5'][r, c]
        ice01 = round(float(np.nanmean(v01)), 3) if np.isfinite(v01).any() else None
        ice15 = round(float(np.nanmean(v15)), 3) if np.isfinite(v15).any() else None
    ice = (setting in ('polar', 'polar_dunes', 'apron') or abs(lat) > 60 or
           (ice01 is not None and ice01 >= 0.25) or (ice15 is not None and ice15 >= 0.25))
    comp = 'basaltic' if setting in ('volcanic', 'highland') else 'sedimentary' if setting in ('basin_mars', 'lowland', 'outflow') else None
    return {'body': 'mars', 'unit': units[0] if units else None, 'units': units[:3], 'setting': setting, 'composition': comp,
            'dusty': bool(desc.get('dusty')), 'hydrated': bool(desc.get('hydrated')),
            'hydrous_detections': (desc.get('raw') or {}).get('hydrous_count'), 'ice_consistency_0_1m': ice01,
            'ice_consistency_1_5m': ice15, 'ice_likely': bool(ice), 'abs_lat': abs(lat)}


def _cond(cid, category, zh, en, q_zh, q_en, need_zh, need_en, **params):
    return {'id': cid, 'category': category, 'label': {'zh': zh, 'en': en}, 'query': {'zh': q_zh, 'en': q_en},
            'need': {'zh': need_zh, 'en': need_en}, 'params': params}


def query_profile(body, lat, lon, km):
    """The query's own conditions and the list of conditions it asks of Earth (frozen rule set)."""
    q = _mars_query(lat, lon, km) if body == 'mars' else _moon_query(lat, lon, km)
    st = q['setting']
    st_zh, st_en = SETTING_TEXT.get(st, ('未知', 'unknown'))
    unit_code = (q.get('unit') or {}).get('code')
    conds = []
    if body == 'moon':
        conds.append(_cond('dry', 'environment', '乾燥', 'Dryness', '無大氣、無液態水', 'no atmosphere, no liquid water',
                           '乾燥或極乾燥（乾燥指數 ≤ 0.2）', 'arid or hyper-arid (aridity index ≤ 0.2)'))
        conds.append(_cond('bare', 'environment', '裸露地表', 'Bare ground', '全為裸露的表岩屑', 'bare regolith everywhere',
                           '裸地或稀疏植被 ≥ 60%', 'bare or sparse vegetation ≥ 60%'))
        if q['polar']:
            conds.append(_cond('cold', 'environment', '低溫', 'Cold', '極區，陰影處可低於 −230 °C', 'polar; shadows can be below −230 °C',
                               '寒冷氣候占一半以上', 'cold climate over half the window'))
            conds.append(_cond('low_sun', 'environment', '低太陽角', 'Low sun', '太陽高度角常低於 5°', 'sun usually below 5° elevation',
                               '緯度 ≥ 60°', 'latitude ≥ 60°'))
            conds.append(_cond('ground_ice', 'resource', '水冰（資源）', 'Water ice (resource)', '極區冷阱可能有水冰（未以資料確認）',
                               'polar cold traps may hold ice (not confirmed by data here)', '凍土氣候（苔原或冰原）占一半以上',
                               'frozen-ground climate (tundra or ice cap) over half the window'))
        if q['composition']:
            lz, le = LITHOLOGY_TEXT[q['composition']]
            chem_zh = f"FeO {q['feo_wt']:.1f} wt%" + (f"、Ti {q['ti_wt']:.1f} wt%" if q['ti_wt'] is not None else '') if q['feo_wt'] is not None else '無 LP 化學資料'
            chem_en = f"FeO {q['feo_wt']:.1f} wt%" + (f", Ti {q['ti_wt']:.1f} wt%" if q['ti_wt'] is not None else '') if q['feo_wt'] is not None else 'no LP chemistry'
            rock_zh = '月海玄武岩' if q['composition'] == 'basaltic' else '高地斜長岩'
            rock_en = 'mare basalt' if q['composition'] == 'basaltic' else 'highland anorthosite'
            conds.append(_cond('lithology', 'resource', '岩性（ISRU 原料）', 'Rock type (ISRU feedstock)',
                               f'{rock_zh}（{chem_zh}）', f'{rock_en} ({chem_en})', f'{lz}占比高', f'mostly {le}',
                               kind=q['composition']))
        if st in ('mare', 'pyroclastic') and q['composition'] == 'basaltic':
            conds.append(_cond('volcanic', 'geology', '玄武岩火山背景', 'Basaltic volcanic setting', f'{st_zh}（{unit_code}）',
                               f'{st_en} ({unit_code})', '距玄武岩全新世火山 ≤ 60 km', '≤ 60 km from a basaltic Holocene volcano'))
    else:
        conds.append(_cond('dry', 'environment', '乾燥', 'Dryness', '地表沒有液態水', 'no liquid water at the surface',
                           '乾燥或極乾燥（乾燥指數 ≤ 0.2）', 'arid or hyper-arid (aridity index ≤ 0.2)'))
        conds.append(_cond('bare', 'environment', '裸露地表', 'Bare ground', '全為裸露地表', 'bare ground everywhere',
                           '裸地或稀疏植被 ≥ 60%', 'bare or sparse vegetation ≥ 60%'))
        conds.append(_cond('cold', 'environment', '低溫', 'Cold', '年均溫約 −60 °C', 'mean temperature about −60 °C',
                           '寒冷氣候占一半以上', 'cold climate over half the window'))
        if q['abs_lat'] >= 70:
            conds.append(_cond('low_sun', 'environment', '低太陽角', 'Low sun', f"高緯度（{q['abs_lat']:.0f}°）",
                               f"high latitude ({q['abs_lat']:.0f}°)", '緯度 ≥ 60°', 'latitude ≥ 60°'))
        if q['ice_likely']:
            if q['ice_consistency_0_1m'] is not None:
                ice_zh = f"SWIM 冰一致性 {q['ice_consistency_0_1m']:+.2f}（0–1 m）、{q['ice_consistency_1_5m']:+.2f}（1–5 m）"
                ice_en = f"SWIM ice consistency {q['ice_consistency_0_1m']:+.2f} (0–1 m), {q['ice_consistency_1_5m']:+.2f} (1–5 m)"
            else:
                ice_zh, ice_en = f'{st_zh}（{unit_code}），SWIM 範圍外', f'{st_en} ({unit_code}), outside SWIM coverage'
            conds.append(_cond('ground_ice', 'resource', '地下冰（資源）', 'Ground ice (resource)', ice_zh, ice_en,
                               '凍土氣候（苔原或冰原）占一半以上', 'frozen-ground climate (tundra or ice cap) over half the window'))
        if q['composition']:
            lz, le = LITHOLOGY_TEXT[q['composition']]
            conds.append(_cond('lithology', 'geology', '岩性', 'Rock type', f'{st_zh}（{unit_code}）', f'{st_en} ({unit_code})',
                               f'{lz}占比高', f'mostly {le}', kind=q['composition']))
        if st == 'volcanic':
            conds.append(_cond('volcanic', 'geology', '玄武岩火山背景', 'Basaltic volcanic setting', f'{st_zh}（{unit_code}）',
                               f'{st_en} ({unit_code})', '距玄武岩全新世火山 ≤ 60 km', '≤ 60 km from a basaltic Holocene volcano'))
        if q['dusty'] or st == 'polar_dunes':
            conds.append(_cond('aeolian', 'environment', '風成沙與粉塵', 'Wind-blown sand and dust',
                               '極區沙丘' if st == 'polar_dunes' else 'OMEGA 顯示亮色、富鐵的塵覆蓋',
                               'polar dunes' if st == 'polar_dunes' else 'OMEGA shows bright ferric dust cover',
                               '有沙丘或表土富含沙', 'dunes or sandy soil'))
        if q['hydrated']:
            n = q['hydrous_detections']
            conds.append(_cond('hydrated', 'resource', '含水礦物（資源）', 'Hydrated minerals (resource)',
                               f'CRISM 含水礦物偵測 {n:.0f} 處' if n else 'CRISM 偵測到含水礦物',
                               f'CRISM hydrated-mineral detections: {n:.0f}' if n else 'CRISM hydrated minerals detected',
                               '有蒸發岩或富黏土土壤', 'evaporites or clay-rich soil'))
    return {'rules': RULES_VERSION, 'body': body, 'setting': st, 'setting_text': {'zh': st_zh, 'en': st_en},
            'query': q, 'conditions': conds}


# ------------------------------------------------------------------------------------------------ Earth side
def _grade(v, match, partial, higher=True):
    v = np.asarray(v, np.float32)
    g = np.where(v >= match, 2, np.where(v >= partial, 1, 0)) if higher else np.where(v <= match, 2, np.where(v <= partial, 1, 0))
    return np.where(np.isfinite(v), g, -1).astype(np.int8)


def measure(cid, params, e, idx):
    """Earth measure for condition `cid` at gallery positions `idx` -> (verdict int8 array, value array)."""
    g = lambda k: e[k][idx]
    if cid == 'dry':
        v = g('aridity_index'); return _grade(v, 0.2, 0.5, higher=False), v
    if cid == 'bare':
        # ESA WorldCover barely covers Antarctica (its fractions there do not sum to 1), so GLiM ice and glaciers
        # decide first: a window mostly under ice is not exposed ground.
        v = g('bare_sparse') + g('moss_lichen')
        ice = np.nan_to_num(g('glim_ig')) >= 0.5
        return np.where(ice, 0, _grade(v, 0.6, 0.3)).astype(np.int8), np.where(ice, np.nan_to_num(g('glim_ig')) * -1, v)
    if cid == 'cold':
        v = g('cold'); return _grade(v, 0.5, 0.2), v
    if cid == 'ground_ice':
        v = g('koppen_ET') + g('koppen_EF'); return _grade(v, 0.5, 0.2), v
    if cid == 'low_sun':
        v = g('abs_lat'); return _grade(v, 60, 50), v
    if cid == 'volcanic':
        v = g('basaltic_volcano_km'); return _grade(v, 60, 150, higher=False), v
    if cid == 'lithology':
        kind = params['kind']
        if kind == 'basaltic':
            v = g('glim_vb') + g('glim_py'); return _grade(v, 0.4, 0.15), v
        if kind == 'anorthositic':
            v = g('glim_pb'); return _grade(v, 0.25, 0.08), v
        v = g('glim_ss') + g('glim_sm') + g('glim_su') + g('glim_sc') + g('glim_ev'); return _grade(v, 0.5, 0.25), v
    if cid == 'aeolian':
        dune, sand = g('dune_share'), g('sand')
        verdict = np.where(dune >= 0.05, 2, np.where((dune >= 0.01) | (np.nan_to_num(sand) >= 0.6), 1, 0)).astype(np.int8)
        return np.where(np.isfinite(dune), verdict, -1).astype(np.int8), dune
    if cid == 'hydrated':
        ev, clay = g('glim_ev'), g('clay')
        verdict = np.where(ev >= 0.05, 2, np.where((ev >= 0.01) | (np.nan_to_num(clay) >= 0.35), 1, 0)).astype(np.int8)
        return np.where(np.isfinite(ev), verdict, -1).astype(np.int8), ev
    raise KeyError(cid)


def fit(profile, idx):
    """Condition fit in [0, 1] (mean of verdict/2 over applicable conditions with Earth data); NaN when under half known."""
    e = earth()
    idx = np.asarray(idx)
    total = np.zeros(len(idx), np.float32); known = np.zeros(len(idx), np.float32)
    for c in profile['conditions']:
        v, _ = measure(c['id'], c['params'], e, np.where(idx >= 0, idx, 0))
        ok = (v >= 0) & (idx >= 0)
        total += np.where(ok, v / 2.0, 0); known += ok
    n = max(len(profile['conditions']), 1)
    return np.where(known >= n / 2, total / np.maximum(known, 1), np.nan).astype(np.float32)


def gate(profile, rows, row_indices):
    """Condition-first pool for ranking: windows whose fit reaches the first level that leaves >= MIN_POOL windows."""
    pos = earth()['pos']
    idx = np.array([pos.get(rows[int(i)]['id'], -1) for i in row_indices])
    f = fit(profile, idx)
    level = GATE_LEVELS[-1]
    for level in GATE_LEVELS:
        if np.nansum(f >= level) >= MIN_POOL:
            break
    g = np.nan_to_num(f, nan=-1) >= level
    return g, f, {'rules': RULES_VERSION, 'gate_level': level, 'gate_levels': list(GATE_LEVELS), 'min_pool': MIN_POOL,
                  'gated_windows': int(g.sum()), 'conditions_applied': [c['id'] for c in profile['conditions']],
                  'earth_coverage': round(float((idx >= 0).mean()), 4)}


# ------------------------------------------------------------------------------------------------ per candidate
def _fmt(cid, params, value, e, i):
    pct = lambda x: f'{100 * x:.0f}%'
    if not np.isfinite(value):
        return {'zh': '無資料', 'en': 'no data'}
    if cid == 'dry':
        cls = ['極乾燥', 'hyper-arid'] if value < 0.05 else ['乾燥', 'arid'] if value < 0.2 else ['半乾燥', 'semi-arid'] if value < 0.5 \
            else ['半濕潤', 'dry sub-humid'] if value < 0.65 else ['濕潤', 'humid']
        return {'zh': f'乾燥指數 {value:.2f}（{cls[0]}）', 'en': f'aridity index {value:.2f} ({cls[1]})'}
    if cid == 'bare':
        if value < 0:
            return {'zh': f'冰川或冰原覆蓋 {pct(-value)}（GLiM）', 'en': f'glaciers or ice sheet {pct(-value)} (GLiM)'}
        return {'zh': f'裸地與稀疏植被 {pct(value)}', 'en': f'bare or sparse vegetation {pct(value)}'}
    if cid == 'cold':
        return {'zh': f'寒冷氣候占 {pct(value)}', 'en': f'cold climate {pct(value)} of the window'}
    if cid == 'ground_ice':
        return {'zh': f'苔原或冰原氣候 {pct(value)}（凍土以氣候推估）', 'en': f'tundra or ice-cap climate {pct(value)} (frozen ground inferred from climate)'}
    if cid == 'low_sun':
        return {'zh': f'緯度 {value:.0f}°', 'en': f'latitude {value:.0f}°'}
    if cid == 'volcanic':
        return {'zh': f'距最近玄武岩全新世火山 {value:.0f} km', 'en': f'{value:.0f} km to the nearest basaltic Holocene volcano'}
    if cid == 'lithology':
        lz, le = LITHOLOGY_TEXT[params['kind']]
        return {'zh': f'{lz} {pct(value)}', 'en': f'{le} {pct(value)}'}
    if cid == 'aeolian':
        sand = e['sand'][i]
        s_zh = f'、表土含沙 {pct(sand)}' if np.isfinite(sand) else ''
        s_en = f', sand {pct(sand)} of topsoil' if np.isfinite(sand) else ''
        return {'zh': f'沙丘 {pct(value)}{s_zh}', 'en': f'dunes {pct(value)}{s_en}'}
    if cid == 'hydrated':
        clay = e['clay'][i]
        c_zh = f'、表土黏土 {pct(clay)}' if np.isfinite(clay) else ''
        c_en = f', topsoil clay {pct(clay)}' if np.isfinite(clay) else ''
        return {'zh': f'蒸發岩 {pct(value)}{c_zh}', 'en': f'evaporites {pct(value)}{c_en}'}
    return {'zh': f'{value:.2f}', 'en': f'{value:.2f}'}


TESTS = [
    # id, zh, en, required condition ids (all applicable ones must hold), extra rule
    ('mobility', '車輛與步行通過性', 'Vehicle and walking mobility', ('bare',), 'slope'),
    ('drilling', '鑽探與岩芯取樣', 'Drilling and coring', ('lithology',), None),
    ('isru', 'ISRU 原料試驗', 'ISRU feedstock trials', ('lithology',), 'isru'),
    ('ice', '冰的探勘與開採', 'Ice prospecting and extraction', ('ground_ice',), None),
    ('cold_ops', '低溫下的設備運作', 'Equipment in the cold', ('cold',), None),
    ('dust', '粉塵與風沙', 'Dust and wind-blown sand', ('aeolian',), None),
    ('caves', '熔岩管與洞穴作業', 'Lava-tube and cave operations', ('volcanic', 'lithology'), None),
    ('water_minerals', '含水礦物取樣', 'Sampling hydrated minerals', ('hydrated',), None),
    ('lighting', '低太陽角照明與導航', 'Low-sun lighting and navigation', ('low_sun',), None),
]


def candidate(profile, row_id, slope_gap_deg=None):
    """Condition table, testable activities and access for one Earth window."""
    e = earth()
    i = e['pos'].get(str(row_id))
    if i is None:
        return {'available': False, 'reason': 'window not in the Earth condition table'}
    rows, verdicts = [], {}
    for c in profile['conditions']:
        v, val = measure(c['id'], c['params'], e, np.array([i]))
        verdicts[c['id']] = int(v[0])
        rows.append({'id': c['id'], 'category': c['category'], 'label': c['label'], 'query': c['query'], 'need': c['need'],
                     'earth': _fmt(c['id'], c['params'], float(val[0]), e, i), 'verdict': int(v[0])})
    f = fit(profile, np.array([i]))[0]
    tests = []
    for tid, zh, en, needs, extra in TESTS:
        if extra == 'isru' and not (profile['body'] == 'moon' or profile['query'].get('composition') == 'basaltic'):
            continue
        applicable = [n for n in needs if n in verdicts]
        if len(applicable) != len(needs):
            continue
        vals = [verdicts[n] for n in applicable]
        if extra == 'slope':
            if slope_gap_deg is None:
                continue
            vals.append(2 if slope_gap_deg <= 2 else 1 if slope_gap_deg <= 5 else 0)
        status = 'yes' if min(vals) == 2 else 'partly' if min(vals) >= 1 else 'no'
        tests.append({'id': tid, 'label': {'zh': zh, 'en': en}, 'status': status, 'based_on': applicable + (['slope'] if extra == 'slope' else [])})
    acc, lookup = access_data()
    j = i  # earth_access.npz and earth_conditions.npz share the gallery row order (checked in build.py)
    place = lookup['places'][int(acc['place_idx'][j])]
    airport = lookup['airports'][int(acc['airport_idx'][j])]
    road_km, place_km = float(acc['road_km'][j]), float(acc['place_km'][j])
    remote = 'yes' if place_km >= 100 and road_km >= 25 else 'partly' if place_km >= 50 else 'no'
    tests.append({'id': 'isolation', 'label': {'zh': '偏遠地區長期演練', 'en': 'Long-duration remote operations'},
                  'status': remote, 'based_on': ['access']})
    return {'available': True, 'rules': RULES_VERSION, 'fit': None if not np.isfinite(f) else round(float(f), 3),
            'matched': sum(v == 2 for v in verdicts.values()), 'partial': sum(v == 1 for v in verdicts.values()),
            'mismatched': sum(v == 0 for v in verdicts.values()), 'unknown': sum(v < 0 for v in verdicts.values()),
            'rows': rows, 'tests': tests,
            'access': {'road_km': round(road_km, 1), 'place': {**place, 'distance_km': round(place_km, 1)},
                       'airport': {**airport, 'distance_km': round(float(acc['airport_km'][j]), 1)},
                       'source': lookup['source'], 'source_url': lookup['source_url'], 'note': lookup['note']}}


SOURCES = {
    'moon': ['USGS Unified Geologic Map of the Moon (2020)', 'Lunar Prospector GRS FeO and Ti'],
    'mars': ['USGS SIM 3292 Geologic Map of Mars (Tanaka et al. 2014)', 'SWIM ice consistency (PSI / JPL)', 'OMEGA and CRISM descriptors'],
    'earth': ['GLiM lithology', 'ESA WorldCover 2021', 'Koppen-Geiger climate', 'Global Aridity Index', 'SoilGrids 2.0',
              'GVP Holocene volcanoes', 'Natural Earth roads, towns and airports'],
}


def summary(profile):
    q = profile['query']
    return {'rules': RULES_VERSION, 'body': profile['body'], 'setting': profile['setting'], 'setting_text': profile['setting_text'],
            'unit': q.get('unit'), 'query': {k: q.get(k) for k in ('composition', 'feo_wt', 'ti_wt', 'dusty', 'hydrated',
                                                                   'ice_consistency_0_1m', 'ice_consistency_1_5m', 'ice_likely')},
            'conditions': [{k: c[k] for k in ('id', 'category', 'label', 'query', 'need')} for c in profile['conditions']],
            'sources': SOURCES[profile['body']] + SOURCES['earth']}
