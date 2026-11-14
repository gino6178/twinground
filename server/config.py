"""Paths and settings shared by the web server."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
WEB_DIST = ROOT / "web" / "dist"

HOST = os.environ.get("ATLAS_HOST", "0.0.0.0")
PORT = int(os.environ.get("ATLAS_PORT", "8765"))
TORCH_THREADS = int(os.environ.get("ATLAS_TORCH_THREADS", "4"))

MOON_SOURCE = "https://svs.gsfc.nasa.gov/4720/"
SRTM_SOURCE = "https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm"
ETOPO_SOURCE = "https://www.ncei.noaa.gov/products/etopo-global-relief-model"

# Research modules under src/ import each other by bare name.
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
