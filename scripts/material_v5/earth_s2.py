"""Earth Sentinel-2 L2A six-band surface-material descriptors for every Earth search window (material search v5).

Each window is measured over its own footprint (20/40/80 km), read as 128x128 pixels through the COG overviews
(average resampling for reflectance, nearest for the scene classification). Reflectance = DN / 10000 when the item says
earthsearch:boa_offset_applied (checked: ocean B08 DN ~200 on such items) or was acquired before baseline 04.00
(2022-01-25); otherwise (DN - 1000) / 10000. Statistics use clear pixels only, and the
material indices use "mineral surface" pixels only (SCL dark area / bare / unclassified with NDVI < 0.25), so
vegetation, water, snow and cloud do not leak into the material evidence. Resumable; a priority table lets the API ask
for specific windows first."""
import fcntl
import json
import math
import os
import queue
import shutil
import sqlite3
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, FIRST_COMPLETED, wait
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.warp import transform
from rasterio.windows import Window, from_bounds

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'data/research/sentinel_cog_v2'
OUT = ROOT / 'data/research/material_v5'
DB = OUT / 'earth_s2.sqlite'
CATALOGS = [SRC / 'catalog', OUT / 'catalog']
STAC = 'https://earth-search.aws.element84.com/v1/search'
BANDS = ['B02', 'B03', 'B04', 'B08', 'B11', 'B12']
PIX = 128
BAD_SCL = [0, 1, 3, 8, 9, 10]          # no data, defective, cloud shadow, cloud medium/high, cirrus
MINERAL_SCL = [2, 5, 7]                # dark area, not vegetated, unclassified
ACCEPT = 0.85                          # clear fraction of the footprint good enough to stop searching
MINIMUM = 0.4                          # below this the window has no usable scene in the searched set
MAX_SCENES = 5
OFFSET_FROM = '2022-01-25'
STOP = threading.Event()
CAT_LOCK = threading.Lock()
CAT_LAST = [0.0]
PROTOCOL = {
    'source': 'Element84 Earth Search, Sentinel-2 L2A COGs (registry.opendata.aws/sentinel-2-l2a-cogs), no login',
    'bands': BANDS, 'pixels': PIX, 'footprint': 'window size (20/40/80 km), square, centred on the window',
    'resampling': 'COG overviews, average for reflectance, nearest for SCL',
    'reflectance': 'DN/10000 if earthsearch:boa_offset_applied or acquired before 2022-01-25, else (DN-1000)/10000; '
                   'verified on 2024 items: open-ocean B08 DN ~150-210',
    'bad_scl': BAD_SCL, 'mineral_scl': MINERAL_SCL, 'mineral_ndvi_max': 0.25,
    'scene_choice': f'known 2024 scene of the image index first, then region catalog (2024, cloud<20) by cloud cover; '
                    f'stop at clear>={ACCEPT}, at most {MAX_SCENES} scenes, keep best, reject below {MINIMUM}',
    'indices': {'albedo': 'mean of six bands', 'ferric': 'B04/B02', 'ferrous': 'B12/B08 + B03/B04', 'hydroxyl': 'B11/B12',
                'ndvi': '(B08-B04)/(B08+B04)'},
    'index_references': 'van der Werff & van der Meer (2016) Remote Sens. 8, 883 (Sentinel-2 mineral indices)',
}


def connect():
    OUT.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB, timeout=60)
    c.execute('PRAGMA journal_mode=WAL')
    return c


def initialize():
    with connect() as c:
        c.executescript(
            'CREATE TABLE IF NOT EXISTS windows(id TEXT PRIMARY KEY, key TEXT, lat REAL, lon REAL, region TEXT, scale INTEGER,'
            ' known TEXT, status TEXT DEFAULT "pending", record TEXT, error TEXT, updated REAL DEFAULT 0);'
            'CREATE INDEX IF NOT EXISTS w_status_region ON windows(status, region);'
            'CREATE TABLE IF NOT EXISTS priority(id TEXT PRIMARY KEY, t REAL);'
            'CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, offset_applied INTEGER);'
            'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT);')
        c.execute('INSERT OR REPLACE INTO metadata VALUES("protocol", ?)', (json.dumps(PROTOCOL),))
        if c.execute('SELECT COUNT(*) FROM windows').fetchone()[0]:
            return
    src = sqlite3.connect(f'file:{SRC / "index.sqlite"}?mode=ro', uri=True)
    rows = src.execute('SELECT w.id, w.key, p.lat, p.lon, p.region, w.scale, p.provenance FROM windows w JOIN points p ON p.key = w.key').fetchall()
    src.close()
    out = []
    for wid, key, lat, lon, region, scale, provenance in rows:
        known = None
        try:
            p = json.loads(provenance or '{}')
            href = p.get('image_href') or ''
            if href.startswith('https://sentinel-cogs.s3.us-west-2.amazonaws.com/') and href.endswith('/TCI.tif'):
                known = json.dumps({'id': p.get('item_id'), 'datetime': p.get('datetime'), 'folder': href[:-len('TCI.tif')]})
        except ValueError:
            pass
        out.append((wid, key, lat, lon, region, scale, known))
    with connect() as c:
        c.executemany('INSERT OR IGNORE INTO windows(id, key, lat, lon, region, scale, known) VALUES(?,?,?,?,?,?,?)', out)
    print(json.dumps({'initialized': len(out)}), flush=True)


def catalog(region):
    for folder in CATALOGS:
        path = folder / f'{region}.json'
        if path.exists():
            try:
                saved = json.loads(path.read_text())
                if isinstance(saved, dict) and saved.get('complete'):
                    return saved['items']
            except ValueError:
                pass
    lat, lon = map(int, region.split(','))
    items, seen = [], set()
    url = STAC
    params = {'collections': 'sentinel-2-l2a',
              'bbox': f'{max(-180, lon - .02)},{max(-90, lat - .02)},{min(180, lon + 1.02)},{min(90, lat + 1.02)}',
              'datetime': '2024-01-01T00:00:00Z/2024-12-31T23:59:59Z', 'query': json.dumps({'eo:cloud_cover': {'lt': 20}}), 'limit': 100}
    session = requests.Session()
    while url:
        if STOP.is_set():
            raise RuntimeError('stopped')
        if url in seen:
            raise RuntimeError('repeated catalog page')
        seen.add(url)
        with CAT_LOCK:
            time.sleep(max(0, .25 - (time.monotonic() - CAT_LAST[0])))
            CAT_LAST[0] = time.monotonic()
        r = session.get(url, params=params, timeout=60)
        r.raise_for_status()
        page = r.json()
        for x in page['features']:
            if all(k in x['assets'] for k in ['visual', 'scl']):
                items.append({'id': x['id'], 'bbox': x['bbox'],
                              'properties': {k: x['properties'].get(k) for k in ['datetime', 'eo:cloud_cover']},
                              'assets': {k: {'href': x['assets'][k]['href']} for k in ['visual', 'scl']}})
        url = next((x['href'] for x in page.get('links', []) if x.get('rel') == 'next'), None)
        params = None
    items.sort(key=lambda x: (x['properties'].get('eo:cloud_cover', 100), x['id']))
    path = OUT / 'catalog' / f'{region}.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps({'complete': True, 'pages': len(seen), 'items': items}))
    tmp.rename(path)
    return items


ITEM_LOCK = threading.Lock()
ITEM_LAST = [0.0]
ITEM_CACHE = {}


def offset_for(item_id, dt):
    """0 when the COG values are plain reflectance x 10000, 1000 when they still carry the BOA_ADD_OFFSET."""
    if (dt or '') < OFFSET_FROM:
        return 0.0
    if item_id not in ITEM_CACHE:
        with connect() as c:
            row = c.execute('SELECT offset_applied FROM items WHERE id = ?', (item_id,)).fetchone()
        if row is None:
            with ITEM_LOCK:
                time.sleep(max(0, .12 - (time.monotonic() - ITEM_LAST[0])))
                ITEM_LAST[0] = time.monotonic()
            r = requests.get(f'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/{item_id}', timeout=60)
            r.raise_for_status()
            applied = 1 if r.json()['properties'].get('earthsearch:boa_offset_applied') else 0
            with connect() as c:
                c.execute('INSERT OR REPLACE INTO items VALUES(?, ?)', (item_id, applied))
            row = (applied,)
        ITEM_CACHE[item_id] = row[0]
    return 0.0 if ITEM_CACHE[item_id] else 1000.0


class Datasets:
    def __init__(self, size=48):
        self.data, self.size = OrderedDict(), size

    def get(self, url):
        if url in self.data:
            self.data.move_to_end(url)
            return self.data[url]
        ds = rasterio.open(url)
        self.data[url] = ds
        if len(self.data) > self.size:
            self.data.popitem(last=False)[1].close()
        return ds

    def close(self):
        for ds in self.data.values():
            ds.close()


def read(cache, url, lat, lon, half, nearest):
    """Footprint read at PIX x PIX; returns (array, coverage) with the part outside the scene zero-filled."""
    ds = cache.get(url)
    x, y = transform('EPSG:4326', ds.crs, [lon], [lat])
    full = from_bounds(x[0] - half, y[0] - half, x[0] + half, y[0] + half, ds.transform)
    c0, r0 = max(0, full.col_off), max(0, full.row_off)
    c1, r1 = min(ds.width, full.col_off + full.width), min(ds.height, full.row_off + full.height)
    out = np.zeros((PIX, PIX), dtype=np.float32)
    if c1 <= c0 or r1 <= r0:
        return out, 0.0
    # output pixel range covered by the in-scene part
    px0 = int(round((c0 - full.col_off) / full.width * PIX)); px1 = int(round((c1 - full.col_off) / full.width * PIX))
    py0 = int(round((r0 - full.row_off) / full.height * PIX)); py1 = int(round((r1 - full.row_off) / full.height * PIX))
    if px1 - px0 < 2 or py1 - py0 < 2:
        return out, 0.0
    a = ds.read(1, window=Window(c0, r0, c1 - c0, r1 - r0), out_shape=(py1 - py0, px1 - px0),
                resampling=Resampling.nearest if nearest else Resampling.average)
    out[py0:py1, px0:px1] = a
    return out, (px1 - px0) * (py1 - py0) / PIX / PIX


def candidates(row, items):
    wid, key, lat, lon, region, scale, known = row
    seen = set()
    if known:
        k = json.loads(known)
        seen.add(k['id'])
        yield k['id'], k['datetime'], k['folder']
    for item in items:
        b = item['bbox']
        if item['id'] in seen or not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            continue
        href = item['assets']['scl']['href']
        if not (href.startswith('https://sentinel-cogs.s3.us-west-2.amazonaws.com/') and href.endswith('/SCL.tif')):
            continue
        seen.add(item['id'])
        yield item['id'], item['properties'].get('datetime'), href[:-len('SCL.tif')]


def q(v, p):
    return float(np.percentile(v, p)) if v.size else None


def measure(cache, row, items):
    wid, key, lat, lon, region, scale, known = row
    half = scale * 1000 / 2
    best, tried = None, 0
    for item_id, dt, folder in candidates(row, items):
        if tried >= MAX_SCENES or STOP.is_set():
            break
        tried += 1
        scl, coverage = read(cache, folder + 'SCL.tif', lat, lon, half, True)
        if coverage <= 0:
            continue
        clear = float((~np.isin(scl, BAD_SCL) & (scl > 0)).mean())
        if best is None or clear > best[0]:
            best = (clear, item_id, dt, folder, scl, coverage)
        if clear >= ACCEPT:
            break
    if best is None or best[0] < MINIMUM:
        return 'no_clear_scene', None, json.dumps({'scenes_tried': tried, 'best_clear': None if best is None else round(best[0], 3)})
    clear, item_id, dt, folder, scl, coverage = best
    offset = offset_for(item_id, dt)
    dn = np.stack([read(cache, folder + f'{b}.tif', lat, lon, half, False)[0] for b in BANDS])
    valid = ~np.isin(scl, BAD_SCL) & (scl > 0) & (dn > 0).all(0)
    refl = (dn - offset) / 10000.0
    b2, b3, b4, b8, b11, b12 = refl
    with np.errstate(divide='ignore', invalid='ignore'):
        ndvi = (b8 - b4) / (b8 + b4)
        mineral = valid & np.isin(scl, MINERAL_SCL) & (ndvi < 0.25) & (refl > 0.005).all(0)
        ferric = b4 / b2
        ferrous = b12 / b8 + b3 / b4
        hydroxyl = b11 / b12
    albedo = refl.mean(0)
    n_valid = int(valid.sum())
    frac = lambda cls: round(float((valid & (scl == cls)).sum() / max(1, n_valid)), 4)
    record = {
        'item_id': item_id, 'datetime': dt, 'offset': offset, 'scenes_tried': tried,
        'coverage': round(coverage, 4), 'clear': round(clear, 4), 'pixel_m': round(scale * 1000 / PIX, 1),
        'fractions': {'mineral': round(float(mineral.sum() / max(1, n_valid)), 4), 'vegetation': frac(4), 'water': frac(6),
                      'snow': frac(11), 'dark': frac(2)},
        'median_clear': [round(float(np.median(x[valid])), 5) if n_valid else None for x in refl],
    }
    m = mineral
    if m.sum() >= 30:
        record['mineral'] = {
            'n': int(m.sum()),
            'median': [round(float(np.median(x[m])), 5) for x in refl],
            'albedo': [round(q(albedo[m], p), 5) for p in (10, 50, 90)],
            'ferric': round(q(ferric[m], 50), 4), 'ferrous': round(q(ferrous[m], 50), 4),
            'hydroxyl': round(q(hydroxyl[m], 50), 4), 'ndvi': round(q(ndvi[m], 50), 4),
        }
    return 'ready', record, None


def region_work(region, rows, results):
    items = catalog(region)
    cache = Datasets()
    try:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='90', GDAL_HTTP_MAX_RETRY='3',
                          GDAL_HTTP_RETRY_DELAY='2', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MULTIPLEX='YES',
                          GDAL_HTTP_VERSION='2'):
            for row in rows:
                if STOP.is_set():
                    return
                try:
                    status, record, error = measure(cache, row, items)
                except rasterio.errors.RasterioIOError as e:
                    status, record, error = 'read_error', None, str(e)[:300]
                results.put((row[0], status, record, error))
    finally:
        cache.close()


def next_regions(c, limit):
    pri = [r for (r,) in c.execute('SELECT DISTINCT w.region FROM priority p JOIN windows w ON w.id = p.id '
                                   'WHERE w.status = "pending" ORDER BY p.t LIMIT ?', (limit,))]
    return pri


def run(workers):
    results = queue.Queue()
    start = last = time.monotonic()
    done = 0
    with connect() as c:
        order = [r for (r,) in c.execute('SELECT region FROM windows WHERE status = "pending" GROUP BY region ORDER BY COUNT(*) DESC')]
    order_iter = iter(order)
    busy = set()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        exhausted = False
        while futures or not exhausted or not results.empty():
            if shutil.disk_usage(OUT).free < 25 * 1024 ** 3:
                STOP.set()
                raise SystemExit('disk reserve 25 GiB reached')
            while len(futures) < workers * 2:
                with connect() as c:
                    region = next((r for r in next_regions(c, workers * 2) if r not in busy), None)
                    while region is None and not exhausted:
                        try:
                            r = next(order_iter)
                        except StopIteration:
                            exhausted = True
                            break
                        if r not in busy:
                            region = r
                    if region is None:
                        break
                    rows = c.execute('SELECT id, key, lat, lon, region, scale, known FROM windows WHERE status = "pending" AND region = ?',
                                     (region,)).fetchall()
                if rows:
                    busy.add(region)
                    futures[pool.submit(region_work, region, rows, results)] = region
            finished = wait(futures, timeout=0.5, return_when=FIRST_COMPLETED)[0] if futures else []
            batch = []
            while len(batch) < 500:
                try:
                    batch.append(results.get_nowait())
                except queue.Empty:
                    break
            if batch:
                now = time.time()
                with connect() as c:
                    c.executemany('UPDATE windows SET status = ?, record = ?, error = ?, updated = ? WHERE id = ?',
                                  [(s, json.dumps(r) if r else None, e, now, wid) for wid, s, r, e in batch])
                    c.executemany('DELETE FROM priority WHERE id = ?', [(b[0],) for b in batch])
                done += len(batch)
            for f in finished:
                region = futures.pop(f)
                busy.discard(region)
                try:
                    f.result()
                except Exception as e:  # noqa: BLE001 - a failed region stays pending for the next pass
                    print(json.dumps({'region': region, 'error': str(e)[:300]}), flush=True)
            if time.monotonic() - last >= 60:
                with connect() as c:
                    counts = dict(c.execute('SELECT status, COUNT(*) FROM windows GROUP BY status'))
                record = {'time': time.time(), 'workers': workers, 'processed_this_run': done,
                          'per_second': round(done / max(1, time.monotonic() - start), 2), 'counts': counts, 'in_flight': len(futures)}
                (OUT / 'earth_s2_progress.json').write_text(json.dumps(record, indent=2))
                print(json.dumps(record), flush=True)
                last = time.monotonic()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    lock = open(OUT / 'earth_s2.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    initialize()
    if '--pilot' in sys.argv:
        with connect() as c:
            rows = c.execute('SELECT id, key, lat, lon, region, scale, known FROM windows WHERE id LIKE "earth_atacama-20-%" LIMIT 6').fetchall()
        results = queue.Queue()
        t = time.monotonic()
        region_work(rows[0][4], rows, results)
        while not results.empty():
            wid, s, r, e = results.get()
            print(wid, s, json.dumps(r)[:400] if r else e)
        print('seconds', round(time.monotonic() - t, 1))
        raise SystemExit(0)
    run(int(os.environ.get('S2_WORKERS', '24')))
    with connect() as c:
        counts = dict(c.execute('SELECT status, COUNT(*) FROM windows GROUP BY status'))
    (OUT / 'earth_s2_pass_end.json').write_text(json.dumps({'time': time.time(), 'counts': counts}, indent=2))
