"""PitChain-C2F fine stage network (F-Net): a sun-canonical U-Net distilled from the DEM teacher.

Input (B,3,H,W) on a 10 m grid, already rotated so the sun shines from the top of the patch:
  0 grey image (0..1, 1-99 % stretch)   1 coarse DEM, metres minus patch median, / 50
  2 coarse DEM closed-depression depth (fill on the 30 m-quality DEM), / 10
Outputs: pit logit (sub-pixel pit-like collapse present in the 10 m cell), log1p closed-depression depth (metres),
and a 32-d per-pixel descriptor used to describe detected pits for matching."""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def conv(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, 1, 1, bias=False), nn.GroupNorm(8, cout), nn.SiLU(),
                         nn.Conv2d(cout, cout, 3, 1, 1, bias=False), nn.GroupNorm(8, cout), nn.SiLU())


class FNet(nn.Module):
    def __init__(self, c=(24, 48, 96, 160)):
        super().__init__()
        self.e1, self.e2, self.e3, self.e4 = conv(3, c[0]), conv(c[0], c[1]), conv(c[1], c[2]), conv(c[2], c[3])
        self.d3, self.d2, self.d1 = conv(c[3] + c[2], c[2]), conv(c[2] + c[1], c[1]), conv(c[1] + c[0], c[0])
        self.pit = nn.Conv2d(c[0], 1, 1)
        self.depth = nn.Conv2d(c[0], 1, 1)
        self.desc = nn.Conv2d(c[0], 32, 1)
        nn.init.constant_(self.pit.bias, -4.0)  # pits are rare

    def forward(self, x):
        e1 = self.e1(x)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        e4 = self.e4(F.max_pool2d(e3, 2))
        up = lambda a, b: F.interpolate(a, size=b.shape[-2:], mode='bilinear', align_corners=False)
        d3 = self.d3(torch.cat([up(e4, e3), e3], 1))
        d2 = self.d2(torch.cat([up(d3, e2), e2], 1))
        d1 = self.d1(torch.cat([up(d2, e1), e1], 1))
        return self.pit(d1)[:, 0], self.depth(d1)[:, 0], F.normalize(self.desc(d1), dim=1)


def fill_depth(z, iters=256):
    """Closed-depression depth of DEM batch z (B,1,H,W); patch edges drain."""
    big = z.amax((-2, -1), keepdim=True) + 1e4
    edge = torch.zeros_like(z, dtype=torch.bool)
    edge[..., 0, :] = edge[..., -1, :] = edge[..., :, 0] = edge[..., :, -1] = True
    m = torch.where(edge, z, big.expand_as(z))
    for _ in range(iters):
        nxt = torch.maximum(z, -F.max_pool2d(-m, 3, 1, 1))
        if torch.equal(nxt, m):
            break
        m = nxt
    return m - z


def rotate_batch(x, angle_rad, mode='bilinear'):
    """Rotate (B,C,H,W) counter-clockwise by angle about the centre (zeros outside)."""
    c, s = torch.cos(angle_rad), torch.sin(angle_rad)
    z = torch.zeros_like(c)
    theta = torch.stack([torch.stack([c, -s, z], 1), torch.stack([s, c, z], 1)], 1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    return F.grid_sample(x, grid, mode=mode, padding_mode='zeros', align_corners=False)


def make_input(img, dem):
    """img (B,1,H,W) 0..1, dem (B,1,H,W) metres -> network input (B,3,H,W)."""
    rel = dem - dem.flatten(1).median(1).values[:, None, None, None]
    return torch.cat([img, rel / 50.0, fill_depth(dem) / 10.0], 1)


def sun_to_top(sun_az_deg):
    """Counter-clockwise rotation (radians) that brings a sun at azimuth az (clockwise from north/top) to the top."""
    return torch.deg2rad(torch.as_tensor(sun_az_deg, dtype=torch.float32))
