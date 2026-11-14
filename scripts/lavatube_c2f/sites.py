"""Draft evaluation sites for PitChain-C2F (to be verified against cited sources, then frozen by SHA-256 in the
pre-registered protocol). Training data must exclude everything within EXCLUDE_KM of these points."""

EXCLUDE_KM = 150

# Queries come from the two published catalogs (see query_sites()); these three are the NASA-highlighted examples.
NASA_HIGHLIGHTS = ['Marius Hills Pit', 'Mare Tranquillitatis Pit', 'Mare Ingenii Pit']
CATALOG_DIR = 'data/research/lavatube_c2f/sources/catalogs'
DEDUP_KM = {'moon': 20, 'mars': 50}


def query_sites(root):
    """Lunar mare pits (LROC pit atlas, Wagner & Robinson 2021) and Martian skylight / atypical-pit-crater candidates
    (MGC3, Cushing), each de-duplicated so no two queries of a body are closer than DEDUP_KM."""
    import csv, io, zipfile
    from pathlib import Path
    base = Path(root) / CATALOG_DIR
    out = []
    rows = list(csv.DictReader(open(base / 'LUNAR_PIT_LOCATIONS.CSV', encoding='utf-8', errors='replace')))
    for r in rows:
        if r['Terrain'].strip().lower() == 'mare':
            out.append({'id': 'moon:' + r['Name'].strip(), 'body': 'moon', 'lat': float(r['Latitude']), 'lon': float(r['Longitude_180']),
                        'type': 'mare pit', 'nasa_highlight': r['Name'].strip() in NASA_HIGHLIGHTS})
    z = zipfile.ZipFile(base / 'mars_cave_catalog.zip')
    # data/Mars_Cave_Catalog.csv has its header shifted by one column; the shapefile table is aligned
    rows = list(csv.DictReader(io.TextIOWrapper(z.open('miscellaneous/Mars_Cave_Catalog_shapefile.csv'), encoding='utf-8', errors='replace')))
    for r in rows:
        if r['TypeCode:string'].strip() in ('sky', 'APC'):
            lon = float(r['longitude']); lon = (lon + 180) % 360 - 180
            out.append({'id': 'mars:' + r['Label:string'].strip(), 'body': 'mars', 'lat': float(r['latitude']), 'lon': lon,
                        'type': r['TypeCode:string'].strip(), 'nasa_highlight': False})
    kept = []
    for q in sorted(out, key=lambda q: (not q['nasa_highlight'], q['id'])):
        radius = 1737.4 if q['body'] == 'moon' else 3389.5
        if all(k['body'] != q['body'] or haversine_km(q['lat'], q['lon'], k['lat'], k['lon'], radius) >= DEDUP_KM[q['body']] for k in kept):
            kept.append(q)
    return kept


# Earth relevance: publicly documented lava-tube fields (park / field level, not cave entrances).
EARTH_LAVA_TUBE_FIELDS = [
    {'id': 'craters_of_the_moon_id', 'lat': 43.42, 'lon': -113.52},
    {'id': 'lava_beds_ca', 'lat': 41.71, 'lon': -121.51},
    {'id': 'el_malpais_nm', 'lat': 34.95, 'lon': -108.05},
    {'id': 'carrizozo_nm', 'lat': 33.75, 'lon': -105.95},
    {'id': 'newberry_lava_river_or', 'lat': 43.90, 'lon': -121.37},
    {'id': 'ape_cave_st_helens_wa', 'lat': 46.11, 'lon': -122.21},
    {'id': 'kilauea_kazumura_hi', 'lat': 19.47, 'lon': -155.10},
    {'id': 'undara_au', 'lat': -18.20, 'lon': 144.60},
    {'id': 'lanzarote_corona_es', 'lat': 29.16, 'lon': -13.44},
    {'id': 'tenerife_viento_es', 'lat': 28.37, 'lon': -16.70},
    {'id': 'jeju_manjanggul_kr', 'lat': 33.53, 'lon': 126.77},
    {'id': 'surtshellir_is', 'lat': 64.78, 'lon': -20.75},
    {'id': 'raufarholshellir_is', 'lat': 63.99, 'lon': -21.40},
    {'id': 'etna_it', 'lat': 37.75, 'lon': 15.00},
    {'id': 'chyulu_leviathan_ke', 'lat': -2.60, 'lon': 37.90},
    {'id': 'harrat_khaybar_umm_jirsan_sa', 'lat': 25.58, 'lon': 39.82},
    {'id': 'jingpohu_cn', 'lat': 44.08, 'lon': 128.83},
    {'id': 'galapagos_santa_cruz_ec', 'lat': -0.67, 'lon': -90.33},
]


def haversine_km(lat1, lon1, lat2, lon2, radius_km):
    import numpy as np
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians((np.asarray(lon2) - np.asarray(lon1) + 180) % 360 - 180)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * radius_km * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def excluded(body, lat, lon, root=None):
    """True where a training sample is too close to an evaluation site (Earth fields or catalog queries)."""
    import numpy as np
    from pathlib import Path
    root = root or Path(__file__).resolve().parents[2]
    radius = {'earth': 6371.0, 'moon': 1737.4, 'mars': 3389.5}[body]
    sites = EARTH_LAVA_TUBE_FIELDS if body == 'earth' else [q for q in query_sites(root) if q['body'] == body]
    out = np.zeros(np.shape(lat), bool)
    for s in sites:
        out |= haversine_km(lat, lon, s['lat'], s['lon'], radius) < EXCLUDE_KM
    return out
