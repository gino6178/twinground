"""PitChain-C2F coarse stage: physics-rendered cross-body contrastive encoder (C-Enc).

A DEM square is rendered on the GPU into grey images under random sun azimuth/elevation with cast shadows, a random
photometric law (Lambert <-> Lommel-Seeliger mix), low-frequency albedo, blur, gain/gamma and noise. Two renders of the
same terrain (with independent rotations/flips/crops) are positives. Real LROC WAC images are additionally pulled to
renders of the co-located LOLA DEM, so real imagery and rendered DEMs share one embedding space. A gradient-reversed
body classifier aligns Moon, Mars and Earth, and a small head regresses scale-free geomorphometry (slope, relief,
closed-depression share) so the embedding stays physically interpretable."""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

SIZE = 64


# ----------------------------------------------------------------------------------------------------------- render
def rotate(x, angle, flip, scale):
    """Rotate/flip/zoom a batch (B,1,H,W) about its centre with bilinear sampling (reflection padding)."""
    b = x.shape[0]
    c, s = torch.cos(angle) / scale, torch.sin(angle) / scale
    fx = torch.where(flip, -1.0, 1.0)
    theta = torch.stack([torch.stack([c * fx, -s, torch.zeros_like(c)], 1),
                         torch.stack([s * fx, c, torch.zeros_like(c)], 1)], 1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    return F.grid_sample(x, grid, mode='bilinear', padding_mode='reflection', align_corners=False)


def normals(z, spacing):
    """Surface normals of z (B,1,H,W) in metres with pixel spacing (B,) metres."""
    zp = F.pad(z, (1, 1, 1, 1), mode='replicate')
    dzdx = (zp[..., 1:-1, 2:] - zp[..., 1:-1, :-2]) / (2 * spacing[:, None, None, None])
    dzdy = (zp[..., 2:, 1:-1] - zp[..., :-2, 1:-1]) / (2 * spacing[:, None, None, None])
    n = torch.cat([-dzdx, -dzdy, torch.ones_like(dzdx)], 1)
    return n / n.norm(dim=1, keepdim=True)


def cast_shadow(z, spacing, az, el):
    """Binary shadow mask by horizon scan along the sun azimuth (sun-aligned frame, cumulative max)."""
    zr = rotate(z, -az, torch.zeros_like(az, dtype=torch.bool), torch.ones_like(az))  # sun now comes from +x
    w = z.shape[-1]
    dist = torch.arange(w, device=z.device, dtype=z.dtype).flip(0) * spacing[:, None]  # distance to the +x edge
    h = zr[:, 0] + (dist * torch.tan(el)[:, None])[:, None, :]  # height of each pixel's sun ray at the edge plane
    horizon = torch.flip(torch.cummax(torch.flip(h, [-1]), -1).values, [-1])
    shadow = (h < horizon - 1e-3).float()[:, None]
    return rotate(shadow, az, torch.zeros_like(az, dtype=torch.bool), torch.ones_like(az)) > 0.5


def smooth_noise(b, device, scale=8):
    n = torch.randn(b, 1, scale, scale, device=device)
    return F.interpolate(n, size=(SIZE, SIZE), mode='bicubic', align_corners=False)


def render(z, spacing, gen=None, canonical=None):
    """Grey image in [0,1] of DEM batch z (B,1,H,W metres). canonical=(az, el) fixes the sun and disables noise."""
    b, dev = z.shape[0], z.device
    if canonical is None:
        az = torch.rand(b, device=dev) * 2 * math.pi
        el = torch.deg2rad(5 + torch.rand(b, device=dev) * 60)
        mix = torch.rand(b, device=dev)[:, None, None, None]
    else:
        az = torch.full((b,), canonical[0], device=dev)
        el = torch.full((b,), canonical[1], device=dev)
        mix = torch.full((b, 1, 1, 1), 0.5, device=dev)
    n = normals(z, spacing)
    s = torch.stack([torch.cos(el) * torch.cos(az), torch.cos(el) * torch.sin(az), torch.sin(el)], 1)[..., None, None]
    cos_i = (n * s).sum(1, keepdim=True).clamp(min=0)
    cos_e = n[:, 2:3].clamp(min=1e-3)
    lommel = 2 * cos_i / (cos_i + cos_e + 1e-6)
    img = mix * lommel / 2 + (1 - mix) * cos_i
    img = img * (~cast_shadow(z, spacing, az, el)).float()
    if canonical is None:
        img = img * (1 + 0.3 * torch.rand(b, 1, 1, 1, device=dev) * smooth_noise(b, dev))  # albedo patches
        sig = torch.rand(b, device=dev) * 1.2
        img = gaussian_blur(img, sig)
        img = img + torch.randn_like(img) * torch.rand(b, 1, 1, 1, device=dev) * 0.04
        gamma = torch.exp((torch.rand(b, 1, 1, 1, device=dev) - 0.5) * 0.6)
        img = img.clamp(min=0) ** gamma
    return normalize_image(img)


def gaussian_blur(img, sigma):
    """Per-image blur with sigma quantised to a few levels (one convolution per level)."""
    out = img.clone()
    levels = torch.tensor([0.0, 0.5, 0.8, 1.2], device=img.device)
    q = (sigma[:, None] - levels[None]).abs().argmin(1)
    for k in range(1, len(levels)):
        idx = torch.nonzero(q == k).flatten()
        if len(idx) == 0:
            continue
        s = float(levels[k])
        r = int(math.ceil(2 * s))
        ker = torch.exp(-torch.arange(-r, r + 1, device=img.device, dtype=img.dtype) ** 2 / (2 * s * s))
        ker = ker / ker.sum()
        x = F.conv2d(F.pad(img[idx], (r, r, 0, 0), mode='reflect'), ker.view(1, 1, 1, -1))
        out[idx] = F.conv2d(F.pad(x, (0, 0, r, r), mode='reflect'), ker.view(1, 1, -1, 1))
    return out


def normalize_image(img):
    """Per-image 1-99 percentile stretch, same as the image path used for real photographs."""
    flat = img.flatten(1)
    lo = torch.quantile(flat, 0.01, dim=1)[:, None, None, None]
    hi = torch.quantile(flat, 0.99, dim=1)[:, None, None, None]
    return ((img - lo) / (hi - lo).clamp(min=1e-4)).clamp(0, 1)


def augment_geometry(z):
    b, dev = z.shape[0], z.device
    angle = torch.rand(b, device=dev) * 2 * math.pi
    flip = torch.rand(b, device=dev) < 0.5
    scale = 0.8 + torch.rand(b, device=dev) * 0.2
    return rotate(z, angle, flip, 1 / scale), scale


# ------------------------------------------------------------------------------------------------ geomorphometry
def batch_fill_depth(z, iters=96):
    """Closed-depression depth on small patches (edges drain), GPU morphological reconstruction."""
    big = z.amax((-2, -1), keepdim=True) + 1e4
    edge = torch.zeros_like(z, dtype=torch.bool)
    edge[..., 0, :] = edge[..., -1, :] = edge[..., :, 0] = edge[..., :, -1] = True
    m = torch.where(edge, z, big.expand_as(z))
    for _ in range(iters):
        m = torch.maximum(z, -F.max_pool2d(-m, 3, 1, 1))
    return m - z


def geomorphometry(z, spacing):
    """Scale-free targets: mean slope (rad), log relief per km, closed-depression area share, log depression depth."""
    n = normals(z, spacing)
    slope = torch.acos(n[:, 2].clamp(-1, 1)).mean((-2, -1))
    flat = z.flatten(1)
    relief = torch.quantile(flat, 0.9, 1) - torch.quantile(flat, 0.1, 1)
    extent_km = spacing * (SIZE - 1) / 1000
    depth = batch_fill_depth(z)
    share = (depth > 0.002 * relief[:, None, None, None].clamp(min=1)).float().mean((-3, -2, -1))
    return torch.stack([slope, torch.log1p(relief / extent_km), share, torch.log1p(depth.amax((-3, -2, -1)) / extent_km)], 1)


# -------------------------------------------------------------------------------------------------------- model
class GradReverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x, lam):
        ctx.lam = lam
        return x.view_as(x)

    @staticmethod
    def backward(ctx, g):
        return -ctx.lam * g, None


def block(cin, cout, stride):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, stride, 1, bias=False), nn.GroupNorm(8, cout), nn.SiLU(),
                         nn.Conv2d(cout, cout, 3, 1, 1, bias=False), nn.GroupNorm(8, cout), nn.SiLU())


class CoarseEncoder(nn.Module):
    """~1.2 M parameters; 64x64 grey image -> 128-d unit embedding."""

    def __init__(self, dim=128):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(1, 32, 3, 1, 1, bias=False), nn.GroupNorm(8, 32), nn.SiLU())
        self.stages = nn.Sequential(block(32, 48, 2), block(48, 96, 2), block(96, 160, 2), block(160, 224, 2))
        self.proj = nn.Sequential(nn.Linear(448, 256), nn.SiLU(), nn.Linear(256, dim))
        self.head_ssl = nn.Sequential(nn.Linear(dim, 256), nn.SiLU(), nn.Linear(256, 128))
        self.head_body = nn.Sequential(nn.Linear(dim, 64), nn.SiLU(), nn.Linear(64, 3))
        self.head_geo = nn.Sequential(nn.Linear(dim, 64), nn.SiLU(), nn.Linear(64, 4))

    def embed(self, x):
        h = self.stages(self.stem(x * 2 - 1))
        pooled = torch.cat([h.mean((-2, -1)), h.amax((-2, -1))], 1)
        return F.normalize(self.proj(pooled), dim=1)

    def forward(self, x, lam=0.0):
        e = self.embed(x)
        return e, F.normalize(self.head_ssl(e), dim=1), self.head_body(GradReverse.apply(e, lam)), self.head_geo(e)


def nt_xent(a, b, t=0.1):
    logits = a @ b.t() / t
    target = torch.arange(len(a), device=a.device)
    return 0.5 * (F.cross_entropy(logits, target) + F.cross_entropy(logits.t(), target))


CANONICAL_SUNS = [(math.radians(a), math.radians(30)) for a in (45, 135, 225, 315)]


@torch.no_grad()
def embed_dem(model, z, spacing):
    """Illumination-marginalised embedding of DEM squares: mean over four canonical suns, renormalised."""
    acc = 0
    for az, el in CANONICAL_SUNS:
        acc = acc + model.embed(render(z, spacing, canonical=(az, el)))
    return F.normalize(acc, dim=1)
