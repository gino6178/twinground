"""Display-only companion to conditions service.py (whose rules stay frozen): the numeric Earth value of every
condition row and the scale the results page draws it on, so each condition can be shown as a gauge with its
match and partial zones. Thresholds below mirror service.measure() exactly; nothing here changes a verdict."""
import numpy as np

from scripts.conditions_v1 import service as cs

# id -> (min, max, match threshold, partial threshold, higher is better, unit)
SCALE = {
    'dry': (0.0, 1.0, 0.2, 0.5, False, ''),
    'bare': (0.0, 1.0, 0.6, 0.3, True, '%'),
    'cold': (0.0, 1.0, 0.5, 0.2, True, '%'),
    'ground_ice': (0.0, 1.0, 0.5, 0.2, True, '%'),
    'low_sun': (0.0, 90.0, 60.0, 50.0, True, '°'),
    'volcanic': (0.0, 400.0, 60.0, 150.0, False, 'km'),
    'aeolian': (0.0, 0.2, 0.05, 0.01, True, '%'),
    'hydrated': (0.0, 0.2, 0.05, 0.01, True, '%'),
}
LITHOLOGY = {'basaltic': (0.4, 0.15), 'anorthositic': (0.25, 0.08), 'sedimentary': (0.5, 0.25)}


def decorate(profile, row_id, candidate):
    """Add {'gauge': {...}} to every row of a conditions.candidate() result (in place) and return it."""
    if not candidate or not candidate.get('available'):
        return candidate
    e = cs.earth()
    i = e['pos'].get(str(row_id))
    if i is None:
        return candidate
    params = {c['id']: c['params'] for c in profile['conditions']}
    for r in candidate['rows']:
        cid = r['id']
        _, val = cs.measure(cid, params.get(cid, {}), e, np.array([i]))
        v = float(val[0])
        if cid == 'lithology':
            m, p = LITHOLOGY[params[cid]['kind']]
            lo, hi, hib, unit = 0.0, 1.0, True, '%'
        else:
            lo, hi, m, p, hib, unit = SCALE[cid]
        ice = cid == 'bare' and v < 0  # GLiM glaciers override (v1.1): drawn at zero with an ice note
        # aeolian is also partial when topsoil is >= 60 % sand, which the dune-share scale cannot show
        sand = cid == 'aeolian' and r['verdict'] == 1 and v < 0.01
        r['gauge'] = {'value': None if not np.isfinite(v) else (0.0 if ice else round(min(max(v, lo), hi), 4)),
                      'raw': None if not np.isfinite(v) else round(v, 4), 'min': lo, 'max': hi, 'match': m, 'partial': p,
                      'higher_is_better': hib, 'unit': unit, 'ice_cover': bool(ice), 'via_sand': bool(sand)}
        if cid == 'lithology':
            r['gauge']['kind'] = params[cid]['kind']
    return candidate
