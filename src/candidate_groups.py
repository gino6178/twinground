"""Deterministic shortlist grouping and reproducible index provenance."""
import hashlib
import math
import numpy as np
from functools import lru_cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def distance(a,b):
    lat1,lat2=map(math.radians,(a['latitude'],b['latitude']))
    dl=math.radians(b['longitude_east']-a['longitude_east'])
    h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dl/2)**2
    return 6371.0088*2*math.asin(math.sqrt(min(1,max(0,h))))

def group_ranked(rows, indices, ranked, scores, km):
    """Leader-radius groups, not connected components or verified physical sites."""
    groups=[]
    # Vectorized spherical distance to leaders; preserve first matching leader.
    leaders=np.empty((len(ranked),2),dtype=np.float64)
    threshold=math.sin(km*1.5/(2*6371.0088))**2
    for index in ranked:
        row=rows[int(indices[index])]
        member={'id':row['id'],'center':row['center'],'fusion_score':round(float(scores[index]),5)}
        n=len(groups)
        lat,lon=map(math.radians,(row['center']['latitude'],row['center']['longitude_east']))
        h=np.sin((leaders[:n,0]-lat)/2)**2+np.cos(lat)*np.cos(leaders[:n,0])*np.sin((leaders[:n,1]-lon)/2)**2
        # Scalar boundary confirmation preserves the original strict threshold.
        near=np.flatnonzero(h <= threshold+1e-14)
        found=next((int(i) for i in near if distance(groups[int(i)]['center'],row['center'])<km*1.5),None)
        group=groups[found] if found is not None else None
        if group is None:
            group={'id':row['id'],'center':row['center'],'representative_index':int(index),'members':[]}
            leaders[len(groups)]=[lat,lon]
            groups.append(group)
        group['members'].append(member)
    for g in groups:g['window_count']=len(g['members'])
    return groups

def sampling_footprint(row,km,local_site=None):
    if row.get('dataset') not in ('ETOPO_2022_15s','ETOPO_2022_60s'):
        if local_site is not None:
            from local_sampling_footprint import local_sampling_footprint
            return local_sampling_footprint(row,km,local_site)
        return {'geometry':None,'reason':'Sampling boundary not yet verified for this source'}
    lat,lon=row['center']['latitude'],row['center']['longitude_east']
    dy=km/111.32/2;dx=dy/max(math.cos(math.radians(lat)),.08)
    south,north=lat-dy,lat+dy
    if south < -90 or north>90:
        return {'geometry':None,'reason':'Polar footprint requires source-specific verification'}
    west,east=lon-dx,lon+dx
    def ring(w,e):return [[w,south],[e,south],[e,north],[w,north],[w,south]]
    if west < -180:geometry={'type':'MultiPolygon','coordinates':[[ring(west+360,180)],[ring(-180,east)]]}
    elif east > 180:geometry={'type':'MultiPolygon','coordinates':[[ring(west,180)],[ring(-180,east-360)]]}
    else:geometry={'type':'Polygon','coordinates':[ring(west,east)]}
    return {'geometry':geometry,'crs':'OGC:CRS84','source_product':row.get('tile') or row.get('dataset'),
            'method':'ETOPO sampling extent: half_lat=km/111.32/2; half_lon=half_lat/max(cos(lat),0.08)',
            'interpretation':'Extent of the source sampling coordinates, not a surveyed site boundary or geodesic square.'}

@lru_cache(maxsize=1)
def index_provenance():
    names=['data/moon/earth_window_index','data/earth_global/etopo_80km_index',
           'data/earth_global/etopo_80km_supplement','data/earth_global/etopo_15s_20_40km_index']
    files=[]
    for name in names:
        for ext in ('.json','.npz'):
            p=ROOT/(name+ext)
            if p.exists():
                h=hashlib.sha256()
                with p.open('rb') as f:
                    for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
                files.append({'path':name+ext,'sha256':h.hexdigest(),'bytes':p.stat().st_size})
    digest=hashlib.sha256(''.join(x['path']+':'+x['sha256']+'\n' for x in files).encode()).hexdigest()
    return {'version':'earth-index-content-v1','sha256':digest,'files':files,
            'refresh':'Bound to the running service; restart service after any index replacement.'}
