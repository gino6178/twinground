"""Scoring for route v5.2 (section 3.3), shared by p8 and the web API.
For a query q, an Earth window e and a physical (class a) property k:
    p_k = Pr(|P_k(q) - P_k(e)| <= tau_k)
measured Earth value -> 0 or 1; estimated value -> Gaussian with sigma = (hi - lo) / (2 * 1.645) from the 90% conformal
interval; missing -> 0 and the token verdict 'unknown'. Use score A_u = sum w p / sum w over the properties the query has.
Only class-a properties are scored; conditions stay filters, Earth-only descriptors are shown only."""
import numpy as np

TOL = {'feo': 3.0, 'tio2': 1.5, 'k': 0.2, 'th': 2.0, 'albedo': 0.05, 'roughness': 1.0, 't_day': 20.0, 't_night': 20.0}
UNIT = {'feo': 'wt%', 'tio2': 'wt%', 'k': 'wt%', 'th': 'ppm', 'albedo': '1', 'roughness': 'deg', 't_day': 'K', 't_night': 'K'}
LABEL = {'feo': ('FeO', 'FeO'), 'tio2': ('TiO₂', 'TiO₂'), 'k': ('鉀', 'K'), 'th': ('釷', 'Th'), 'albedo': ('反照率', 'Albedo'),
         'roughness': ('粗糙度', 'Roughness'), 't_day': ('日間溫度', 'Day temperature'), 't_night': ('夜間溫度', 'Night temperature')}
# scored uses; ground ice, lava tubes / caves and aeolian have no cross-body same-unit quantity and stay condition-based
USES = {
    'isru': {'feo': 0.3, 'tio2': 0.3, 'k': 0.2, 'th': 0.2},
    'mobility': {'roughness': 1.0},
    'thermal': {'t_day': 0.35, 't_night': 0.35, 'albedo': 0.3},
    'base': {'roughness': 0.5, 't_night': 0.25, 'albedo': 0.25},
}
CONDITION_USES = ['ground_ice', 'lava_tube', 'aeolian']
Z90 = 1.6448536269514722


def p_match(qv, value, lo=None, hi=None, src=None, tol=None):
    """vectorised over Earth windows. src: 1 measured, 2 estimated, 0 missing (arrays)."""
    value = np.asarray(value, np.float64)
    out = np.zeros(value.shape)
    if qv is None or not np.isfinite(qv):
        return out
    meas = (src == 1) & np.isfinite(value)
    out[meas] = (np.abs(value[meas] - qv) <= tol).astype(float)
    est = (src == 2) & np.isfinite(value) & np.isfinite(lo) & np.isfinite(hi)
    if est.any():
        sd = np.maximum((hi[est] - lo[est]) / (2 * Z90), 1e-6)
        from scipy.special import ndtr
        out[est] = ndtr((qv + tol - value[est]) / sd) - ndtr((qv - tol - value[est]) / sd)
    return out


def use_score(qP, props, use, weights=None, allow_estimates=True):
    """qP: {k: value}; props: {k: dict(value, lo, hi, src)} arrays over windows. Returns (A, used properties)."""
    w = dict(USES[use]) if weights is None else dict(weights)
    num = None; den = 0.0; used = []
    for k, wk in w.items():
        if wk <= 0 or qP.get(k) is None or not np.isfinite(qP.get(k)) or k not in props:
            continue
        pk = props[k]
        src = pk['src'] if allow_estimates else np.where(pk['src'] == 1, 1, 0)
        p = p_match(qP[k], pk['value'], pk.get('lo'), pk.get('hi'), src, TOL[k])
        num = p * wk if num is None else num + p * wk
        den += wk; used.append(k)
    if num is None:
        return None, []
    return num / den, used


def comparison_token(k, qv, ev, lo, hi, src, weight, ceiling_meas):
    if src == 0 or ev is None or not np.isfinite(ev):
        p, verdict, delta = 0.0, 'unknown', None
    else:
        p = float(p_match(qv, np.array([ev]), np.array([lo]), np.array([hi]), np.array([src]), TOL[k])[0])
        delta = float(ev - qv)
        verdict = 'met' if p >= 0.5 else 'partial' if p > 0.05 else 'not_met'
    if ceiling_meas is not None and ceiling_meas == 0:
        verdict = 'earth_cannot_supply' if verdict != 'met' else verdict
    return {'id': k, 'delta': None if delta is None else round(delta, 4), 'tolerance': TOL[k], 'p_match': round(p, 4),
            'weight': weight, 'verdict': verdict, 'ceiling_meas': ceiling_meas}
