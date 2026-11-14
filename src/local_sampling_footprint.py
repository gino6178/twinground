"""Densified coordinate extent of the legacy local DEM sampler."""
import math
import numpy as np
from rasterio.warp import transform
from shapely.geometry import Polygon,box,mapping
from shapely.affinity import translate
from shapely.geometry.polygon import orient

def split_longitudes(points):
    # Unwrap before clipping; otherwise a short dateline edge spans the globe.
    xy=np.asarray(points,dtype=float)
    if xy.ndim!=2 or xy.shape[1]!=2 or not np.isfinite(xy).all():
        raise ValueError('Invalid footprint coordinates')
    xy[:,0]=np.degrees(np.unwrap(np.radians(xy[:,0])))
    polygon=Polygon(xy)
    if not polygon.is_valid or polygon.is_empty or polygon.area<=0:
        raise ValueError('Invalid footprint polygon')
    parts=[]
    for k in range(math.floor((polygon.bounds[0]+180)/360),math.floor((polygon.bounds[2]+180)/360)+1):
        cut=polygon.intersection(box(-180+360*k,-90,180+360*k,90))
        for part in ([cut] if cut.geom_type=='Polygon' else getattr(cut,'geoms',[])):
            if part.geom_type=='Polygon' and part.area>0:
                parts.append(orient(translate(part,xoff=-360*k),sign=1))
    if not parts:raise ValueError('No geographic footprint')
    if len(parts)==1:return mapping(parts[0])
    return {'type':'MultiPolygon','coordinates':[mapping(p)['coordinates'] for p in parts]}

def local_sampling_footprint(row,km,site,base_km=81.92):
    h,w=site['grid'].shape
    cy,cx=float(row['center_y']),float(row['center_x'])
    if not all(math.isfinite(v) for v in [km,base_km,cy,cx]) or km<=0 or base_km<=0 or not(0<=cx<=1 and 0<=cy<=1):
        raise ValueError('Invalid local sampling window')
    half=km/base_km*min(h,w)/2
    requested=[cx*(w-1)-half,cy*(h-1)-half,cx*(w-1)+half,cy*(h-1)+half]
    left,right=np.clip([requested[0],requested[2]],0,w-1)
    top,bottom=np.clip([requested[1],requested[3]],0,h-1)
    corners=[(left,top),(right,top),(right,bottom),(left,bottom),(left,top)]
    pixels=[]
    for a,b in zip(corners,corners[1:]):
        pixels.extend((a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t) for t in np.linspace(0,1,65)[:-1])
    pixels.append(pixels[0])
    # scipy map_coordinates indexes pixel centers, while raster affine origin
    # references the outer corner. Preserve that half-pixel distinction.
    projected=[site['transform']*(x+.5,y+.5) for x,y in pixels]
    lon,lat=transform(site['crs'],'EPSG:4326',[p[0] for p in projected],[p[1] for p in projected])
    return {'geometry':split_longitudes(list(zip(lon,lat))),'crs':'OGC:CRS84',
        'source_product':site['metadata']['file'],'source_crs':str(site['crs']),
        'source_grid_shape':[h,w],'source_affine':list(site['transform'])[:6],
        'requested_pixel_center_bounds':requested,
        'clipped_pixel_center_bounds':[float(left),float(top),float(right),float(bottom)],
        'edge_clamped':not np.allclose(requested,[left,top,right,bottom],atol=1e-10,rtol=0),
        'boundary_segments_per_edge':64,
        'method':'earth_patch sampling coordinates, including index clipping and pixel-center affine transform; 64 segments per edge, CRS transform, antimeridian split',
        'interpretation':'Densified approximate extent of sampled coordinates, not surveyed site boundaries or native valid-data coverage. Existing local DEM pipeline may fill missing values before sampling.'}
