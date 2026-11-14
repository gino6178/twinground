"""Track interpolation support from the stored DEM before nearest-value fill."""
import numpy as np
from lunar_pipeline import earth_patch,PATCH_KM

def local_sampling_support(site,row,km):
    mask=site['stored_valid_mask']
    if mask.shape!=site['grid'].shape or mask.dtype!=np.bool_:
        raise ValueError('Invalid stored-source validity mask')
    result={}
    h,w=mask.shape
    half=km/PATCH_KM*min(h,w)/2
    x0=row['center_x']*(w-1)-half;x1=row['center_x']*(w-1)+half
    y0=row['center_y']*(h-1)-half;y1=row['center_y']*(h-1)+half
    clamped=bool(x0<0 or y0<0 or x1>w-1 or y1>h-1)
    left,right=np.clip([int(np.floor(x0)),int(np.ceil(x1))],0,w-1)
    top,bottom=np.clip([int(np.floor(y0)),int(np.ceil(y1))],0,h-1)
    contributing=mask[top:bottom+1,left:right+1]
    invalid=int(np.count_nonzero(~contributing))
    for label,size in [('model',32),('display',64)]:
        support=earth_patch(mask.astype('float32'),size=size,scale=km/PATCH_KM,
                            center_y=row['center_y'],center_x=row['center_x'])
        affected=int(np.count_nonzero(support<1-1e-6))
        result[label]={'grid_shape':[size,size],'samples':size*size,
                       'samples_touching_filled_source':affected,
                       'fraction_touching_filled_source':affected/(size*size),
                       'mean_valid_interpolation_weight':float(support.mean())}
    return {'version':'stored-dem-interpolation-support-v1',
            'source_product':site['metadata']['file'],
            'stored_source_valid_fraction':float(mask.mean()),
            'stored_window_pixel_rectangle':{'pixels':int(contributing.size),'invalid_pixels':invalid,'edge_clamped':clamped},
            'eligible_for_search':invalid==0 and not clamped,
            'exclusion_reasons':(['source_window_requires_edge_clamping'] if clamped else [])+(['stored_source_contains_missing_pixels'] if invalid else []),
            'eligibility_policy':'Strict stored local DEM gate: all pixels in the interpolation-support rectangle valid, and no edge clamping. Not original sensor validity.',
            'grids':result,'support_tolerance':1e-6,
            'meaning':'Bilinear weight of valid pixels in the stored source before nearest-value fill; not geographic area coverage or original sensor coverage.',
            'limit':'Stored DEM may already be resampled or modified upstream. This does not recover original SRTM validity or validate filled elevations.'}
