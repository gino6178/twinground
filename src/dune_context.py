"""Published 0.1-degree dune-presence context; zero means not recorded, not verified absence."""
from pathlib import Path
from functools import lru_cache
import hashlib,json
import numpy as np
import rasterio
ROOT=Path(__file__).resolve().parents[1]
DIRECTORY=ROOT/'data/research/redesign_v1/earth_dunes'
PAPER='https://doi.org/10.1038/s41467-026-75466-y'
@lru_cache(maxsize=1)
def dune_grid():
    path=DIRECTORY/'dune-mask-rev1.tif'
    manifest=json.loads((DIRECTORY/'source_manifest.json').read_text())
    expected=next(f['sha256'] for f in manifest['files'] if f['name']==path.name)
    actual=hashlib.sha256(path.read_bytes()).hexdigest()
    if actual!=expected:raise ValueError('Dune source checksum mismatch')
    with rasterio.open(path) as ds:
        if ds.crs.to_epsg()!=4326 or not np.isclose(ds.transform.a,.1) or not np.isclose(ds.transform.e,-.1):raise ValueError('Unexpected dune grid geometry')
        array=ds.read(1)
        transform=ds.transform
        nodata=ds.nodata
    finite=np.isfinite(array)
    if nodata is not None:finite &= array!=nodata
    if not np.isin(array[finite],[0,1]).all():raise ValueError('Unknown dune-map class')
    return array,transform,finite,actual
def lookup_grid(array,transform,valid,lat,lon):
    lat,lon=np.broadcast_arrays(np.asarray(lat,dtype=float),np.asarray(lon,dtype=float))
    # Periodic longitude relative to the grid's left boundary preserves seam cells.
    width=array.shape[1]*transform.a
    x=(lon-transform.c)%width+transform.c
    safe_lat=np.where(np.isfinite(lat),lat,0)
    safe_x=np.where(np.isfinite(x),x,transform.c)
    row=np.floor((safe_lat-transform.f)/transform.e).astype(np.int64)
    col=np.floor((safe_x-transform.c)/transform.a).astype(np.int64)
    inside=np.isfinite(lat)&np.isfinite(lon)&(lat>=-90)&(lat<=90)&(row>=0)&(row<array.shape[0])&(col>=0)&(col<array.shape[1])
    rr=np.clip(row,0,array.shape[0]-1);cc=np.clip(col,0,array.shape[1]-1)
    return inside&valid[rr,cc]&(array[rr,cc]==1),inside&valid[rr,cc],rr,cc
def sample_points(centers,km):
    a=np.asarray(centers,dtype=float)
    if a.ndim!=2 or a.shape[1]!=2 or not np.isfinite(a).all() or not np.isfinite(km) or km<=0:raise ValueError('Invalid dune sampling window')
    y,x=a[:,0],a[:,1]
    for north in np.linspace(-1,1,3):
        for east in np.linspace(-1,1,3):
            yield np.clip(y+north*km/222.64,-89.999,89.999),(x+east*km/(222.64*np.maximum(np.cos(np.radians(y)),.08))+180)%360-180
@lru_cache(maxsize=8)
def dune_sample_shares(centers,km):
    array,transform,valid,_=dune_grid()
    shares=np.zeros(len(centers),np.float32)
    for y,x in sample_points(centers,km):
        positive,_,_,_=lookup_grid(array,transform,valid,y,x)
        shares+=positive.astype(np.float32)/9
    return shares
def dune_window_evidence(lat,lon,km):
    try:array,transform,valid,sha=dune_grid()
    except (OSError,ValueError,KeyError,StopIteration) as e:
        return {'available':False,'reason':'Published dune-presence source unavailable','source_url':PAPER}
    samples=[]
    for y,x in sample_points(((lat,lon),),km):
        positive,known,rr,cc=lookup_grid(array,transform,valid,y,x)
        r,c=int(rr[0]),int(cc[0])
        cx,cy=transform*(c+.5,r+.5)
        samples.append({'latitude':float(y[0]),'longitude_east':float(x[0]),'cell_row':r,'cell_column':c,'cell_center':[float((cx+180)%360-180),float(cy)],'dunes_recorded':bool(positive[0]),'raster_value_valid':bool(known[0])})
    share=sum(s['dunes_recorded'] for s in samples)/len(samples)
    return {'available':True,'source_url':PAPER,'repository_url':'https://github.com/geomorphlab/dune-world','source_sha256':sha,'resolution_degrees':.1,'sample_count':len(samples),'positive_sample_share':share,'samples':samples,'status':'mapped_presence' if share>0 else 'not_recorded','interpretation':'3x3 query-window probes intersect published cells containing some dunes. Not sand area fraction, dune morphology or a pixel label. Unrecorded cells are not verified absence. Some coastal and other regions were not mapped.'}
