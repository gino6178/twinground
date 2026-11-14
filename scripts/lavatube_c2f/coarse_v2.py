"""PitChain-C2F coarse stage v2: volcanic-context-gated terrain retrieval, and its pre-registered evaluation (E3v2).

Lava tubes form in low-viscosity basaltic lava. The task prior is the great-circle distance from each Earth window to
the nearest Smithsonian GVP Holocene volcano whose major rock type is basaltic ('Basalt / Picro-Basalt' or
'Trachybasalt / Tephrite Basanite'); the rule was fixed before any v2 result. Ranking: windows within GATE_KM of such
a volcano come first, ordered by C-Enc v2 cosine; all others follow, also by cosine.

  python -m scripts.lavatube_c2f.coarse_v2 --distances   # cache distances for the 500,090 gallery windows
  python -m scripts.lavatube_c2f.coarse_v2 --freeze      # write protocol_v2_coarse.json (before evaluating)
  python -m scripts.lavatube_c2f.coarse_v2               # E3v2"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))
sys.path.insert(0, str(ROOT / 'src'))
from scripts.lavatube_c2f import sites  # noqa: E402

DATA = ROOT / 'data/research/lavatube_c2f'
GALLERY = DATA / 'earth_gallery'
GVP = ROOT / 'data/earth_global/gvp_holocene_volcanoes_2026.geojson'
BASALTIC = ('Basalt / Picro-Basalt', 'Trachybasalt / Tephrite Basanite')
GATE_KM = 60.0
PROTOCOL = DATA / 'protocol_v2_coarse.json'


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def basaltic_volcanoes():
    f = json.loads(GVP.read_text())['features']
    return np.array([[x['geometry']['coordinates'][1], x['geometry']['coordinates'][0]] for x in f
                     if x['properties'].get('Major_Rock_Type') in BASALTIC])


def nearest_km(lat, lon, volc, chunk=20000):
    out = np.empty(len(lat), np.float32)
    vl, vo = np.radians(volc[:, 0])[None], np.radians(volc[:, 1])[None]
    for i in range(0, len(lat), chunk):
        a, b = np.radians(lat[i:i + chunk])[:, None], np.radians(lon[i:i + chunk])[:, None]
        h = np.sin((vl - a) / 2) ** 2 + np.cos(a) * np.cos(vl) * np.sin((vo - b) / 2) ** 2
        out[i:i + chunk] = (2 * 6371.0 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))).min(1)
    return out


def distances():
    rows = json.loads((GALLERY / 'rows.json').read_text())
    lat = np.array([r['lat'] for r in rows]); lon = np.array([r['lon'] for r in rows])
    volc = basaltic_volcanoes()
    d = nearest_km(lat, lon, volc)
    np.save(GALLERY / 'gvp_basaltic_distance_km.npy', d)
    print(json.dumps({'windows': len(rows), 'basaltic_volcanoes': len(volc), 'within_gate': int((d <= GATE_KM).sum())}))


def freeze():
    if PROTOCOL.exists():
        raise SystemExit(f'already frozen sha256={sha(PROTOCOL)}')
    p = {'name': 'PitChain-C2F coarse v2 protocol (E3v2)', 'frozen_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
         'follows_v1_protocol_sha256': sha(DATA / 'protocol.json'),
         'prior': {'source': 'Smithsonian GVP Holocene volcanoes (2026 download)', 'source_sha256': sha(GVP),
                   'rule': f'major rock type in {list(BASALTIC)}', 'gate_km': GATE_KM},
         'methods': ['random', 'tiny_terrain_encoder', 'cenc_v2', 'gvp_basaltic_distance (ascending)', 'gated: within gate first, then cosine (PitChain-C2F v2 coarse)'],
         'queries': 'same 132 catalogue queries as protocol.json', 'scales': [40, 20, 80],
         'relevance': {'all_fields': 'all 18 lava-tube fields (no coarse component is trained on them)',
                       'non_us_fields': 'the 11 non-US fields of protocol.json', 'window_rule': 'centre within window_km/2 + 20 km of a field point'},
         'metrics': ['field recall@50, @200, @1000', 'average precision', 'first relevant rank'],
         'uncertainty': 'bootstrap over queries (1000 draws)', 'code_sha256': sha(Path(__file__)),
         'note': 'the GVP prior is a task prior, not learned; its stand-alone ranking is reported as a baseline'}
    PROTOCOL.write_text(json.dumps(p, indent=1))
    print(json.dumps({'protocol_v2_coarse_sha256': sha(PROTOCOL)}))


def main():
    import torch
    from scripts.lavatube_c2f.build_coarse_index import load_encoder
    from scripts.lavatube_c2f.coarse_model import embed_dem
    from scripts.lavatube_c2f.eval_coarse import bootstrap, production_vectors, query_squares
    if not PROTOCOL.exists():
        raise SystemExit('freeze first')
    protocol_v1 = json.loads((DATA / 'protocol.json').read_text())
    device = torch.device(os.environ.get('LT_DEVICE', 'cuda:1'))
    rows = json.loads((GALLERY / 'rows.json').read_text())
    lat = np.array([r['lat'] for r in rows]); lon = np.array([r['lon'] for r in rows]); km = np.array([r['km'] for r in rows])
    cenc = np.load(GALLERY / 'coarse_v2.npy').astype(np.float32)
    prod = production_vectors()
    dist = np.load(GALLERY / 'gvp_basaltic_distance_km.npy')
    m, msha = load_encoder('_v2', device)
    from lunar_pipeline import embed, load_model
    tiny = load_model()
    fields = {f['id']: f for f in protocol_v1['earth_relevance']['fields']}
    sets = {'all_fields': list(fields), 'non_us_fields': protocol_v1['earth_relevance']['evaluation_positives']}
    ks = (50, 200, 1000)
    rng = np.random.default_rng(20261019)
    out = {'protocol_v2_coarse_sha256': sha(PROTOCOL), 'scales': {}}
    for scale in (40, 20, 80):
        sel = np.flatnonzero(km == scale)
        res = {}
        for set_name, ids in sets.items():
            field_of = np.full(len(sel), -1)
            for j, fid in enumerate(ids):
                f = fields[fid]
                field_of[sites.haversine_km(lat[sel], lon[sel], f['lat'], f['lon'], 6371.0) <= scale / 2 + 20] = j
            res[set_name] = {'field_of': field_of, 'n': len(ids)}
        gate = dist[sel] <= GATE_KM
        per = {}
        for q in protocol_v1['queries']['list']:
            sq64, sq32 = query_squares(q, scale)
            z = torch.from_numpy((sq64 - np.median(sq64)).astype(np.float32))[None, None].to(device)
            e = embed_dem(m, z, torch.tensor([scale * 1000 / 63], device=device)).cpu().numpy()[0]
            cos = cenc[sel] @ e
            orders = {'cenc_v2': np.argsort(-cos, kind='stable'),
                      'tiny_terrain_encoder': np.argsort(-(prod[sel] @ embed(tiny, sq32)), kind='stable'),
                      'gvp_basaltic_distance': np.argsort(dist[sel], kind='stable'),
                      'gated_cenc_v2': np.lexsort((-cos, ~gate)),
                      'random': rng.permutation(len(sel))}
            for set_name, r in res.items():
                for method, order in orders.items():
                    f = r['field_of'][order]
                    rel = f >= 0
                    hits = np.flatnonzero(rel)
                    met = {f'field_recall@{k}': len(set(f[:k][rel[:k]].tolist())) / r['n'] for k in ks}
                    met['ap'] = float((np.arange(1, len(hits) + 1) / (hits + 1)).mean()) if len(hits) else 0.0
                    met['first_relevant_rank'] = int(hits[0]) + 1 if len(hits) else None
                    per.setdefault((set_name, q['body'], method), []).append(met)
        summary = {'gallery': int(len(sel)), 'within_gate': int(gate.sum()),
                   'relevant_windows': {s: int((r['field_of'] >= 0).sum()) for s, r in res.items()},
                   'fields_reachable': {s: int(len(set(r['field_of'][r['field_of'] >= 0].tolist()))) for s, r in res.items()}}
        for (set_name, body, method), mets in per.items():
            for key in ('field_recall@50', 'field_recall@200', 'field_recall@1000', 'ap'):
                summary.setdefault(set_name, {}).setdefault(body, {}).setdefault(method, {})[key] = bootstrap([x[key] for x in mets])
            ranks = [x['first_relevant_rank'] for x in mets if x['first_relevant_rank']]
            summary[set_name][body][method]['median_first_relevant_rank'] = int(np.median(ranks)) if ranks else None
        out['scales'][str(scale)] = summary
        print(json.dumps({'scale': scale, 'gallery': summary['gallery'], 'within_gate': summary['within_gate']}), flush=True)
    (DATA / 'results_E3v2_coarse.json').write_text(json.dumps(out, indent=1))
    print('written', flush=True)


if __name__ == '__main__':
    distances() if '--distances' in sys.argv else freeze() if '--freeze' in sys.argv else main()
