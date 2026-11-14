"""Image-only visual landform retrieval. No mineral-identification claims."""
from pathlib import Path
import hashlib
import numpy as np
from PIL import Image, ImageOps
import torch
from torch import nn
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/visual_geology_v1'
SEED = 20261015

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def gray_image(image):
    a = np.asarray(ImageOps.exif_transpose(image).convert('L'), dtype=np.float32)
    lo, hi = np.percentile(a, [1, 99])
    if hi - lo < 1: raise ValueError('Image has insufficient visible contrast')
    a = np.clip((a-lo)/(hi-lo)*255, 0, 255).astype('uint8')
    return Image.fromarray(a).resize((128,128), Image.Resampling.BILINEAR)

def tensor_image(image):
    a = np.asarray(gray_image(image)).copy()
    return torch.from_numpy(a).float()[None]/255

class TinyVisualEncoder(nn.Module):
    def __init__(self, classes=15):
        super().__init__()
        layers=[nn.Conv2d(1,12,3,2,1,bias=False),nn.GroupNorm(4,12),nn.SiLU()]
        c=12
        for n,stride in [(24,2),(40,2),(64,2),(64,1)]:
            layers.extend([nn.Conv2d(c,c,3,stride,1,groups=c,bias=False),nn.GroupNorm(4,c),nn.SiLU(),
                           nn.Conv2d(c,n,1,bias=False),nn.GroupNorm(4,n),nn.SiLU()]);c=n
        self.features=nn.Sequential(*layers)
        self.project=nn.Linear(128,48)
        self.classifier=nn.Linear(48,classes)
    def forward(self,x):
        h=self.features(x)
        pooled=torch.cat([h.mean((-2,-1)),torch.sqrt(h.var((-2,-1),unbiased=False)+1e-6)],1)
        z=F.normalize(self.project(pooled),dim=1)
        return self.classifier(z)*10,z

@torch.inference_mode()
def image_features(m,x):
    return m(x)[1]

def embedding(model, images):
    return model(images)[1]
