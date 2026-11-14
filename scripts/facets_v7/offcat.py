"""Line C: off-catalogue candidates for flagship targets (facets v7 plan, 2026-11-13). Uses the live ranking (facets v6.0)
and the paper's resource-ceiling windows; changes no ranking. Output data/research/facets_v7/offcat_candidates.json
Off-catalogue = >= 100 km from every catalogue site, outside the four regions the challenge page names, few papers."""
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/facets_v7'
API = 'http://127.0.0.1:8765'
UA = {'User-Agent': 'facets-v7-offcat/1.0 (python urllib)'}
CAT = json.loads((ROOT / 'data/research/known_analogs/catalogue.json').read_text(encoding='utf-8'))
SITES = CAT['sites'] if isinstance(CAT, dict) else CAT
TARGETS = [  # (id, body, lat, lon, uses, note)
    ('artemis_haworth', 'moon', -87.45, -4.1, ['overall'], 'Artemis III candidate region (approximate centre)'),
    ('artemis_malapert', 'moon', -86.0, 2.9, ['overall'], 'Artemis III candidate region (approximate centre)'),
    ('artemis_mons_mouton', 'moon', -84.6, 31.5, ['overall'], 'Artemis III candidate region (approximate centre)'),
    ('marius_hills_pit', 'moon', 14.0917, -56.7701, ['overall', 'subsurface'], 'lava-tube skylight'),
    ('tranquillitatis_pit', 'moon', 8.3355, 33.222, ['overall', 'subsurface'], 'lava-tube skylight'),
    ('jezero', 'mars', 18.4, 77.7, ['overall', 'astrobiology'], 'Mars 2020 landing site'),
]
NAMED = [('Antarctica', -90, -60, -180, 180), ('Atacama', -28, -18, -72, -66), ('Iceland', 63, 67, -25, -13), ('Hawaii', 18, 23, -161, -154)]


def hav(la1, lo1, la2, lo2):
    p1, p2 = np.radians(la1), np.radians(la2)
    dl = np.radians((np.asarray(lo2) - lo1 + 180) % 360 - 180)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


SLAT = np.array([s['lat'] for s in SITES]); SLON = np.array([s['lon'] for s in SITES])
places = json.loads((ROOT / 'data/research/conditions_v1/sources/ne_10m_populated_places_simple.geojson').read_text(encoding='utf-8'))['features']
PLAT = np.array([f['geometry']['coordinates'][1] for f in places]); PLON = np.array([f['geometry']['coordinates'][0] for f in places])


def nearest_site(lat, lon):
    d = hav(lat, lon, SLAT, SLON); i = int(np.argmin(d))
    return SITES[i]['id'], round(float(d[i]), 1)


def place(lat, lon):
    d = hav(lat, lon, PLAT, PLON); i = int(np.argmin(d)); p = places[i]['properties']
    return {'name': p.get('name'), 'admin1': p.get('adm1name'), 'country': p.get('adm0name'), 'distance_km': round(float(d[i]), 1)}


def named_region(lat, lon):
    for n, a, b, c, d in NAMED:
        if a <= lat <= b and c <= lon <= d:
            return n
    return None


def get(url, timeout=600):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read())


def literature(name, admin1):
    """OpenAlex works mentioning the place together with planetary-analog words (title/abstract search)."""
    out = {}
    for label, term in (('place', name), ('region', admin1)):
        if not term:
            continue
        q = f'"{term}" AND (Mars OR Martian OR lunar OR Moon) AND (analog OR analogue)'
        try:
            d = get('https://api.openalex.org/works?per-page=3&select=id,display_name,publication_year&search=' + urllib.parse.quote(q), 60)
            out[label] = {'query': q, 'count': d['meta']['count'], 'examples': [w['display_name'] for w in d['results'][:3]]}
        except Exception as exc:  # noqa: BLE001
            out[label] = {'query': q, 'error': str(exc)[:120]}
        time.sleep(1.0)
    return out


def search(t, use):
    tid, body, lat, lon, _, _ = t
    path = '/api/mars-search' if body == 'mars' else '/api/search'
    p = {'lat': lat, 'lon': lon, 'size_km': 40, 'surface': 'any', 'rock': 'any', 'purpose': 'facets', 'limit': 30, 'offset': 0,
         'visual': 'complete', 'facet_use': use}
    a = get(API + path + '?' + urllib.parse.urlencode(p))
    rows = []
    for rank, m in enumerate(a['matches'], 1):
        f = m.get('facets') or {}
        rows.append({'rank': rank, 'lat': m['center']['latitude'], 'lon': m['center']['longitude_east'], 'score': m.get('score'),
                     'strong': f.get('strong'), 'partial': f.get('partial'), 'breaks': f.get('breaks'),
                     'catalogued': (m.get('known_analog') or {}).get('id')})
    return rows, (a.get('facets') or {}).get('ceiling')


def main():
    res = {'made': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'rule': 'off-catalogue: >= 100 km from every catalogue site and outside '
           'Antarctica, Atacama, Iceland and Hawaii; literature counts are reported, not used as a filter',
           'targets': []}
    for t in TARGETS:
        for use in t[4]:
            try:
                rows, ceiling = search(t, use)
            except Exception as exc:  # noqa: BLE001
                res['targets'].append({'id': t[0], 'use': use, 'error': str(exc)[:200]}); continue
            for r in rows:
                r['nearest_catalogue'], r['nearest_catalogue_km'] = nearest_site(r['lat'], r['lon'])
                r['named_region'] = named_region(r['lat'], r['lon'])
                r['off_catalogue'] = r['nearest_catalogue_km'] >= 100 and not r['named_region']
            res['targets'].append({'id': t[0], 'body': t[1], 'lat': t[2], 'lon': t[3], 'note': t[5], 'use': use,
                                   'source': 'live ranking facets-v6.0', 'ceiling': ceiling, 'candidates': rows})
            print(t[0], use, sum(r['off_catalogue'] for r in rows), 'off-catalogue of', len(rows), flush=True)
    # paper resource ceilings (v9 mission maps): Artemis south-polar resource use and Jezero resource use
    z = np.load(ROOT / 'data/research/pat_v1/posthoc_v9/mission_maps_v9.npz')
    for key, label in (('art_res', 'Artemis south-polar resource ceiling (paper v9)'), ('jez_res', 'Jezero resource ceiling (paper v9)')):
        v = z[key]; ok = np.isfinite(v)
        order = np.argsort(-np.where(ok, v, -1))[:40]
        rows = []
        for i in order:
            la, lo = float(z['lat'][i]), float(z['lon'][i])
            if rows and min(hav(la, lo, r['lat'], r['lon']) for r in rows) < 60:
                continue
            ns, nd = nearest_site(la, lo)
            rows.append({'lat': la, 'lon': lo, 'score': round(float(v[i]), 3), 'nearest_catalogue': ns, 'nearest_catalogue_km': nd,
                         'named_region': named_region(la, lo), 'off_catalogue': nd >= 100 and not named_region(la, lo)})
            if len(rows) >= 10:
                break
        res['targets'].append({'id': key, 'source': label, 'candidates': rows})
    # place names and literature for every off-catalogue candidate (deduplicated within 60 km)
    seen = []
    for t in res['targets']:
        for r in t.get('candidates', []):
            if not r.get('off_catalogue'):
                continue
            hit = next((s for s in seen if hav(r['lat'], r['lon'], s['lat'], s['lon']) < 60), None)
            if hit is None:
                hit = {'lat': r['lat'], 'lon': r['lon'], 'place': place(r['lat'], r['lon'])}
                hit['literature'] = literature(hit['place']['name'], hit['place']['admin1'])
                seen.append(hit)
            r['place'] = hit['place']; r['literature'] = hit['literature']
    (OUT / 'offcat_candidates.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    print('done', len(seen), 'distinct off-catalogue places', flush=True)


if __name__ == '__main__':
    main()
