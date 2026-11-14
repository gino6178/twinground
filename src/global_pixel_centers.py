"""Pixel-center bilinear sampling of a geographic, periodic global raster.

Longitude wraps over width samples (first/last pixels are distinct); latitude
is clamped to the polar row. No overlapping-endpoint SciPy wrap convention.
"""
import math
import numpy as np
from rasterio.windows import Window

VERSION = 'etopo60-pixel-centers-periodic-v1'


def axes(transform, height, width, lat, lon, km, size):
    if transform.b or transform.d or transform.a <= 0 or transform.e >= 0:
        raise ValueError('Expected north-up geographic raster')
    if not np.isclose(width*transform.a,360) or not np.isclose(-height*transform.e,180):
        raise ValueError('Expected full-globe raster')
    half = km / 111.32 / 2
    latitudes = lat + np.linspace(half,-half,size)
    longitudes = lon + np.linspace(-half,half,size)/max(math.cos(math.radians(lat)),.08)
    ys = (latitudes-transform.f)/transform.e-.5
    xs = (longitudes-transform.c)/transform.a-.5
    return np.clip(ys,0,height-1),np.mod(xs,width)


def indices(ys,xs,height,width):
    y0=np.floor(ys).astype(int); x0=np.floor(xs).astype(int)
    y1=np.minimum(y0+1,height-1); x1=(x0+1)%width
    fy=(ys-y0)[:,None]; fx=(xs-x0)[None,:]
    return y0,y1,x0,x1,fy,fx


def mix(a,b,c,d,fy,fx):
    # Cast before subtraction/multiplication to avoid integer overflow and
    # integer-output interpolation rounding in the source raster dtype.
    return ((1-fy)*((1-fx)*a.astype(float)+fx*b.astype(float))+
            fy*((1-fx)*c.astype(float)+fx*d.astype(float))).astype(np.float32)


def sample_full(grid, transform, lat, lon, km=80, size=32):
    h,w=grid.shape
    ys,xs=axes(transform,h,w,lat,lon,km,size)
    y0,y1,x0,x1,fy,fx=indices(ys,xs,h,w)
    return mix(grid[np.ix_(y0,x0)],grid[np.ix_(y0,x1)],
               grid[np.ix_(y1,x0)],grid[np.ix_(y1,x1)],fy,fx)


def sample_windowed(source,lat,lon,km=80,size=32):
    h,w=source.height,source.width
    ys,xs=axes(source.transform,h,w,lat,lon,km,size)
    y0,y1,x0,x1,fy,fx=indices(ys,xs,h,w)
    columns=np.unique(np.concatenate((x0,x1)))
    row0,row1=int(y0.min()),int(y1.max())+1
    pixels=np.empty((row1-row0,len(columns)),dtype=np.float32)
    # Two narrow strips suffice at the date line; never read the whole globe.
    for side in (columns<w/2,columns>=w/2):
        if not side.any(): continue
        requested=columns[side]
        left,right=int(requested.min()),int(requested.max())+1
        block=source.read(1,window=Window(left,row0,right-left,row1-row0))
        pixels[:,side]=block[:,requested-left]
    a,b=np.searchsorted(columns,x0),np.searchsorted(columns,x1)
    return mix(pixels[np.ix_(y0-row0,a)],pixels[np.ix_(y0-row0,b)],
               pixels[np.ix_(y1-row0,a)],pixels[np.ix_(y1-row0,b)],fy,fx)
