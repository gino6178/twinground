"""Describe the actual DEM sampling path; never equate grid size with accuracy."""
import math
import numpy as np

def sampling_evidence(body,patch_km,grid,display_grid,source_spacing_ns_m,source_id,source_kind):
    if body not in ('moon','mars') or patch_km not in (20,40,80):
        raise ValueError('Unsupported terrain sampling request')
    spacing=float(source_spacing_ns_m)
    if not math.isfinite(spacing) or spacing<=0:
        raise ValueError('Missing valid source grid spacing')
    for value in (grid,display_grid):
        if value.ndim!=2 or min(value.shape)<2 or value.shape[0]!=value.shape[1] or not np.isfinite(value).all():
            raise ValueError('Terrain grid must contain finite elevations throughout')
    edge=patch_km*1000
    model_spacing=edge/(grid.shape[0]-1)
    display_spacing=edge/(display_grid.shape[0]-1)
    return {'version':'terrain-sampling-v1','body':body,'source_id':source_id,
        'source_grid_kind':source_kind,'source_grid_north_south_spacing_m':spacing,
        'source_intervals_across_window_approx':edge/spacing,
        'model_grid_shape':list(grid.shape),'model_grid_spacing_m':model_spacing,
        'display_grid_shape':list(display_grid.shape),'display_grid_spacing_m':display_spacing,
        'model_upsamples_source':model_spacing<spacing,
        'display_upsamples_source':display_spacing<spacing,
        'finite_model_samples':int(grid.size),'finite_display_samples':int(display_grid.size),
        'native_valid_coverage_fraction':None,
        'fine_surface_recognition_available':False,
        'limits':['Source grid spacing is not effective resolving power or positional accuracy.',
                  'North-south global grid spacing is approximate; east-west spacing varies with latitude.',
                  'Finite sampled elevations do not establish native-pixel coverage or absence of upstream interpolation.',
                  'No calibrated pixel-level dune, bare-rock or rock-layer classifier is deployed.']}
