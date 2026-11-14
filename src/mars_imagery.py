"""Local, source-hashed CTX imagery with explicit projected coverage masks."""
from pathlib import Path
from functools import lru_cache
import hashlib
import io
import json
import math
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling, transform
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
RADIUS=3396190
PIXELS=512

def source_observations(pair_id):
    """Read hash-checked ODE observations for both source images, not mosaic dates."""
    base=ROOT/'data/research/redesign_v1/ctx_dates_v1'
    audit_path=base/'audit.json'
    if not audit_path.exists():
        return []
    audit=json.loads(audit_path.read_text())
    observations=[]
    for product_id in pair_id.split('__'):
        matches=[p for p in audit['products'] if p['id']==product_id]
        if len(matches)!=1:
            return []
        row=matches[0]
        payload=(base/(product_id+'.json')).read_bytes()
        if hashlib.sha256(payload).hexdigest()!=row['sha256']:
            raise ValueError('CTX date metadata hash mismatch: '+product_id)
        product=json.loads(payload)['ODEResults']['Products']['Product']
        if isinstance(product,list):
            product=next(p for p in product if p.get('pdsid')==product_id)
        if (product['pdsid']!=product_id or product['UTC_start_time']!=row['start_time']
                or product['UTC_stop_time']!=row['stop_time']):
            raise ValueError('CTX date metadata mismatch: '+product_id)
        observations.append({'product_id':product_id,'start_utc':row['start_time']+'Z',
                             'stop_utc':row['stop_time']+'Z','metadata_url':row['url'],
                             'metadata_sha256':row['sha256']})
    return observations

@lru_cache(maxsize=1)
def sources():
    specs=[]
    for folder in ['mars_ctx_stereo','mars_ctx_olympus_verified']:
        base=ROOT/'data/demo'/folder
        path=base/'orthoimage.tif'
        if not path.exists():
            continue
        if folder=='mars_ctx_stereo':
            m=json.loads((base/'metadata.json').read_text())
            row={'id':m['item_id'],'sha256':m['orthoimage_sha256'],
                 'url':m['asset_urls']['orthoimage'],'license':m['license']}
        else:
            m=json.loads((base/'orthoimage_manifest.json').read_text())
            stac=json.loads((base/'stac_item.json').read_text())
            row={'id':m['stac_item_id'],'sha256':m['source_image_sha256'],
                 'url':m['download_url'],'license':stac['properties']['license']}
        hasher=hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):
                hasher.update(block)
        digest=hasher.hexdigest()
        if digest!=row['sha256']:
            raise ValueError('CTX source hash mismatch: '+folder)
        with rasterio.open(path) as src:
            b=src.bounds
            xs,ys=transform(src.crs,src.crs.geodetic_crs if hasattr(src.crs,'geodetic_crs') else rasterio.crs.CRS.from_string('+proj=longlat +R=3396190 +no_defs'),[(b.left+b.right)/2],[(b.top+b.bottom)/2])
            row.update(path=str(path),center=[ys[0],xs[0]],
                       radius_m=math.hypot(b.right-b.left,b.top-b.bottom)/2,
                       source_grid_m=list(src.res),source_crs=src.crs.to_wkt(),
                       acquisition_date=None)
        row['source_observations']=source_observations(row['id'])
        row['date_provenance']='PDS Geosciences ODE EDR metadata; source-image observations, not orthomosaic per-pixel dates. Original embedded labels not independently checked.'
        specs.append(row)
    return tuple(specs)

def distance_m(a,b):
    lat1,lon1=map(math.radians,a);lat2,lon2=map(math.radians,b)
    v=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 2*RADIUS*math.asin(min(1,math.sqrt(v)))

def project_image(path,lat,lon,size_km,pixels=PIXELS):
    """North-up local azimuthal-equidistant window; no filling of nodata."""
    if not all(math.isfinite(v) for v in [lat,lon,size_km]) or abs(lat)>89.5 or size_km<=0:
        raise ValueError('Invalid image window')
    half=size_km*500
    grid=from_bounds(-half,-half,half,half,pixels,pixels)
    crs=rasterio.crs.CRS.from_string(f'+proj=aeqd +lat_0={lat} +lon_0={lon} +R={RADIUS} +units=m +no_defs')
    target=np.full((pixels,pixels),np.nan,dtype=np.float32)
    with rasterio.open(path) as src:
        reproject(source=rasterio.band(src,1),destination=target,
                  src_nodata=src.nodata,dst_nodata=np.nan,dst_transform=grid,
                  dst_crs=crs,resampling=Resampling.bilinear,num_threads=1)
    valid=np.isfinite(target)
    rgba=np.zeros((pixels,pixels,4),dtype=np.uint8)
    stretch=None
    if valid.any():
        lo,hi=np.percentile(target[valid],[2,98]);hi=max(float(hi),float(lo)+1e-6)
        gray=np.clip((np.where(valid,target,lo)-lo)/(hi-lo)*255,0,255).astype(np.uint8)
        rgba[:,:,:3]=gray[:,:,None];rgba[:,:,3]=valid*255
        stretch=[float(lo),hi]
    return rgba,{'valid_fraction':float(valid.mean()),'valid_pixels':int(valid.sum()),
                 'pixels':pixels,'display_spacing_m':size_km*1000/pixels,
                 'projection':crs.to_wkt(),'bounds_m':[-half,-half,half,half],
                 'display_percentile_stretch':[2,98],'display_value_range':stretch}

@lru_cache(maxsize=16)
def mars_window(lat,lon,size_km):
    if not all(math.isfinite(v) for v in [lat,lon,size_km]) or abs(lat)>89.5 or size_km not in (20,40,80):
        raise ValueError('Invalid Mars imagery window')
    best=None
    for row in sources():
        if distance_m((lat,lon),row['center'])>row['radius_m']+size_km*1000/math.sqrt(2)+5000:
            continue
        rgba,meta=project_image(row['path'],lat,lon,size_km)
        if meta['valid_pixels'] and (best is None or meta['valid_fraction']>best[2]['valid_fraction']):
            best=(row,rgba,meta)
    result={'body':'mars','lat':lat,'lon':lon,'size_km':size_km,'available':best is not None,
            'used_in_ranking':False,'coverage_meaning':'Fraction of finite projected display pixels; not geographic source completeness or material confidence.',
            'registration':'Source CRS reprojection only; physical image/DEM residuals not independently validated.'}
    if best is None:
        result.update(valid_fraction=0,reason='No local CTX pixels cover this query window.')
        return result,None
    row,rgba,meta=best
    result.update(meta,source={k:v for k,v in row.items() if k not in ['path','center','radius_m']},
                  attribution='NASA/JPL-Caltech/MSSS · USGS CTX orthorectified imagery',
                  partial=meta['valid_fraction']<1)
    buffer=io.BytesIO();Image.fromarray(rgba).save(buffer,format='PNG')
    payload=buffer.getvalue();result['render_sha256']=hashlib.sha256(payload).hexdigest()
    return result,payload
