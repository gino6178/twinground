"""Bounded image-upload inference and auditable image-only candidate retrieval."""
import base64,io,json,threading,time,math,re
from functools import lru_cache
import numpy as np
from PIL import Image,UnidentifiedImageError
import torch
try:
 from .model import ROOT,OUT,sha,TinyVisualEncoder,tensor_image
except ImportError:
 from model import ROOT,OUT,sha,TinyVisualEncoder,tensor_image
LOCK=threading.Lock()
@lru_cache(maxsize=1)
def resources():
 manifest=json.loads((OUT/'gallery_manifest.json').read_text())
 for key,name in [('model_sha256','model.pt'),('rows_sha256','gallery_rows.json'),('vectors_sha256','gallery_vectors.npy')]:
  if sha(OUT/name)!=manifest[key]:raise RuntimeError('Visual model/index checksum mismatch')
 assert (OUT/'model.pt').stat().st_size<100000
 model=TinyVisualEncoder().eval();model.load_state_dict(torch.load(OUT/'model.pt',map_location='cpu',weights_only=True))
 return model,json.loads((OUT/'gallery_rows.json').read_text()),np.load(OUT/'gallery_vectors.npy'),manifest
def status():
 report=json.loads((OUT/'report.json').read_text());meta=json.loads((OUT/'gallery_manifest.json').read_text())
 return {'version':'tiny-visual-geology-v1','model_bytes':report['model_file_bytes'],'parameters':report['parameters'],
         'candidate_count':meta['count'],'satellite_count':meta['satellite_count'],'model_sha256':meta['model_sha256'],
         'validation_scope':'Historical Mars landform benchmark;Earth-Mars geological relevance not validated',
         'experimental':True,'upload_storage':'Images processed in memory;not saved','mars_retrieval':report['retrieval'],
         'texture_baseline':report['texture_retrieval'],'mars_gate_passed':report['mars_retrieval_gate_passed']}
def bare_candidate(row):
 # Explicit optional cartographic screen, never a predicted geology label.
 if row['kind']!='satellite':return True
 shares=row.get('mapped_landcover_shares',{})
 return sum(shares.get(k,0) for k in ('331','332','333'))>=.5 and row.get('mapped_water_snow_share',1)<=.05
def decode(payload):
 if not isinstance(payload,dict):raise ValueError('Expected JSON object')
 if 'sample_id' in payload:
  sample=payload['sample_id']
  if not isinstance(sample,str) or not re.fullmatch(r'g\d{6}',sample):raise ValueError('Invalid sample')
  _,rows,_,_=resources();row=next((r for r in rows if r['id']==sample),None)
  if row is None:raise ValueError('Unknown sample')
  with Image.open(OUT/row['image']) as im:return im.copy(),sample,row['size_m']
 data=payload.get('image_base64','')
 if not isinstance(data,str) or len(data)>5600000:raise ValueError('Image must be below 4 MB')
 try:raw=base64.b64decode(data,validate=True)
 except Exception:raise ValueError('Invalid base64 image')
 if len(raw)>4*1024*1024:raise ValueError('Image must be below 4 MB')
 try:
  with Image.open(io.BytesIO(raw)) as im:
   if im.format not in ('PNG','JPEG','WEBP'):raise ValueError('Use PNG,JPEG or WebP')
   if min(im.size)<32 or max(im.size)>4096 or im.width*im.height>12000000:raise ValueError('Image dimensions must be 32–4096 pixels;max12MP')
   if max(im.size)/min(im.size)>1.05:raise ValueError('Please crop a square region before comparing')
   im.load();image=im.copy()
 except (UnidentifiedImageError,OSError,Image.DecompressionBombError):raise ValueError('Cannot read image')
 return image,None,None
def search(payload):
 if not LOCK.acquire(blocking=False):raise BlockingIOError('Image comparison busy;please retry shortly')
 try:
  start=time.monotonic();model,rows,vectors,manifest=resources();im,sample,sample_size=decode(payload)
  kind=payload.get('kind','satellite')
  if kind not in ('satellite','aerial','all'):raise ValueError('Invalid source kind')
  bare=payload.get('bare_only',True)
  if not isinstance(bare,bool):raise ValueError('bare_only must be boolean')
  size=payload.get('size_m',sample_size)
  if size is not None:
   size=float(size)
   if not math.isfinite(size) or not 50<=size<=100000:raise ValueError('Ground width must be 50–100000m')
  with torch.inference_mode():_,z=model(tensor_image(im)[None])
  scores=vectors@z[0].numpy();eligible=[i for i,r in enumerate(rows) if r['id']!=sample and (kind=='all' or r['kind']==kind) and (not bare or bare_candidate(r)) and (size is None or .5<=r['size_m']/size<=2)]
  order=sorted(eligible,key=lambda i:-float(scores[i]));selected=[]
  for i in order:
   row=rows[i]
   # Suppress overlapping nearby views; preserve exact raw visual score.
   if any((111320*(row['latitude']-r['latitude']))**2+(111320*math.cos(math.radians(row['latitude']))*(row['longitude']-r['longitude']))**2 < (max(row['size_m'],r['size_m'])*.6)**2 for r in selected):continue
   selected.append(dict(row,cosine_similarity=round(float(scores[i]),6),thumbnail=f'/api/visual-geology/image/{row["id"]}'))
   if len(selected)>=12:break
  return {'matches':selected,'eligible_candidates':len(eligible),'seconds':round(time.monotonic()-start,3),'model_sha256':manifest['model_sha256'],
          'query_size_m':size,'scale_filter':'0.5–2 times ground width' if size else 'Unknown ground scale;no scale filter',
          'score_meaning':'Embedding cosine,not probability of geological equivalence','experimental':True,
          'bare_screen':'Satellite-only CLC map proxy:natural bare/sparse>=50%,water/snow<=5%;NAIP not screened' if bare else 'off',
          'image_only':True,'sample_self_match_excluded':sample is not None}
 finally:LOCK.release()

class VisualMixin:
 def visual_get(self,path):
  if path=='/api/visual-geology/status':return self.json_response(status())
  if path=='/api/visual-geology/model':
   p=OUT/'model.pt';data=p.read_bytes();mime='application/octet-stream'
  elif path=='/api/visual-geology/example':
   data=(OUT/'mars_example.png').read_bytes();mime='image/png'
  elif re.fullmatch(r'/api/visual-geology/image/g\d{6}',path):
   id=path.rsplit('/',1)[1];p=OUT/'gallery'/(id+'.png')
   if not p.exists():return self.json_response({'error':'Unknown image'},404)
   data=p.read_bytes();mime='image/png'
  else:return self.json_response({'error':'Unknown visual endpoint'},404)
  self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)))
  if path.endswith('/model'):self.send_header('Content-Disposition','attachment; filename="tiny-visual-geology.pt"')
  self.end_headers();self.wfile.write(data)
 def do_POST(self):
  if self.path!='/api/visual-geology/search':return self.json_response({'error':'Unknown endpoint'},404)
  try:
   length=int(self.headers.get('Content-Length','0'))
   if not 1<=length<=5700000:return self.json_response({'error':'Request must be below 5.7 MB'},413)
   if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.json_response({'error':'Use application/json'},415)
   self.connection.settimeout(20)
   payload=json.loads(self.rfile.read(length));return self.json_response(search(payload))
  except BlockingIOError as e:return self.json_response({'error':str(e)},429)
  except (ValueError,TypeError,TimeoutError) as e:return self.json_response({'error':str(e)},400)
  except Exception as e:
   print('Visual request failed:',type(e).__name__,flush=True);return self.json_response({'error':'Visual comparison unavailable'},503)

if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('image');parser.add_argument('--size-m',type=float);parser.add_argument('--kind',default='satellite',choices=['satellite','aerial','all']);args=parser.parse_args()
 from pathlib import Path
 torch.set_num_threads(4)
 print(json.dumps(search({'image_base64':base64.b64encode(Path(args.image).read_bytes()).decode(),'size_m':args.size_m,'kind':args.kind}),ensure_ascii=False,indent=2))
