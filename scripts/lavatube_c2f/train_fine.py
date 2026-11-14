"""Train F-Net (single seed, GPU 1) on the 10 m student grids built by fine_data.py. Test sites are never loaded."""
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # append: a stale lunar_pipeline.py sits in the repo root
from scripts.lavatube_c2f.fine_model import FNet, make_input, rotate_batch, sun_to_top  # noqa: E402

DATA = ROOT / 'data/research/lavatube_c2f/fine'
OUT = ROOT / 'data/research/lavatube_c2f'
SEED = 20261018
STEPS = int(os.environ.get('LT_STEPS', '6000'))
BATCH = 24
P = 160            # output patch (1.6 km at 10 m)
Q = 232            # read patch, large enough to rotate without empty corners
DEV = torch.device(os.environ.get('LT_DEVICE', 'cuda:1'))


def load(split):
    sites = []
    for meta_path in sorted(DATA.glob('*.json')):
        meta = json.loads(meta_path.read_text())
        if meta.get('split') != split:
            continue
        d = np.load(meta_path.with_suffix('.npz'))
        if min(d['img'].shape) < Q + 2:
            continue
        sun = meta.get('sun_metadata') if meta['body'] == 'earth' and meta.get('sun_metadata') and meta['sun_metadata'][0] is not None else meta['sun_fit']
        trust = meta['body'] == 'earth' or (meta['sun_fit'][2] or 0) >= 0.2
        pits = np.argwhere(d['pit'].astype(np.float32) > 0.02)
        sites.append({'meta': meta, 'img': d['img'].astype(np.float32), 'dem': d['dem'], 'pit': d['pit'].astype(np.float32),
                      'depth': d['depth'].astype(np.float32), 'valid': d['valid'].astype(np.float32),
                      'sun_az': float(sun[0]) if trust and sun[0] is not None else None, 'pits': pits})
    return sites


def sample(sites, rng, n):
    bodies = sorted({s['meta']['body'] for s in sites})
    crops = []
    while len(crops) < n:
        body = bodies[rng.integers(len(bodies))]
        pool = [s for s in sites if s['meta']['body'] == body]
        s = pool[rng.integers(len(pool))]
        h, w = s['img'].shape
        if len(s['pits']) and rng.random() < 0.5:
            cy, cx = s['pits'][rng.integers(len(s['pits']))] + rng.integers(-40, 41, 2)
        else:
            cy, cx = rng.integers(Q // 2, h - Q // 2), rng.integers(Q // 2, w - Q // 2)
        cy, cx = int(np.clip(cy, Q // 2, h - Q // 2 - 1)), int(np.clip(cx, Q // 2, w - Q // 2 - 1))
        sl = (slice(cy - Q // 2, cy + Q // 2), slice(cx - Q // 2, cx + Q // 2))
        if s['valid'][sl].mean() < 0.7:
            continue
        az = s['sun_az'] if s['sun_az'] is not None else rng.uniform(0, 360)
        crops.append((np.stack([s['img'][sl], s['dem'][sl], s['pit'][sl], s['depth'][sl], s['valid'][sl]]), az))
    x = torch.from_numpy(np.stack([c[0] for c in crops])).to(DEV)
    az = torch.tensor([c[1] for c in crops], dtype=torch.float32, device=DEV)
    return x, az


def prepare(x, az, rng, train=True):
    """Rotate so the sun is on top, flip left-right (keeps the sun on top), centre-crop, degrade, build input."""
    angle = sun_to_top(az) + (torch.from_numpy(rng.uniform(-0.17, 0.17, len(az))).float().to(DEV) if train else 0)
    r = rotate_batch(x, angle)
    if train:
        flip = torch.from_numpy(rng.random(len(az)) < 0.5).to(DEV)
        r = torch.where(flip[:, None, None, None], r.flip(-1), r)
    o = (Q - P) // 2
    r = r[..., o:o + P, o:o + P]
    img, dem, pit, depth, valid = r[:, 0:1], r[:, 1:2], r[:, 2], r[:, 3], r[:, 4]
    if train:
        b = len(img)
        img = img * (0.8 + 0.4 * torch.rand(b, 1, 1, 1, device=DEV)) + torch.randn_like(img) * 0.03 * torch.rand(b, 1, 1, 1, device=DEV)
        drop_img = torch.rand(b, 1, 1, 1, device=DEV) < 0.15
        drop_dem = (torch.rand(b, 1, 1, 1, device=DEV) < 0.15) & ~drop_img
        img = torch.where(drop_img, torch.zeros_like(img), img.clamp(0, 1))
        dem = torch.where(drop_dem, torch.zeros_like(dem), dem)
    return make_input(img, dem), pit, depth, (valid > 0.5).float()


def losses(model, inp, pit, depth, valid):
    logit, ldepth, _ = model(inp)
    target = (pit > 0.02).float()
    w = valid * (1 + 9 * target)
    l_pit = (F.binary_cross_entropy_with_logits(logit, target, reduction='none') * w).sum() / w.sum().clamp(min=1)
    l_depth = (F.smooth_l1_loss(ldepth, torch.log1p(depth.clamp(min=0)), reduction='none') * valid).sum() / valid.sum().clamp(min=1)
    return l_pit + 0.5 * l_depth, l_pit, l_depth, logit


def average_precision(score, label):
    order = np.argsort(-score)
    l = label[order]
    tp = np.cumsum(l)
    prec = tp / np.arange(1, len(l) + 1)
    return float((prec * l).sum() / max(1, l.sum()))


@torch.no_grad()
def evaluate(model, sites, rng):
    model.eval()
    scores, labels, dmae = [], [], []
    erng = np.random.default_rng(1)
    for _ in range(8):
        x, az = sample(sites, erng, BATCH)
        inp, pit, depth, valid = prepare(x, az, erng, train=False)
        logit, ldepth, _ = model(inp)
        m = valid > 0
        scores.append(logit[m].float().cpu().numpy()); labels.append((pit[m] > 0.02).float().cpu().numpy())
        dmae.append(float((torch.expm1(ldepth) - depth).abs()[m].mean()))
    model.train()
    s, l = np.concatenate(scores), np.concatenate(labels)
    return {'pit_ap': round(average_precision(s, l), 4), 'pit_base_rate': round(float(l.mean()), 5), 'depth_mae_m': round(float(np.mean(dmae)), 3)}


def main():
    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    train, dev = load('train'), load('dev')
    model = FNet().to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.02)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=STEPS, pct_start=0.05)
    log = {'seed': SEED, 'steps': STEPS, 'parameters': sum(p.numel() for p in model.parameters()),
           'train_sites': [s['meta']['name'] for s in train], 'dev_sites': [s['meta']['name'] for s in dev], 'history': []}
    print(json.dumps({k: log[k] for k in ('parameters', 'train_sites', 'dev_sites')}), flush=True)
    best, t0 = -1, time.time()
    for step in range(1, STEPS + 1):
        x, az = sample(train, rng, BATCH)
        inp, pit, depth, valid = prepare(x, az, rng)
        with torch.autocast('cuda', dtype=torch.bfloat16):
            loss, lp, ld, _ = losses(model, inp, pit, depth, valid)
        opt.zero_grad(set_to_none=True)
        loss.float().backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        opt.step(); sched.step()
        if step % 100 == 0:
            print(json.dumps({'step': step, 'loss': round(float(loss), 4), 'pit': round(float(lp), 4), 'depth': round(float(ld), 4),
                              'sec': round(time.time() - t0)}), flush=True)
        if step % 500 == 0 or step == STEPS:
            m = evaluate(model, dev, rng)
            m['step'] = step
            log['history'].append(m)
            print(json.dumps(m), flush=True)
            if m['pit_ap'] > best:
                best = m['pit_ap']
                torch.save({'model': model.state_dict(), 'step': step}, OUT / 'fnet.pt')
                log['selected'] = m
            (OUT / 'fnet_training.json').write_text(json.dumps(log, indent=2))
    log['seconds'] = round(time.time() - t0)
    (OUT / 'fnet_training.json').write_text(json.dumps(log, indent=2))


if __name__ == '__main__':
    main()
