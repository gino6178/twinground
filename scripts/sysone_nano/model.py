"""SysOne-Nano: a multimodal Jev/Laya-style typed decision model under 200,000 parameters.

Same System One interface as SysOne-Terrain (state encoded once; typed questions answered in one parallel pass, each
with its own option markers and an independence mask; proper-scoring training, per-question temperatures; act/escalate
output), shrunk to d = 64 and given a second modality:
  * terrain tokens: 64 patches of the 64x64 window (normalised elevation, slope, curvature), plus a window-size token;
  * material tokens: four within-body percentile axes [albedo, ferric, mafic, hydroxyl]; a missing axis gets a learned
    "missing" embedding, so Moon (albedo, mafic) and Mars (albedo, ferric, mafic, hydrated) windows use what they have.
Every forward pass uses all parameters (no routing), so the parameters active per call equal the total."""
import torch
import torch.nn as nn
import torch.nn.functional as F

QUESTIONS = [
    ('rock', 'choice', ['basaltic', 'other_volcanic', 'plutonic', 'sedimentary', 'unconsolidated', 'metamorphic', 'ice']),
    ('volcano60', 'noul', ['no', 'yes']),
    ('dunes', 'noul', ['no', 'yes']),
    ('ice', 'noul', ['no', 'yes']),
    ('aridity', 'score', ['hyperarid', 'arid', 'semiarid', 'dry_subhumid', 'humid']),
    ('cold', 'noul', ['no', 'yes']),
    ('frozen', 'noul', ['no', 'yes']),
    ('bare', 'noul', ['no', 'yes']),
]
SCALES = (20, 40, 80)
AXES = ('albedo', 'ferric', 'mafic', 'hydroxyl')


def terrain_channels(dem):
    z = dem - dem.mean(dim=(1, 2), keepdim=True)
    z = z / (z.std(dim=(1, 2), keepdim=True) + 1e-3)
    gy, gx = torch.gradient(z, dim=(1, 2))
    slope = torch.sqrt(gx ** 2 + gy ** 2)
    lap = F.conv2d(z[:, None], z.new_tensor([[[[0, 1, 0], [1, -4, 1], [0, 1, 0]]]]), padding=1)[:, 0]
    return torch.stack([z, slope / (slope.mean(dim=(1, 2), keepdim=True) + 1e-3) - 1, lap.clamp(-6, 6) / 2], 1)


class Block(nn.Module):
    def __init__(self, d, heads):
        super().__init__()
        self.n1, self.n2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.attn = nn.MultiheadAttention(d, heads, batch_first=True)
        self.mlp = nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(), nn.Linear(4 * d, d))

    def forward(self, x, mask=None):
        h = self.n1(x)
        x = x + self.attn(h, h, h, attn_mask=mask, need_weights=False)[0]
        return x + self.mlp(self.n2(x))


class SysOneNano(nn.Module):
    def __init__(self, d=64, depth=2, head_depth=1, heads=4, patch=8, size=64, use_material=True):
        super().__init__()
        self.use_material = use_material
        n_tok = (size // patch) ** 2
        self.patch = nn.Conv2d(3, d, patch, patch)
        self.pos = nn.Parameter(torch.zeros(1, n_tok, d))
        self.scale = nn.Embedding(len(SCALES), d)
        n_mat = len(AXES) if use_material else 0
        if use_material:
            self.axis = nn.Embedding(len(AXES), d)
            self.value = nn.Sequential(nn.Linear(1, 32), nn.GELU(), nn.Linear(32, d))
            self.missing = nn.Parameter(torch.zeros(1, 1, d))
        self.encoder = nn.ModuleList([Block(d, heads) for _ in range(depth)])
        self.enc_norm = nn.LayerNorm(d)
        self.q_emb = nn.Embedding(len(QUESTIONS), d)
        self.n_opts = [len(o) for _, _, o in QUESTIONS]
        self.opt_emb = nn.Embedding(sum(self.n_opts), d)
        self.head = nn.ModuleList([Block(d, heads) for _ in range(head_depth)])
        self.head_norm = nn.LayerNorm(d)
        self.scorer = nn.Linear(d, 1)
        self.escalate = nn.Linear(d, 1)
        nn.init.trunc_normal_(self.pos, std=0.02)
        n_state = n_tok + 1 + n_mat
        blocks, start = [], n_state
        for k in self.n_opts:
            blocks.append((start, start + 1 + k)); start += 1 + k
        mask = torch.ones(start, start, dtype=torch.bool)
        mask[:n_state, :n_state] = False
        for a, b in blocks:
            mask[a:b, :n_state] = False
            mask[a:b, a:b] = False
        self.register_buffer('head_mask', mask, persistent=False)
        self.blocks, self.n_state = blocks, n_state

    def encode(self, dem, scale_idx, material=None):
        x = self.patch(terrain_channels(dem)).flatten(2).transpose(1, 2) + self.pos
        parts = [self.scale(scale_idx)[:, None], x]
        if self.use_material:
            B = dem.shape[0]
            m = material if material is not None else dem.new_full((B, len(AXES)), float('nan'))
            ok = torch.isfinite(m)
            v = self.value(torch.nan_to_num(m, nan=0.0)[..., None])
            tok = torch.where(ok[..., None], v, self.missing.expand(B, len(AXES), -1)) + self.axis.weight[None]
            parts.append(tok)
        x = torch.cat(parts, 1)
        for blk in self.encoder:
            x = blk(x)
        return self.enc_norm(x)

    def forward(self, dem, scale_idx, material=None):
        state = self.encode(dem, scale_idx, material)
        B = state.shape[0]
        parts, oi = [state], 0
        for qi, k in enumerate(self.n_opts):
            q = self.q_emb.weight[qi][None, None].expand(B, 1, -1)
            o = self.opt_emb.weight[oi:oi + k][None].expand(B, k, -1); oi += k
            parts.append(torch.cat([q, o], 1))
        x = torch.cat(parts, 1)
        for blk in self.head:
            x = blk(x, self.head_mask)
        x = self.head_norm(x)
        logits, esc = [], []
        for a, b in self.blocks:
            logits.append(self.scorer(x[:, a + 1:b]).squeeze(-1))
            esc.append(self.escalate(x[:, a]).squeeze(-1))
        return logits, torch.stack(esc, 1), state[:, 0]


def proper_loss(logits, y, kind):
    logp = F.log_softmax(logits.float(), -1)
    p = logp.exp()
    loss = F.nll_loss(logp, y, reduction='none')
    loss = loss - 0.5 * (p.gather(1, y[:, None]).squeeze(1) / p.norm(dim=1).clamp_min(1e-6))
    if kind == 'score':
        cdf = p.cumsum(1)
        target = (torch.arange(p.shape[1], device=y.device)[None] >= y[:, None]).float()
        loss = loss + ((cdf - target) ** 2).sum(1) / (p.shape[1] - 1)
    return loss


if __name__ == '__main__':
    for mm in (True, False):
        m = SysOneNano(use_material=mm)
        print('use_material', mm, 'parameters', sum(p.numel() for p in m.parameters()))
