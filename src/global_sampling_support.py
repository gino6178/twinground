"""Apply a frozen full-source ETOPO audit, failing closed if inputs changed."""
from functools import lru_cache
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / 'data/research/redesign_v1/pixel_center_v1/global_audit.json'


def file_sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


class GlobalSupportAudit:
    def __init__(self, root, path):
        self.data = json.loads(path.read_text())
        if self.data['version'] not in ('stored-global-dem-gate-v1', 'stored-global-dem-gate-v2'):
            raise RuntimeError('Unsupported global DEM quality audit')
        self.sha256 = file_sha(path)
        for index in self.data['indexes']:
            if file_sha(root / index['path']) != index['sha256']:
                raise RuntimeError('Global DEM index changed; rerun source validity audit')
        self.sources = {s['path']: s for s in self.data['sources']}
        for source in self.sources.values():
            info = (root / source['path']).stat()
            # Content SHA is recorded by the full audit. Stat guards detect
            # ordinary replacement without re-reading all tiles at startup.
            if (info.st_size, info.st_mtime_ns) != (source['size'], source['mtime_ns']):
                raise RuntimeError('Global DEM source changed; rerun source validity audit')
        self.excluded = {r['id']: r for r in self.data['exclusions']}
        if len(self.excluded) != len(self.data['exclusions']):
            raise RuntimeError('Duplicate global DEM exclusions')

    def apply(self, rows):
        global_rows = [r for r in rows if r.get('dataset') in ('ETOPO_2022_15s', 'ETOPO_2022_60s')]
        ids = {r['id'] for r in global_rows}
        if len(ids) != sum(i['rows'] for i in self.data['indexes']) or len(ids) != len(global_rows):
            raise RuntimeError('Global DEM audit/index membership mismatch')
        if not self.excluded.keys() <= ids:
            raise RuntimeError('Unknown candidate in global DEM audit')
        for row in global_rows:
            if row['id'] in self.excluded:
                row['sampling_support'] = self.support(row)
        return {'version': self.data['version'], 'audit_sha256': self.sha256,
                'checked_global_windows': len(global_rows), 'excluded_global_windows': len(self.excluded),
                'source_rasters': len(self.sources), 'counts_by_scale': self.data['counts'],
                'rule': self.data['rule'], 'limitations': self.data['limitations'],
                'sampling_version_60s': self.data.get('sampling_version_60s')}

    def support(self, row):
        path = ('data/earth_global/etopo_15s_tiles/' + row['tile']
                if row['dataset'] == 'ETOPO_2022_15s'
                else 'data/earth_global/etopo_2022_60s_surface.tif')
        source = self.sources[path]
        failure = self.excluded.get(row['id'])
        return {'version': self.data['version'], 'audit_sha256': self.sha256,
                'source_product': path, 'source_sha256': source['sha256'],
                'sampling_version': row.get('sampling_version'),
                'stored_source_invalid_pixels': source['invalid_pixels'],
                'eligible_for_search': failure is None,
                'stored_window_pixel_rectangle': {
                    'invalid_pixels': failure['invalid_pixels'] if failure else 0,
                    'edge_clamped': failure['edge_clamped'] if failure else False},
                'exclusion_reasons': ([] if failure is None else
                    (['source_window_requires_edge_clamping'] if failure['edge_clamped'] else []) +
                    (['stored_source_contains_missing_pixels'] if failure['invalid_pixels'] else []) +
                    (['compiled_elevation_land_filter_failed'] if failure.get('land_filter_failed') else [])),
                'eligibility_policy': self.data['rule'], 'limits': self.data['limitations']}


@lru_cache(maxsize=1)
def global_support_audit():
    return GlobalSupportAudit(ROOT, AUDIT)
