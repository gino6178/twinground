"""Constant-time lookup of the sealed research orbital mineral surrogate grid."""
from __future__ import annotations
import hashlib,json,math
from functools import lru_cache
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
DIR=ROOT/'data/research/kaguya_global_4ppd'
REPORT=DIR/'router_v2_first_spatial_evaluation.json'
ENVELOPE_REPORT=DIR/'router_v2_spatial_envelope_first_evaluation.json'
GRID=DIR/'router_v2_prediction_grid_05deg.npz'
WEIGHTS=DIR/'tiny_global_mineral_router_v2.pt'
REPORT_SHA='52511cf3e73db3bdd715508c249280630e8d864839f75a70d736877bafd4a581'
ENVELOPE_REPORT_SHA='105f872f88b9601e444507fb622e7d17e099a67ce45317f2a8fb41abc122f564'
GRID_SHA='408420901b0895a65b9179aeea70beab5cb87f0065203c1dba34cf7a104524d3'
WEIGHTS_SHA='53a98fb322722583f5540c60b77484455c4d971c208e654c6189de8763773bab'
SOURCE='https://astrogeology.usgs.gov/search/map/lunar-kaguya-multiband-imager-mosaics'
MINERALS=('Clinopyroxene','Orthopyroxene','Olivine','Plagioclase')

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

@lru_cache(maxsize=1)
def resource():
 if (sha(REPORT),sha(GRID),sha(WEIGHTS),sha(ENVELOPE_REPORT))!=(REPORT_SHA,GRID_SHA,WEIGHTS_SHA,ENVELOPE_REPORT_SHA):
  raise RuntimeError('Published research material grid or first spatial evaluation changed')
 report=json.loads(REPORT.read_text(encoding='utf-8'))
 envelope=json.loads(ENVELOPE_REPORT.read_text(encoding='utf-8'))
 if not report['research_display_gate']['passed'] or report['prediction_grid_sha256']!=GRID_SHA or report['model_sha256']!=WEIGHTS_SHA:
  raise RuntimeError('Research material display gate not met')
 if not envelope['gate']['passed'] or envelope['source_sha256']['prediction_grid']!=GRID_SHA or envelope['source_sha256']['model_report']!=REPORT_SHA:
  raise RuntimeError('Research material spatial envelope display gate not met')
 with np.load(GRID,allow_pickle=False) as grid:
  prediction=grid['prediction_fraction'].copy();expert=grid['expert_id'].copy();valid=grid['input_valid'].copy()
 if prediction.shape!=(200,720,4) or expert.shape!=(200,720) or valid.shape!=(200,720):
  raise RuntimeError('Unexpected regional material grid dimensions')
 return prediction,expert,valid,report,envelope

def mineral_model_observation(lat:float,lon:float,size_km:int)->dict:
 if not math.isfinite(lat) or not math.isfinite(lon):raise ValueError('Nonfinite lunar coordinate')
 if size_km not in (20,40,80):raise ValueError('Window size must be 20, 40 or 80 km')
 if not -50<=lat<50:
  return {'available':False,'reason':'研究材質模型只覆蓋南北緯 50°內','source_url':SOURCE}
 prediction,expert,valid,report,envelope=resource()
 east=lon%360
 row=min(199,max(0,int(math.floor((50-lat)/.5))))
 col=min(719,max(0,int(math.floor(east/.5))))
 if not valid[row,col] or not np.isfinite(prediction[row,col]).all():
  return {'available':False,'reason':'所選位置的獨立輸入圖層缺值','source_url':SOURCE}
 values=prediction[row,col].astype(np.float64)
 if np.any(values<0) or abs(values.sum()-1)>.002:raise RuntimeError('Mineral fraction vector invalid')
 route='full_diviner_lp_wac' if expert[row,col]==1 else 'lp_wac_fallback'
 bands=[]
 for index,name in enumerate(MINERALS):
  result=envelope['routes'][route]['minerals'][name]
  radius=result['calibration_absolute_residual_q90_percentage_points']
  center=float(values[index]*100)
  bands.append({'mineral':name,'lower':round(max(0,center-radius),2),
                'upper':round(min(100,center+radius),2),
                'test_cell_coverage':result['test_cell_coverage'],
                'test_block_macro_coverage':result['test_block_macro_coverage'],
                'test_sector_cell_coverage':result['test_sector_cell_coverage']})
 cell_lat=49.75-row*.5;cell_lon=.25+col*.5
 delta_lon=((cell_lon-east+180)%360)-180
 offset=math.hypot((cell_lat-lat)*30.32,delta_lon*30.32*math.cos(math.radians(lat)))
 return {'available':True,'kind':'research_prediction_of_published_map','model':'tiny-global-mineral-router-v2',
  'parameters':report['parameter_count'],'mineral_order':list(MINERALS),
  'estimated_weight_percent':[round(float(value*100),2) for value in values],
  'expert':route,
  'weak_label_error_envelope':{'basis':'calibration 90th percentile absolute residual by route and 10 degree spatial block',
    'bands':bands,'evaluation_report_sha256':ENVELOPE_REPORT_SHA,
    'limitation':'Empirical range around nearest 0.5 degree prediction relative to Kaguya weak label. Not a formal 90% confidence interval, ground truth mineral assay, or selected-window composition.'},
  'grid_resolution_degrees':.5,'source_cell_center':{'latitude':round(cell_lat,3),'longitude_east':round(cell_lon,3)},
  'source_cell_center_offset_km':round(offset,2),'selected_window_km':size_km,
  'spatial_meaning':'Nearest regional 0.5 degree cell; not a resolved mineral map or an average over the selected window',
  'evaluation':{'test_geographic_blocks':report['test_metrics']['routed_tiny']['geographic_blocks'],
   'test_block_macro_mae_percentage_points':report['test_metrics']['routed_tiny']['block_macro_mae_percentage_points'],
   'matched_ridge_block_macro_mae_percentage_points':report['test_metrics']['routed_ridge']['block_macro_mae_percentage_points'],
   'test_input_coverage_fraction':report['coverage']['base_input_fraction']},
  'source_url':SOURCE,
  'disclaimer':'Experimental approximation of published Kaguya MI inversion fractions from Diviner, Lunar Prospector and LROC WAC; not independent mineral ground truth or Earth material similarity.'}
