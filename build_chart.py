#!/usr/bin/env python3
"""
build_chart.py — Give the nautical chart the alpha channel it never had.

    python build_chart.py
    python build_chart.py --source "C:\\path\\to\\chart.tif" --out chart_cog.tif

The chart is a rotated rectangle inside an axis-aligned raster, so its four
corners are black wedges that should be transparent over the map. The file has
no alpha band, and neither does the original it was made from.

Colour keying cannot do this. Black is also the chart's own ink — soundings,
depth contours, labels — so any threshold that clears the corners punches
pinholes through 10,528 pixels of chart detail.

The two are separable by connectivity rather than colour: the surround touches
the image border, the ink does not. Flood-filling near-black inward from the
edge divides them exactly.
"""

import os, sys, argparse

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling
from scipy import ndimage

FOLDER      = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = r'C:\Data_002\sailing_gpx\lac_deschennes_chart_1550.tif'
DEFAULT_OUT = os.path.join(FOLDER, 'lac_deschennes_chart_1550_cog.tif')

# A pixel counts as background-dark if every channel is at or below this.
# Not just == 0: the source has overviews built by averaging, and any future
# resampling smears the boundary a little.
DARK_MAX = 8

# What the masked pixels become underneath the transparency. White, not black:
# overview levels are built by averaging, and averaging a transparent black
# pixel with its neighbours draws a dark fringe along the chart edge.
MASKED_FILL = 255

OVERVIEWS = [2, 4, 8, 16]


def build_alpha(rgb):
    """
    255 where the chart is, 0 over the surround.

    Returns (alpha, ink_pixels) where ink_pixels is the count of dark pixels
    kept — the ones a colour key would have destroyed.
    """
    dark = rgb.max(axis=0) <= DARK_MAX

    labels, count = ndimage.label(dark)

    # Any dark region touching the image edge is surround. Everything else is
    # enclosed by the chart and is ink.
    edge_labels = np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1],
    ]))
    edge_labels = edge_labels[edge_labels != 0]
    surround = np.isin(labels, edge_labels)

    ink = int((dark & ~surround).sum())
    alpha = np.where(surround, 0, 255).astype('uint8')
    return alpha, ink, count, surround


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default=DEFAULT_SRC)
    ap.add_argument('--out',    default=DEFAULT_OUT)
    args = ap.parse_args()

    if not os.path.exists(args.source):
        sys.exit(f'Source not found: {args.source}')

    print(f'Reading {args.source}')
    with rasterio.open(args.source) as src:
        if src.count < 3:
            sys.exit(f'Expected at least 3 bands, found {src.count}.')
        if src.count >= 4:
            print(f'  note: source already has {src.count} bands; using the first three')

        rgb     = src.read([1, 2, 3])
        profile = src.profile.copy()
        crs, transform = src.crs, src.transform

    print(f'  {rgb.shape[2]} x {rgb.shape[1]}, {crs}')

    alpha, ink, regions, surround = build_alpha(rgb)
    total = alpha.size
    print(f'\n  near-black regions found: {regions}')
    print(f'  surround (transparent):   {surround.sum()/total*100:5.1f}%')
    print(f'  chart ink kept:           {ink:,} px '
          f'-- a colour key would have erased these')

    if surround.sum() == 0:
        sys.exit('No surround found. Is this chart already masked, or not black-bordered?')
    if ink == 0:
        print('  warning: no enclosed dark pixels at all, which is unusual for a chart')

    # Flatten the masked area to white so overview averaging bleeds white
    # rather than drawing a dark halo along the diagonal edge.
    rgb = rgb.copy()
    for band in range(3):
        rgb[band][surround] = MASKED_FILL

    profile.update(
        count=4, dtype='uint8', crs=crs, transform=transform,
        driver='GTiff', compress='LZW', predictor=2,
        tiled=True, blockxsize=512, blockysize=512,
        photometric='RGB', interleave='pixel',
        BIGTIFF='IF_SAFER',
    )
    # nodata is meaningless once alpha carries the information, and leaving it
    # at 0 would tell a reader that black chart ink is missing data.
    profile.pop('nodata', None)

    print(f'\nWriting {args.out}')
    with rasterio.open(args.out, 'w', **profile) as dst:
        dst.write(rgb[0], 1)
        dst.write(rgb[1], 2)
        dst.write(rgb[2], 3)
        dst.write(alpha, 4)
        dst.colorinterp = [ColorInterp.red, ColorInterp.green,
                           ColorInterp.blue, ColorInterp.alpha]
        dst.build_overviews(OVERVIEWS, Resampling.average)

    kb = os.path.getsize(args.out) / 1024
    print(f'  {kb/1024:.1f} MB, 4 bands, overviews {OVERVIEWS}')
    print('\nDone - commit the .tif.')


if __name__ == '__main__':
    main()
