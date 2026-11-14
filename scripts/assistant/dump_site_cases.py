"""Collect real search results as site briefs for assistant training (2026-11-14). Runs next to the live server.

  python -m scripts.assistant.dump_site_cases --n 700 --out ~/assistant/site_cases.jsonl [--base http://127.0.0.1:8766]

Each line: {"query": {...}, "lang": "zh"|"en", "index": i, "brief": str} for every returned candidate, in both languages.
Requests are sequential per worker (2 workers) so the live site stays responsive. Resumable: existing query keys are skipped.
"""
import argparse
import json
import random
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.assistant.site_brief import brief, strip_answer  # noqa: E402

NAMED = {'moon': [(8.3, 33.2), (-9.0, 15.5), (-3.6, -17.5), (26.1, 3.6), (20.2, 30.8), (14.1, -56.6), (24.0, -47.4),
                  (-89.5, 0.0), (-89.0, -60.0), (-85.4, 31.0), (-88.5, 120.0), (85.0, 0.0), (-43.3, -11.2), (9.6, -59.0)],
         'mars': [(18.4, 77.7), (-5.4, 137.8), (4.5, 135.6), (68.2, -125.7), (40.0, -170.0), (18.65, -133.8), (-14.0, -59.2),
                  (82.0, 180.0), (-1.95, -5.5), (22.5, -50.0), (-41.0, 70.0), (38.0, 50.0)]}
PURPOSES = [('facets', 'overall'), ('facets', 'astrobiology'), ('facets', 'subsurface'), ('facets', 'crew_ops'),
            ('physical', None), ('conditions', None), ('maxmatch', None), ('lavatube', None), ('material', None)]


def queries(n, seed=7):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        body = 'moon' if rnd.random() < 0.55 else 'mars'
        if rnd.random() < 0.35:
            lat, lon = rnd.choice(NAMED[body])
            lat += rnd.uniform(-0.6, 0.6); lon += rnd.uniform(-0.6, 0.6)
        else:
            lat = rnd.uniform(-88, 88) if body == 'moon' else rnd.uniform(-60, 60)
            lon = rnd.uniform(-180, 180)
        purpose, use = rnd.choice(PURPOSES)
        size = rnd.choice([20, 40, 40, 80])
        q = {'lat': round(max(-89.4, min(89.4, lat)), 3), 'lon': round(((lon + 180) % 360) - 180, 3), 'size_km': size,
             'purpose': purpose, 'limit': 5}
        if use:
            q['facet_use'] = use
        out.append((body, q))
    return out


def run_one(base, body, q, timeout=180):
    path = '/api/mars-search' if body == 'mars' else '/api/search'
    with urllib.request.urlopen(f'{base}{path}?{urllib.parse.urlencode(q)}', timeout=timeout) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=700)
    ap.add_argument('--out', default=str(Path.home() / 'assistant/site_cases.jsonl'))
    ap.add_argument('--base', default='http://127.0.0.1:8766')
    ap.add_argument('--workers', type=int, default=2)
    a = ap.parse_args()
    out = Path(a.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        for line in out.open(encoding='utf-8'):
            done.add(json.loads(line)['key'])
    todo = [(b, q) for b, q in queries(a.n) if json.dumps([b, q], sort_keys=True) not in done]
    print(len(todo), 'searches to run', flush=True)
    t0, ok = time.time(), 0

    def work(item):
        b, q = item
        try:
            return item, strip_answer(run_one(a.base, b, q))
        except Exception as exc:  # noqa: BLE001
            return item, {'error': str(exc)[:200]}

    with ThreadPoolExecutor(a.workers) as ex, out.open('a', encoding='utf-8') as f:
        for (b, q), ans in ex.map(work, todo):
            key = json.dumps([b, q], sort_keys=True)
            if ans.get('error') or not ans.get('matches'):
                print('skip', key, ans.get('error', 'no matches')[:120], flush=True)
                continue
            for lang in ('zh', 'en'):
                for i in range(len(ans['matches'])):
                    try:
                        text = brief(ans, i, lang)
                    except Exception as exc:  # noqa: BLE001
                        print('brief failed', key, i, exc, flush=True)
                        continue
                    f.write(json.dumps({'key': key, 'body': b, 'query': q, 'lang': lang, 'index': i,
                                        'brief': text}, ensure_ascii=False) + '\n')
            f.flush()
            ok += 1
            if ok % 20 == 0:
                print(f'{ok} searches, {time.time() - t0:.0f} s', flush=True)
    print('done', ok, flush=True)


if __name__ == '__main__':
    main()
