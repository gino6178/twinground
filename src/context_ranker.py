"""Evidence-constrained fusion ranker, v1. Fixed transparent weights, not trained labels."""
import json
from pathlib import Path
from functools import lru_cache
import numpy as np
from shapely.geometry import shape
from shapely import make_valid
from lunar_pipeline import glim_grid, GLIM_CLASSES
from dune_context import dune_sample_shares,dune_grid,PAPER
ROOT=Path(__file__).resolve().parents[1]
VERSION='terrain-context-fusion-v2-dune-presence'
@lru_cache(maxsize=1)
def desert_grid():
    from rasterio.features import rasterize
    from rasterio.transform import from_origin
    data=json.loads((ROOT/'data/earth_context/desert_ecoregions.geojson').read_text())
    geometries=[(make_valid(shape(f['geometry'])),1) for f in data['features']]
    return rasterize(geometries,out_shape=(3600,7200),transform=from_origin(-180,90,.05,.05),fill=0,dtype='uint8')
@lru_cache(maxsize=8)
def context_arrays(centers, km):
    centers=np.asarray(centers,dtype=float)
    lat,lon=centers[:,0],centers[:,1]
    desert=np.zeros(len(lat),dtype=np.float32)
    lith=np.zeros((len(lat),17),dtype=np.float32)
    grid=glim_grid()
    # Equal-spaced cartographic probes; fractions are sample shares, not area estimates.
    for north in np.linspace(-1,1,3):
        for east in np.linspace(-1,1,3):
            y=np.clip(lat+north*km/222.64,-89.999,89.999)
            x=(lon+east*km/(222.64*np.maximum(np.cos(np.radians(lat)),.08))+180)%360-180
            desert+=desert_grid()[np.clip(np.floor((90-y)/.05).astype(int),0,3599),np.clip(np.floor((x+180)/.05).astype(int),0,7199)].astype(np.float32)/9
            vals=grid[np.floor((90-y)*2).astype(int),np.floor((x+180)*2).astype(int)]
            for code in range(1,17): lith[:,code]+=(vals==code)/9
    return desert,lith

def resolve_target(surface,rock,moon_geology=None):
    if surface not in ('any','desert','mapped_dunes'): raise ValueError('Unknown surface target')
    codes={v[0]:k for k,v in GLIM_CLASSES.items() if v[0] not in ('wb','nd','ig')}
    source='user-selected analog target'
    if rock=='auto':
        unit=(moon_geology or {}).get('dominant_unit',{})
        if unit.get('description')=='Mare Unit' and unit.get('sample_fraction',0)>=.6:
            rock='vb';source='USGS dominant Mare Unit -> basaltic volcanic analog prior; not exposed-rock identification'
        else: rock='any';source='No supported automatic rock target; no rock constraint applied'
    if rock!='any' and rock not in codes: raise ValueError('Unknown rock target')
    return {'surface':surface,'rock':rock,'rock_index':codes.get(rock),'rock_label':GLIM_CLASSES[codes[rock]][1] if rock in codes else '不限岩性','target_source':source}

def fuse(cosines,desert,lith,target,dunes=None):
    evidence=[]
    if target['surface']=='desert': evidence.append(desert)
    if target['surface']=='mapped_dunes':
        if dunes is None: raise ValueError('Dune-presence source unavailable')
        evidence.append(dunes)
    if target['rock_index'] is not None: evidence.append(lith[:,target['rock_index']])
    geometry=np.clip((np.asarray(cosines)+1)/2,0,1)
    if not evidence: return geometry,np.ones(len(geometry),dtype=bool),np.ones(len(geometry))
    support=np.mean(evidence,axis=0)
    eligible=np.logical_and.reduce([e>=.6 for e in evidence])
    return .65*geometry+.35*support,eligible,support

def rank_context(rows,indices,scores,km,target):
    if target['surface']=='any' and target['rock_index'] is None:
        d=np.zeros(len(indices)); l=np.zeros((len(indices),17))
    else:
        centers=tuple((float(rows[int(i)]['center']['latitude']),float(rows[int(i)]['center']['longitude_east'])) for i in indices)
        d,l=context_arrays(centers,km)
    dunes=None
    if target['surface']=='mapped_dunes':
        try: dunes=dune_sample_shares(centers,km)
        except (OSError,ValueError,KeyError,StopIteration) as e: raise ValueError('沙丘分布來源暫時無法讀取，請稍後重試或改用其他條件。') from e
    fused,eligible,support=fuse(scores,d,l,target,dunes)
    candidates=np.flatnonzero(eligible)
    if len(candidates)==0: raise ValueError('本尺度的索引沒有符合地表與岩性條件的候選；請放寬類比目標。')
    ranked=candidates[np.argsort(-fused[candidates],kind='stable')][:512]
    meta={'version':VERSION,'target':target,'eligible_windows':int(eligible.sum()),'indexed_windows':len(indices),'weights':{'geometry':.65 if target['surface']!='any' or target['rock_index'] is not None else 1.,'context':.35 if target['surface']!='any' or target['rock_index'] is not None else 0.},'context_applied':target['surface']!='any' or target['rock_index'] is not None,'minimum_each_evidence_share':.6,'desert_lookup_resolution_degrees':.05,'note':'Experimental fixed-weight evidence fusion; not trained material identification or validated analog probability. 3x3 regional samples; desert biome includes xeric shrublands, not sand classification.','desert_source':'https://ecoregions.appspot.com/','rock_source':'https://doi.org/10.1594/PANGAEA.788537'}
    if dunes is not None:
        meta['dune_presence_source']={'url':PAPER,'source_sha256':dune_grid()[3],'resolution_degrees':.1,'interpretation':'Shares of 3x3 probes in cells with published dune presence; not dune area fraction. Unrecorded cells are not verified absence.'}
    return ranked,meta,{'dunes':dunes,'fused':fused,'desert':d,'support':support,'rock':l[:,target['rock_index']] if target['rock_index'] is not None else np.zeros(len(indices))}
