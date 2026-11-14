"""Pre-field check of a max-match candidate (2026-11-14): is this place already known, and what can be checked from orbit?

1. Catalogue: distance to the nearest of the 80 documented analog sites.
2. Literature: OpenAlex works whose title/abstract mention the nearest town (or its province) together with Mars/Moon
   and analog(ue). Name search is noisy: counts are leads for a human, not proof of novelty.
3. Challenge resources: the existing resource card (Sentinel-1, RADARSAT, NASA Earthdata granules, Worldview imagery).
Verdict (descriptive): catalogued (<= 50 km) / studied (papers name the place) / region studied / no record found.
Results are cached in data/research/atlas_match/prefield_cache.json; nothing here changes a ranking."""
import json
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'data/research/atlas_match/prefield_cache.json'
UA = {'User-Agent': 'twinground-prefield/1.0 (python urllib)'}
_LOCK = threading.Lock()
_MEM = None


def _cache():
    global _MEM
    if _MEM is None:
        _MEM = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else {}
    return _MEM


def _save():
    with _LOCK:
        CACHE.write_text(json.dumps(_cache(), ensure_ascii=False), encoding='utf-8')


def _openalex(term):
    """works whose title or abstract contain the exact place name AND a Moon/Mars word AND analog(ue)."""
    flt = (f'title_and_abstract.search:"{term}",title_and_abstract.search:(Mars OR Martian OR lunar OR Moon),'
           'title_and_abstract.search:(analog OR analogue)')
    url = 'https://api.openalex.org/works?per-page=3&select=id,display_name,publication_year,doi&filter=' + urllib.parse.quote(flt, safe=':,()"')
    d = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read())
    return {'query': flt, 'count': int(d['meta']['count']),
            'examples': [{'title': w.get('display_name'), 'year': w.get('publication_year'), 'doi': w.get('doi')} for w in d['results'][:3]]}


RETRY = (0,)  # waits (s) between OpenAlex attempts; the batch sets (0, 5, 20, 60), the web endpoint never waits
AMBIGUOUS = 30  # a town name alone with more hits than this is an ordinary word ("Bend"); search it with its province


def _lit(term):
    term = term.replace('"', '')
    key = 'lit2:' + term
    if key not in _cache():
        for n, wait in enumerate(RETRY):  # OpenAlex rate-limits bursts; back off and retry
            time.sleep(wait)
            try:
                _cache()[key] = _openalex(term)
                break
            except Exception:  # noqa: BLE001
                if n == len(RETRY) - 1:
                    raise
        time.sleep(1.0)
    return {**_cache()[key], 'term': term}


def literature(name, admin1):
    out = {}
    try:
        if name:
            r = _lit(name)
            if r['count'] > AMBIGUOUS and admin1:
                r = {**_lit(f'{name} {admin1}'), 'ambiguous_name': True}
            out['place'] = r
        if admin1:
            out['region'] = _lit(admin1)
    except Exception as exc:  # noqa: BLE001
        out['error'] = str(exc)[:120]
    return out


def check(body, qlat, qlon, lat, lon, km=40, resources=True):
    lat, lon = round(float(lat), 4), round(float(lon), 4)
    key = f'chk2:{body}:{round(float(qlat), 3)},{round(float(qlon), 3)}:{lat},{lon}:{int(resources)}'
    if key in _cache():
        return _cache()[key]
    from scripts.facets_v7 import offcat as O
    sid, dkm = O.nearest_site(lat, lon)
    site = next((s for s in O.SITES if s['id'] == sid), {})
    pl = O.place(lat, lon)
    lit = literature(pl.get('name'), pl.get('admin1'))
    n_place = (lit.get('place') or {}).get('count') or 0
    n_region = (lit.get('region') or {}).get('count') or 0
    unchecked = 'error' in lit or (pl.get('name') and 'place' not in lit)
    verdict = ('catalogued' if dkm <= 50 else 'unchecked' if unchecked else 'studied' if n_place > 0
               else 'region_studied' if n_region > 0 else 'no_record')
    out = {'lat': lat, 'lon': lon, 'place': pl,
           'catalogue': {'nearest': sid, 'name': site.get('name'), 'name_zh': site.get('name_zh'), 'distance_km': dkm},
           'literature': lit, 'verdict': verdict, 'checked_at': time.strftime('%Y-%m-%d', time.gmtime())}
    if resources:
        from scripts.facets_v61 import resources as fres
        try:
            c = fres.card(body, qlat, qlon, lat, lon, km)
            ed = c.get('earthdata') or {}
            radar = c.get('radar') or {}
            s1 = radar.get('sentinel1') if isinstance(radar.get('sentinel1'), dict) else {}
            r1 = radar.get('radarsat1') if isinstance(radar.get('radarsat1'), dict) else {}
            wv = c.get('worldview') or {}
            cols = [x for x in (ed.get('collections') or []) if isinstance(x, dict)]
            out['resources'] = {
                'earthdata': {'granules': int(sum(x.get('granules') or 0 for x in cols)),
                              'collections': [{'name': x.get('short_name'), 'label': x.get('label'), 'granules': x.get('granules')} for x in cols],
                              'link': ed.get('search_link')},
                'sentinel1': {k: s1.get(k) for k in ('date', 'vv_db', 'vh_db', 'coverage', 'error') if k in s1},
                'radarsat1': {k: r1.get(k) for k in ('images', 'first', 'last', 'error') if k in r1},
                'rcm': bool(radar.get('rcm')),
                'worldview': {'dates': [w.get('date') for w in (wv.get('images') or []) if isinstance(w, dict)][:4], 'link': wv.get('link')},
                'earth': c.get('earth')}
        except Exception as exc:  # noqa: BLE001
            out['resources'] = {'error': str(exc)[:160]}
    if verdict != 'unchecked':  # a failed lookup is retried next time instead of being remembered as "no record"
        _cache()[key] = out
    _save()
    return out
