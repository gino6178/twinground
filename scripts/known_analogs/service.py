"""Known terrestrial analog catalogue for the Analog Atlas search API.

Each /api/search match gets `known_analog`: the nearest catalogued Earth site that the literature already uses as an
analog for the query body (Moon or Mars), if one lies within RADIUS_KM of the candidate window centre; otherwise None.
None means "no catalogued analog nearby" (a new candidate), not that nobody has ever studied the place."""
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CATALOGUE = ROOT / 'data/research/known_analogs/catalogue.json'
RADIUS_KM = 50.0
EARTH_RADIUS_KM = 6371.0


@lru_cache(maxsize=1)
def catalogue():
    raw = CATALOGUE.read_bytes()
    data = json.loads(raw)
    sites = data['sites']
    latlon = np.radians(np.array([[s['lat'], s['lon']] for s in sites], dtype=float))
    bodies = {b: np.array([b in s['analog_for'] for s in sites]) for b in ('moon', 'mars')}
    return data, sites, latlon, bodies, hashlib.sha256(raw).hexdigest()


def distances_km(lat, lon):
    _, _, latlon, _, _ = catalogue()
    p1, p2 = math.radians(lat), latlon[:, 0]
    dl = latlon[:, 1] - math.radians(lon)
    a = np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def nearest(lat, lon, body):
    """Nearest catalogued `body` analog within RADIUS_KM of an Earth candidate centre, or None."""
    try:
        _, sites, _, bodies, _ = catalogue()
    except (OSError, ValueError, KeyError):
        return None
    d = distances_km(lat, lon)
    ok = bodies[body] & (d <= RADIUS_KM)
    if not ok.any():
        return None
    k = int(np.flatnonzero(ok)[np.argmin(d[ok])])
    s = sites[k]
    return {'id': s['id'], 'name': s['name'], 'name_zh': s.get('name_zh'), 'distance_km': round(float(d[k]), 1),
            'analog_for': s['analog_for'], 'analog_type': s['analog_type'], 'tags': s['tags'],
            'program_or_use': s.get('program_or_use'), 'source': s['source'], 'source_url': s['source_url']}


def summary():
    """Catalogue identity for API answers; the front end should badge candidates only when available is true."""
    try:
        data, sites, _, bodies, sha = catalogue()
    except (OSError, ValueError, KeyError):
        return {'available': False, 'reason': 'known-analog catalogue not found'}
    return {'available': True, 'version': data['version'], 'sha256': sha, 'radius_km': RADIUS_KM,
            'sites': len(sites), 'moon_sites': int(bodies['moon'].sum()), 'mars_sites': int(bodies['mars'].sum()),
            'file': str(CATALOGUE.relative_to(ROOT)),
            'rule': f'Nearest catalogued analog of the query body within {RADIUS_KM:.0f} km of the candidate window centre; '
                    'null = no catalogued analog nearby (new candidate), not proof the place is unstudied.'}
