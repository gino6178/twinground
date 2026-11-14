"""Load immutable search dependencies before accepting traffic."""
import time,json
def warm(web):
 started=time.monotonic();model,sites,rows,scale_data,report=web.resources()
 from context_ranker import context_arrays,desert_grid
 from scripts.visual_geology_v1.global_index import initialize,status,_ready_snapshot
 initialize()
 for scale,(indices,_) in scale_data.items():
  centers=tuple((float(rows[int(i)]['center']['latitude']),float(rows[int(i)]['center']['longitude_east'])) for i in indices)
  context_arrays(centers,scale)
  status(scale);_ready_snapshot(scale,int(time.monotonic()//5))
 # Initializes catalogs, raster handles and image source checksums. No response cache.
 for path in ['/api/search?lat=8.7&lon=27.4&size_km=20&surface=any&rock=any&limit=5',
              '/api/mars-search?lat=18.4&lon=77.7&size_km=40&surface=any&rock=any&limit=5']:
  handler=object.__new__(web.Handler);handler.path=path
  def response(value,code=200):
   if code!=200:raise RuntimeError('Search warmup failed: '+str(value))
  handler.json_response=response;handler.do_GET()
 print(json.dumps({'search_warmup_seconds':round(time.monotonic()-started,3),'eligible_windows':sum(len(v[0]) for v in scale_data.values())}),flush=True)
