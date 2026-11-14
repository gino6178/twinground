"""Persistent global image feature index. Missing imagery is never a zero score."""
import io,json,math,sqlite3,time,hashlib,os,threading
from pathlib import Path
from functools import lru_cache
import numpy as np
import torch
from PIL import Image
from .model import ROOT,OUT,TinyVisualEncoder,tensor_image,sha
BASE=OUT/'global';DB=BASE/'index.sqlite';PATCH_M=1536
ATTRIBUTION='Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)'
DOWNLOAD_LOCK=threading.Lock()
LAST_DOWNLOAD=0.
DOWNLOAD_RATE=min(128.,max(1.,float(os.environ.get("INDEX_REQUESTS_PER_SECOND","4"))))
DOWNLOAD_BLOCKED_UNTIL=0.
def wait_download_slot():
 global LAST_DOWNLOAD
 while True:
  with DOWNLOAD_LOCK:
   now=time.monotonic();delay=max(DOWNLOAD_BLOCKED_UNTIL,LAST_DOWNLOAD+1/DOWNLOAD_RATE)-now
   if delay<=0:LAST_DOWNLOAD=now;return
  time.sleep(min(delay,1.))
def source_backoff(response):
 global DOWNLOAD_BLOCKED_UNTIL,DOWNLOAD_RATE
 from email.utils import parsedate_to_datetime
 value=response.headers.get("Retry-After","30")
 try:delay=float(value)
 except ValueError:
  try:delay=parsedate_to_datetime(value).timestamp()-time.time()
  except Exception:delay=30
 with DOWNLOAD_LOCK:
  DOWNLOAD_RATE=max(1.,DOWNLOAD_RATE/2)
  DOWNLOAD_BLOCKED_UNTIL=max(DOWNLOAD_BLOCKED_UNTIL,time.monotonic()+max(1,delay))
 print(json.dumps({"source_backoff_status":response.status_code,"rate":DOWNLOAD_RATE,"retry_after_seconds":max(1,delay)}),flush=True)
HTTP_LOCAL=threading.local()
TILE_LOCKS=[threading.Lock() for _ in range(128)]
def http_session():
 import requests
 if not hasattr(HTTP_LOCAL,"session"):HTTP_LOCAL.session=requests.Session()
 return HTTP_LOCAL.session
def connect():
 BASE.mkdir(exist_ok=True);c=sqlite3.connect(DB,timeout=20);c.execute('PRAGMA journal_mode=WAL');return c
def initialize():
 with connect() as c:
  c.executescript('CREATE TABLE IF NOT EXISTS points (key TEXT PRIMARY KEY,lat REAL,lon REAL,priority INTEGER DEFAULT 100,status TEXT DEFAULT "pending",vector BLOB,attempts INTEGER DEFAULT 0,error TEXT,updated REAL DEFAULT 0);CREATE TABLE IF NOT EXISTS windows (id TEXT PRIMARY KEY,key TEXT,scale INTEGER);CREATE INDEX IF NOT EXISTS queue ON points(status,priority,updated);CREATE INDEX IF NOT EXISTS window_scale ON windows(scale);')
  c.execute('CREATE INDEX IF NOT EXISTS window_key ON windows(key)')
  c.execute('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT)')
  expected=sha(OUT/'model.pt');prior=c.execute('SELECT value FROM metadata WHERE key="model_sha256"').fetchone()
  if prior and prior[0]!=expected:raise RuntimeError('Model changed:rebuild separate global index')
  c.execute('INSERT OR IGNORE INTO metadata VALUES("model_sha256",?)',(expected,))
  c.execute('INSERT OR IGNORE INTO metadata VALUES("source",?)',(ATTRIBUTION,))
  if 'image_sha256' not in [r[1] for r in c.execute('PRAGMA table_info(points)')]:c.execute('ALTER TABLE points ADD COLUMN image_sha256 TEXT')
def point_key(lat,lon):return f'{lat:.6f},{((lon+180)%360)-180:.6f}'
@lru_cache(maxsize=1)
def model():
 report=json.loads((OUT/'report.json').read_text());assert sha(OUT/'model.pt')==report['model_sha256'];assert (OUT/'model.pt').stat().st_size<100000
 m=TinyVisualEncoder().eval();m.load_state_dict(torch.load(OUT/'model.pt',map_location='cpu',weights_only=True));return m
@torch.inference_mode()
def encode(image):return model()(tensor_image(image)[None])[1][0].numpy().astype('<f2')
def _status_uncached(scale=None):
 if not DB.exists():return {'total':0,'ready':0,'pending':0,'failed':0,'state':'initializing'}
 with connect() as c:
  where=' WHERE w.scale=?' if scale else '';args=(scale,) if scale else ()
  counts=dict(c.execute('SELECT p.status,COUNT(*) FROM windows w JOIN points p ON p.key=w.key'+where+' GROUP BY p.status',args))
  unique=c.execute('SELECT COUNT(*) FROM points').fetchone()[0]
 return {'total':sum(counts.values()),'ready':counts.get('ready',0),'pending':counts.get('pending',0),'failed':counts.get('failed',0),
         'unique_centers':unique,'state':'building' if counts.get('pending',0) else 'settled','patch_m':PATCH_M,'dimensions':48,
         'model_bytes':75123,'model_sha256':sha(OUT/'model.pt'),'source':ATTRIBUTION,'license':'CC BY 4.0','scope':'One 1536m center sample per terrain window,not complete pixel coverage of20/40/80km',
         'training_scope':'Mars landforms;cross-planet geological accuracy not validated'}
@lru_cache(maxsize=16)
def _status_cached(scale,bucket):return _status_uncached(scale)
def status(scale=None):
 value=dict(_status_cached(scale,int(time.monotonic()//5)))
 value['max_status_cache_age_seconds']=5
 return value

@lru_cache(maxsize=16)
def _ready_snapshot(scale,bucket):
 with connect() as c:
  return c.execute('SELECT w.id,p.vector FROM points p INDEXED BY queue JOIN windows w INDEXED BY window_key ON w.key=p.key WHERE p.status="ready" AND w.scale=?',(scale,)).fetchall()

@lru_cache(maxsize=32)
def reference(body,lat,lon):
 if body=='mars':
  from mars_imagery import sources,project_image,distance_m
  for source in sources():
   if distance_m((lat,lon),source['center'])>source['radius_m']+PATCH_M:continue
   rgba,meta=project_image(source['path'],lat,lon,PATCH_M/1000,pixels=128)
   if meta.get('valid_fraction',0)>=.99:
    return encode(Image.fromarray(rgba).convert('RGB')),{'available':True,'source':'NASA/JPL/MSSS USGS CTX','sample_m':PATCH_M,'source_sha256':source['sha256']}
 # Use only native high resolution image sources, never a globe texture.
 import rasterio
 from rasterio.warp import transform
 from rasterio.windows import Window
 p=json.loads((ROOT/'data/research/redesign_v1/paired_modalities/dataset_v1/protocol.json').read_text())
 for s in p['sites']:
  if s['body']!=body:continue
  with rasterio.open(ROOT/s['image']) as ds:
   geog=ds.crs.to_dict();radius=geog.get('R',geog.get('a',1737400 if body=='moon' else 3396190))
   x,y=transform(f'+proj=longlat +R={radius}',ds.crs,[lon],[lat]);row,col=ds.index(x[0],y[0]);n=round(PATCH_M/abs(ds.res[0]))
   if row-n//2<0 or col-n//2<0 or row+n//2>=ds.height or col+n//2>=ds.width:continue
   a=ds.read(1,window=Window(col-n//2,row-n//2,n,n),out_shape=(128,128),masked=True)
   if np.ma.getmaskarray(a).mean()>.01:continue
   a=np.asarray(a,dtype='float32');lo,hi=np.percentile(a,[1,99])
   if hi-lo<1e-6:continue
   im=Image.fromarray(np.clip((a-lo)/(hi-lo)*255,0,255).astype('uint8'))
   return encode(im),{'available':True,'source':s['source_url'],'sample_m':PATCH_M,'site':s['site']}
 return None,{'available':False,'reason':'No verified high-resolution image covers the1536m center sample;terrain ranking retained','sample_m':PATCH_M}
def compare(rows,indices,shortlist,context_scores,body,lat,lon,scale,mode='complete'):
 if mode not in ('complete','available'):raise ValueError('Invalid visual mode')
 meta=status(scale);meta.update(applied=False,ranking='terrain_pending_global_image_coverage',mode=mode,snapshot_unix=time.time())
 try:q,ref=reference(body,lat,lon)
 except Exception as e:q=None;ref={'available':False,'reason':'Reference imagery unavailable','error_type':type(e).__name__}
 meta['reference']=ref;matches={}
 if not DB.exists():return shortlist,meta,matches
 with connect() as c:
  hot=[point_key(rows[int(indices[int(i)])]['center']['latitude'],rows[int(indices[int(i)])]['center']['longitude_east']) for i in shortlist]
  c.executemany('UPDATE points SET priority=0 WHERE key=? AND status="pending"',[(k,) for k in hot])
  if q is None:return shortlist,meta,matches
 ready=_ready_snapshot(scale,int(time.monotonic()//5))
 if ready:
  vectors=np.stack([np.frombuffer(v,dtype='<f2').astype('float32') for _,v in ready]);norm=np.linalg.norm(vectors,axis=1).clip(1e-8)
  cos=(vectors@q.astype('float32'))/(norm*max(float(np.linalg.norm(q)),1e-8));matches={row[0]:float(v) for row,v in zip(ready,cos)}
 # Do not mix partially measured scores with unmeasured candidates or bias toward cached areas.
 covered=np.array([rows[int(i)]['id'] in matches for i in indices],bool)
 if covered.all() or (mode=='available' and covered.any()):
  fused=context_scores['fused'];visual=np.array([matches.get(rows[int(i)]['id'],np.nan) for i in indices]);fused[covered]=.85*fused[covered]+.15*(visual[covered]+1)/2
  # Keep full-index context eligibility; caller supplies its precomputed eligible mask.
  allowed=context_scores.get('eligible',np.ones(len(indices),bool))&covered;ii=np.flatnonzero(allowed)
  if len(ii):
   shortlist=ii[np.argsort(-fused[ii],kind='stable')][:512]
   meta.update(applied=True,ranking='0.85_existing_score+0.15_center_image_similarity',compared_windows=len(ii),partial=not covered.all())
 return shortlist,meta,matches

def seed():
 initialize();import web_server
 _,_,rows,scale_data,_=web_server.resources()
 with connect() as c:
  for scale,(indices,_) in scale_data.items():
   points=[];windows=[]
   for i in indices:
    r=rows[int(i)];lat=r['center']['latitude'];lon=r['center']['longitude_east'];k=point_key(lat,lon)
    points.append((k,lat,lon));windows.append((r['id'],k,int(scale)))
   c.executemany('INSERT OR IGNORE INTO points(key,lat,lon) VALUES(?,?,?)',points)
   c.executemany('INSERT OR IGNORE INTO windows(id,key,scale) VALUES(?,?,?)',windows)
 print(json.dumps(status()),flush=True)

def tile(z,x,y):
 with TILE_LOCKS[hash(f"{z}-{x}-{y}")%len(TILE_LOCKS)]:return _tile(z,x,y)
def _tile(z,x,y):
 global LAST_DOWNLOAD
 import requests
 cache=BASE/'tiles';cache.mkdir(exist_ok=True);p=cache/f'{z}-{x}-{y}.jpg'
 if not p.exists():
  wait_download_slot()
  url=f'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'
  r=http_session().get(url,timeout=20,headers={'User-Agent':'AnalogAtlas-research-image-index/1.0'})
  if r.status_code in (429,503):source_backoff(r)
  r.raise_for_status()
  if len(r.content)>2000000 or not r.headers.get('Content-Type','').startswith('image/'):raise ValueError('Invalid tile')
  with Image.open(io.BytesIO(r.content)) as im:im.verify()
  tmp=p.with_suffix(f'.{threading.get_ident()}.tmp');tmp.write_bytes(r.content);tmp.replace(p)
 with Image.open(p) as im:return im.convert('RGB')
def earth_image(lat,lon):
 if abs(lat)>80:raise ValueError('Polar source not supported')
 z=math.ceil(math.log2(156543.033928*math.cos(math.radians(lat))/12));n=2**z;px=(lon+180)/360*n*256;py=(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n*256
 spacing=156543.033928*math.cos(math.radians(lat))/n;half=PATCH_M/(spacing*2)
 left,top=math.floor(px-half),math.floor(py-half);right,bottom=math.ceil(px+half),math.ceil(py+half)
 x0,x1=left//256,(right-1)//256;y0,y1=top//256,(bottom-1)//256
 mosaic=Image.new('RGB',((x1-x0+1)*256,(y1-y0+1)*256))
 for y in range(y0,y1+1):
  for x in range(x0,x1+1):mosaic.paste(tile(z,x%n,y),(256*(x-x0),256*(y-y0)))
 return mosaic.crop((left-x0*256,top-y0*256,right-x0*256,bottom-y0*256)).resize((128,128),Image.Resampling.BILINEAR)
def worker():
 import shutil
 from concurrent.futures import ThreadPoolExecutor,as_completed
 initialize();torch.set_num_threads(2);done=0
 pool=ThreadPoolExecutor(max_workers=4)
 while True:
  if shutil.disk_usage(BASE).free<20*1024**3:raise RuntimeError('Reserve20GiB free disk;index paused')
  with connect() as c:batch=c.execute('SELECT key,lat,lon,attempts FROM points WHERE status="pending" ORDER BY priority,updated,key LIMIT 20').fetchall()
  if not batch:pool.shutdown();print('Index queue complete',flush=True);return
  futures={pool.submit(earth_image,lat,lon):(k,attempts) for k,lat,lon,attempts in batch}
  for future in as_completed(futures):
   k,attempts=futures[future]
   try:
    im=future.result();v=encode(im);image_hash=hashlib.sha256(im.tobytes()).hexdigest()
    with connect() as c:c.execute('UPDATE points SET status="ready",vector=?,updated=?,error=NULL,image_sha256=? WHERE key=?',(v.tobytes(),time.time(),image_hash,k))
   except Exception as e:
    with connect() as c:c.execute('UPDATE points SET status=?,attempts=attempts+1,error=?,updated=? WHERE key=?',('failed' if attempts>=2 else 'pending',str(e)[:200],time.time(),k))
   done+=1
  if done%20==0:
   print(json.dumps(status()),flush=True)
   files=list((BASE/'tiles').glob('*.jpg'))
   if len(files)>4096:
    for p in sorted(files,key=lambda p:p.stat().st_mtime)[:len(files)-4096]:p.unlink()
if __name__=='__main__':
 import sys
 if '--seed' in sys.argv:seed()
 else:worker()
