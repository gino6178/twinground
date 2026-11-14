"""Load immutable search dependencies before accepting traffic (no response cache)."""
import json
import time

WARM_QUERIES = (
    ("lat=8.7&lon=27.4&size_km=20&surface=any&rock=any&limit=5", False),
    ("lat=18.4&lon=77.7&size_km=40&surface=any&rock=any&limit=5", True),
)


def warm(web=None):
    from context_ranker import context_arrays
    from scripts.visual_geology_v1.global_index import _ready_snapshot, initialize, status
    from server import search
    from server.params import Query
    from server.resources import resources

    started = time.monotonic()
    data = resources()
    initialize()
    for scale, (indices, _) in data.scale_data.items():
        centers = tuple((float(data.rows[int(i)]["center"]["latitude"]),
                         float(data.rows[int(i)]["center"]["longitude_east"])) for i in indices)
        context_arrays(centers, scale)
        status(scale)
        _ready_snapshot(scale, int(time.monotonic() // 5))
    # Opens catalogues, raster handles and image-source checksums on both bodies.
    for query, is_mars in WARM_QUERIES:
        search.search(Query(query, keep_blank=True), is_mars)
    print(json.dumps({"search_warmup_seconds": round(time.monotonic() - started, 3),
                      "eligible_windows": sum(len(v[0]) for v in data.scale_data.values())}), flush=True)
