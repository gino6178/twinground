"""PitChain-C2F teacher: closed depressions and collapse-pit chains from a high-resolution DEM.

Purely analytic (no labels, no learning). Depressions come from a priority-flood-equivalent fill computed as
morphological reconstruction by erosion (OpenCV, converges in O(widest depression) passes). Each depression gets
geometry that separates collapse pits (deep, steep, rimless, often aligned) from impact craters (raised rim) and from
shallow noise. Collapse-like pits are then linked into chains with an angle-constrained minimum spanning tree.
These outputs supervise the F-Net student; they are never used as evaluation truth."""
import json
import math
import sys

PIT_D_OVER_D = 0.25

import cv2
import numpy as np
import rasterio
from scipy.sparse.csgraph import minimum_spanning_tree
from scipy.spatial import cKDTree


def fill_depressions(dem, valid, device=None):
    """Lowest surface >= dem with no interior closed depressions; image edges and nodata act as outlets.
    Morphological reconstruction by erosion, run on the GPU when available (thousands of 3x3 passes)."""
    import torch
    import torch.nn.functional as F
    device = device or ('cuda:1' if torch.cuda.device_count() > 1 else 'cuda:0' if torch.cuda.is_available() else 'cpu')
    d = torch.from_numpy(dem.astype(np.float32)).to(device)[None, None]
    v = torch.from_numpy(valid).to(device)[None, None]
    low = torch.tensor(-1e9, device=device)
    big = d[v].max() + 1e4
    edge = torch.zeros_like(v)
    edge[..., 0, :] = edge[..., -1, :] = edge[..., :, 0] = edge[..., :, -1] = True
    marker = torch.where(v, torch.where(edge, d, big), low)
    with torch.no_grad():
        for it in range(200000):
            nxt = torch.maximum(d, -F.max_pool2d(-marker, 3, 1, 1))
            nxt = torch.where(v, torch.minimum(nxt, marker), low)
            if it % 64 == 63:
                if torch.equal(nxt, marker):
                    break
            marker = nxt
    return marker[0, 0].cpu().numpy()


def ring_mean(dem, valid, cy, cx, r0, r1):
    h, w = dem.shape
    y0, y1 = max(0, int(cy - r1)), min(h, int(cy + r1) + 1)
    x0, x1 = max(0, int(cx - r1)), min(w, int(cx + r1) + 1)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    rr = np.hypot(yy - cy, xx - cx)
    m = (rr >= r0) & (rr < r1) & valid[y0:y1, x0:x1]
    return float(dem[y0:y1, x0:x1][m].mean()) if m.sum() >= 8 else float('nan')


def depressions(dem, valid, res, min_depth, min_px=4, max_diam_m=2000.0):
    smooth = cv2.GaussianBlur(np.where(valid, dem, 0).astype(np.float32), (0, 0), 1.0)
    weight = cv2.GaussianBlur(valid.astype(np.float32), (0, 0), 1.0)
    smooth = np.where(valid, smooth / np.maximum(weight, 1e-6), dem).astype(np.float32)
    filled = fill_depressions(smooth, valid)
    depth = np.where(valid, filled - smooth, 0).astype(np.float32)
    mask = (depth >= min_depth).astype(np.uint8)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
    pits = []
    for i in range(1, n):
        area_px = stats[i, cv2.CC_STAT_AREA]
        if area_px < min_px:
            continue
        diam = 2 * math.sqrt(area_px / math.pi) * res
        if diam > max_diam_m:
            continue
        x, y, w, h = stats[i, :4]
        comp = labels[y:y + h, x:x + w] == i
        d = float(depth[y:y + h, x:x + w][comp].max())
        ys, xs = np.nonzero(comp)
        cov = np.cov(np.stack([xs, ys])) if len(xs) > 2 else np.eye(2)
        ev, evec = np.linalg.eigh(cov + 1e-6 * np.eye(2))
        elong = float(math.sqrt(ev[1] / max(ev[0], 1e-6)))
        angle = float(math.degrees(math.atan2(evec[1, 1], evec[0, 1])))
        cy, cx = cents[i][1], cents[i][0]
        r = diam / res / 2
        floor = float(smooth[y:y + h, x:x + w][comp].min())
        rim = ring_mean(smooth, valid, cy, cx, 1.0 * r, 1.5 * r + 1)
        outer = ring_mean(smooth, valid, cy, cx, 2.0 * r + 1, 3.0 * r + 2)
        rim_prom = rim - outer if math.isfinite(rim) and math.isfinite(outer) else float('nan')
        dd = d / diam
        rimless = math.isfinite(rim_prom) and rim_prom < 0.08 * d
        # Fixed a priori from physics, not tuned on any catalog: fresh simple impact craters reach d/D ~ 0.2
        # (Pike 1977), while lava-tube skylights / collapse pits are deeper (d/D ~ 0.3-1). Rim is kept as an attribute.
        collapse = dd >= PIT_D_OVER_D
        pits.append({'cx': float(cx), 'cy': float(cy), 'diameter_m': round(diam, 2), 'depth_m': round(d, 2),
                     'd_over_D': round(dd, 4), 'elongation': round(elong, 3), 'axis_deg': round(angle, 1),
                     'rim_prominence_m': round(rim_prom, 2) if math.isfinite(rim_prom) else None,
                     'floor_m': round(floor, 2), 'rimless': bool(rimless), 'collapse_like': bool(collapse), 'label': int(i)})
    return depth, labels, pits


def chains(pits, res, max_gap=6.0, max_turn=60.0):
    """Angle-constrained MST over collapse-like pits; returns chain id per pit and chain summaries."""
    idx = [k for k, p in enumerate(pits) if p['collapse_like']]
    for p in pits:
        p['chain'] = -1
    if len(idx) < 2:
        return []
    pts = np.array([[pits[k]['cx'], pits[k]['cy']] for k in idx]) * res
    size = np.array([pits[k]['diameter_m'] for k in idx])
    tree = cKDTree(pts)
    pairs = tree.query_pairs(r=float(max_gap * np.percentile(size, 75) + 1))
    rows, cols, vals = [], [], []
    for a, b in pairs:
        dist = float(np.linalg.norm(pts[a] - pts[b]))
        if dist <= max_gap * 0.5 * (size[a] + size[b]):
            rows.append(a); cols.append(b); vals.append(dist)
    if not rows:
        return []
    from scipy.sparse import coo_matrix
    mst = minimum_spanning_tree(coo_matrix((vals, (rows, cols)), shape=(len(idx), len(idx)))).tocoo()
    adj = {k: [] for k in range(len(idx))}
    for a, b in zip(mst.row, mst.col):
        adj[a].append(b); adj[b].append(a)
    # break edges at sharp turns so chains follow one sinuous path
    keep = set()
    for a, b in zip(mst.row, mst.col):
        ok = True
        for c in adj[b] + adj[a]:
            for (u, v, w) in ((a, b, c), (b, a, c)):
                if w in (u, v) or w not in adj[v]:
                    continue
                d1, d2 = pts[v] - pts[u], pts[w] - pts[v]
                cosang = float(d1 @ d2 / (np.linalg.norm(d1) * np.linalg.norm(d2) + 1e-9))
                if math.degrees(math.acos(max(-1, min(1, cosang)))) > max_turn and len(adj[v]) > 2:
                    ok = False
        if ok:
            keep.add((min(a, b), max(a, b)))
    parent = list(range(len(idx)))

    def find(u):
        while parent[u] != u:
            parent[u] = parent[parent[u]]; u = parent[u]
        return u
    for a, b in keep:
        parent[find(a)] = find(b)
    groups = {}
    for k in range(len(idx)):
        groups.setdefault(find(k), []).append(k)
    out = []
    for gid, members in enumerate(sorted((g for g in groups.values() if len(g) >= 3), key=len, reverse=True)):
        p = pts[members]
        path = float(sum(np.linalg.norm(pts[a] - pts[b]) for a, b in keep if a in members and b in members))
        span = float(np.max(np.linalg.norm(p[:, None] - p[None], axis=-1)))
        for k in members:
            pits[idx[k]]['chain'] = gid
        out.append({'chain': gid, 'pits': len(members), 'path_m': round(path, 1), 'span_m': round(span, 1),
                    'sinuosity': round(path / max(span, 1e-6), 3),
                    'mean_diameter_m': round(float(size[members].mean()), 1)})
    return out


def run(path, min_depth, window=None, out=None):
    with rasterio.open(path) as ds:
        dem = ds.read(1, window=window, masked=True).astype(np.float32)
        res = abs(ds.res[0])
    valid = ~np.ma.getmaskarray(dem) & np.isfinite(dem.filled(np.nan))
    dem = dem.filled(np.nan)
    dem[~valid] = np.nanmedian(dem[valid])
    depth, labels, pits = depressions(dem, valid, res, min_depth)
    ch = chains(pits, res)
    summary = {'source': str(path), 'res_m': res, 'shape': list(dem.shape), 'min_depth_m': min_depth,
               'depressions': len(pits), 'collapse_like': sum(p['collapse_like'] for p in pits), 'chains': ch[:10],
               'deepest': sorted(pits, key=lambda p: -p['depth_m'])[:8]}
    if out:
        np.savez_compressed(out, depth=depth.astype(np.float16), labels=labels.astype(np.int32))
        with open(str(out) + '.json', 'w') as f:
            json.dump({'summary': summary, 'pits': pits, 'chains': ch}, f)
    return summary


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1], float(sys.argv[2])), indent=1)[:3000])
