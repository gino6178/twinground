"""F-Net v2: image-only, native-resolution (1-5 m) pit / skylight detector, sun on top of the patch.

Same U-Net family as v1 but one input channel and wider layers. Rendering helpers turn a lidar/DTM patch into a
synthetic grey image lit from the top (cast shadows, Lambert/Lommel-Seeliger mix, albedo noise, blur, sensor noise)."""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from scripts.lavatube_c2f.coarse_model import cast_shadow, gaussian_blur, normals, smooth_noise
from scripts.lavatube_c2f.fine_model import conv

SUN_TOP = -math.pi / 2  # coarse_model.render convention: az=0 lights from +x (image right); -pi/2 lights from the top row


class FNet2(nn.Module):
    def __init__(self, c=(32, 64, 128, 192)):
        super().__init__()
        self.e1, self.e2, self.e3, self.e4 = conv(1, c[0]), conv(c[0], c[1]), conv(c[1], c[2]), conv(c[2], c[3])
        self.d3, self.d2, self.d1 = conv(c[3] + c[2], c[2]), conv(c[2] + c[1], c[1]), conv(c[1] + c[0], c[0])
        self.pit = nn.Conv2d(c[0], 1, 1)
        self.depth = nn.Conv2d(c[0], 1, 1)
        nn.init.constant_(self.pit.bias, -4.0)

    def forward(self, x):
        e1 = self.e1(x * 2 - 1)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        e4 = self.e4(F.max_pool2d(e3, 2))
        up = lambda a, b: F.interpolate(a, size=b.shape[-2:], mode='bilinear', align_corners=False)
        d3 = self.d3(torch.cat([up(e4, e3), e3], 1))
        d2 = self.d2(torch.cat([up(d3, e2), e2], 1))
        d1 = self.d1(torch.cat([up(d2, e1), e1], 1))
        return self.pit(d1)[:, 0], self.depth(d1)[:, 0]


def stretch(img, valid=None):
    """Per-patch 1-99 % stretch over valid pixels (the same normalisation is used at inference)."""
    b = img.shape[0]
    out = torch.empty_like(img)
    for i in range(b):
        v = img[i][valid[i] > 0] if valid is not None else img[i].flatten()
        if v.numel() < 16:
            out[i] = 0
            continue
        lo, hi = torch.quantile(v.float(), 0.01), torch.quantile(v.float(), 0.99)
        out[i] = ((img[i] - lo) / (hi - lo).clamp(min=1e-4)).clamp(0, 1)
    return out


def render_top(z, spacing, el_deg):
    """Synthetic image of DEM batch z (B,1,H,W, metres; spacing (B,) metres) lit from the top at elevation el."""
    b, dev = z.shape[0], z.device
    az = torch.full((b,), SUN_TOP, device=dev)
    el = torch.deg2rad(el_deg)
    n = normals(z, spacing)
    s = torch.stack([torch.cos(el) * torch.cos(az), torch.cos(el) * torch.sin(az), torch.sin(el)], 1)[..., None, None]
    cos_i = (n * s).sum(1, keepdim=True).clamp(min=0)
    cos_e = n[:, 2:3].clamp(min=1e-3)
    mix = torch.rand(b, 1, 1, 1, device=dev)
    img = mix * (2 * cos_i / (cos_i + cos_e + 1e-6)) / 2 + (1 - mix) * cos_i
    img = img * (~cast_shadow(z, spacing, az, el)).float()
    img = img * (1 + 0.35 * torch.rand(b, 1, 1, 1, device=dev) * smooth_noise(b, dev, scale=6)[..., :z.shape[-2], :z.shape[-1]]
                 if z.shape[-1] == 64 else 1 + 0.35 * torch.rand(b, 1, 1, 1, device=dev) * F.interpolate(torch.randn(b, 1, 6, 6, device=dev), size=z.shape[-2:], mode='bicubic', align_corners=False))
    img = gaussian_blur(img, torch.rand(b, device=dev) * 1.2)
    img = img + torch.randn_like(img) * torch.rand(b, 1, 1, 1, device=dev) * 0.03
    return img.clamp(min=0)
