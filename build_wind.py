#!/usr/bin/env python3
"""
build_wind.py — Fetch historical wind for the hours the tracks actually cover.

    python build_wind.py            # fetch anything missing
    python build_wind.py --force    # refetch everything

Reads tracks.json, groups tracks into sailing areas, and pulls hourly wind from
the Open-Meteo archive (ERA5 reanalysis) for those areas and times only. Writes
data/wind.json, which is tens of kilobytes rather than the megabytes a full
five-year download would be.

Fetching at build time rather than in the browser means the site has no runtime
dependency on a weather service, the data rides the existing IndexedDB cache,
and nobody hits a rate limit. Historical wind never changes, so there is nothing
to refresh.

A caveat worth repeating in the UI: ERA5 is a reanalysis on a roughly 25 km
grid. It gives the synoptic picture, not what you felt — it cannot see lake
thermals or shoreline effects. For observed wind, Environment Canada publishes
free hourly station data (Ottawa Airport is about 12 km from Lac Deschenes).
"""

import os, sys, json, math, time, array, hashlib, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

FOLDER    = os.path.dirname(os.path.abspath(__file__))
DATA_DIR  = os.path.join(FOLDER, 'data')
MANIFEST  = os.path.join(FOLDER, 'tracks.json')
OUT_PATH  = os.path.join(DATA_DIR, 'wind.json')

ARCHIVE_API  = 'https://archive-api.open-meteo.com/v1/archive'
FORECAST_API = 'https://historical-forecast-api.open-meteo.com/v1/forecast'

# Models in preference order, best resolution first.
#
# Rather than hardcode each model's domain and archive start — easy to get wrong
# and silently wrong — the fetcher tries them in order and takes the first that
# returns data. A model that errors for an area is not retried for that area; a
# model that simply has no data for a date range falls through for that range
# only, which is what HRDPS needs (it starts around May 2023).
MODELS = [
    ('gem_hrdps_continental', 'HRDPS 2.5 km',  FORECAST_API),
    ('gfs_hrrr',              'HRRR 3 km',     FORECAST_API),
    ('icon_d2',               'ICON-D2 2 km',  FORECAST_API),
    ('era5',                  'ERA5 25 km',    ARCHIVE_API),
]
MODEL_NAMES = [name for _, name, _ in MODELS]

# Bumped when the stored shape changes, so an old file is rebuilt rather than
# merged with rows in a format that no longer matches.
FORMAT = 2

# Tracks whose centres round to the same half-degree cell are one sailing area.
# Coarse on purpose even at 2.5 km: the areas are tens of kilometres across, and
# splitting them finer would not change which grid cells get fetched.
AREA_PRECISION = 2          # multiples of 1/2 degree
PAD_HOURS      = 1          # keep an hour either side so interpolation has ends
REQUEST_PAUSE  = 0.4        # be polite to a free API
HOUR_MS        = 3600000

# Wind is only fetched for tracks from this date on. Older tracks keep their
# GPS data and stats; they simply have no wind, and every wind feature already
# degrades to nothing when the hour is not covered.
WIND_FROM = datetime(2025, 1, 1)

# ── Grid, for the particle field ──────────────────────────────────
#
# Only areas served by a North American model get a grid — that is what
# "Canadian tracks only" means in practice, and it falls out of the ladder
# rather than needing a hardcoded bounding box.
GRID_MODELS     = {'gem_hrdps_continental', 'gfs_hrrr'}
GRID_TARGET_KM  = 2.5       # the finest model's native spacing
GRID_MARGIN_KM  = 8.0       # field beyond the tracks, so particles have room
GRID_MAX_POINTS = 180       # cap per area; one request stays comfortable
QUANT_KN        = 0.25      # int8 step, so +/- 31.75 kn
GRID_PATH       = os.path.join(DATA_DIR, 'wind-grid.bin')


def to_uv(speed_kn, dir_from_deg):
    """
    Meteorological direction (where wind comes FROM) to eastward/northward
    components. From the north means blowing toward the south, so both
    components carry a leading minus.
    """
    r = math.radians(dir_from_deg)
    return -speed_kn * math.sin(r), -speed_kn * math.cos(r)


def quantise(value):
    return max(-127, min(127, int(round(value / QUANT_KN))))


# ── Areas ─────────────────────────────────────────────────────────

def track_centre(t):
    b = t['bbox']
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def group_areas(tracks):
    """[{id, lat, lon, tracks:[...]}] — ordered deterministically so ids are stable."""
    cells = {}
    for t in tracks:
        lat, lon = track_centre(t)
        key = (round(lat * AREA_PRECISION), round(lon * AREA_PRECISION))
        cells.setdefault(key, []).append(t)

    areas = []
    for i, key in enumerate(sorted(cells)):
        members = cells[key]
        lat = sum(track_centre(t)[0] for t in members) / len(members)
        lon = sum(track_centre(t)[1] for t in members) / len(members)
        areas.append({
            'id': i,
            'lat': round(lat, 4),
            'lon': round(lon, 4),
            'tracks': members,
        })
    return areas


def wanted_hours(area):
    """Epoch-hour indices this area's tracks span, padded at both ends."""
    cutoff = WIND_FROM.timestamp() * 1000
    hours = set()
    for t in area['tracks']:
        if t['startMs'] < cutoff:
            continue
        first = t['startMs'] // HOUR_MS - PAD_HOURS
        last  = t['endMs']   // HOUR_MS + PAD_HOURS
        hours.update(range(first, last + 1))
    return hours


def grid_for(area):
    """
    A regular lat/lon grid covering the area's recent tracks plus a margin.
    The margin matters for the particle field: without it the flow stops at the
    edge of where the boat happened to sail.
    """
    cutoff = WIND_FROM.timestamp() * 1000
    boxes = [t['bbox'] for t in area['tracks'] if t['startMs'] >= cutoff]
    if not boxes:
        return None

    lat0 = min(b[0] for b in boxes); lat1 = max(b[2] for b in boxes)
    lon0 = min(b[1] for b in boxes); lon1 = max(b[3] for b in boxes)

    km_per_lat = 111.0
    km_per_lon = 111.0 * math.cos(math.radians((lat0 + lat1) / 2))

    lat0 -= GRID_MARGIN_KM / km_per_lat; lat1 += GRID_MARGIN_KM / km_per_lat
    lon0 -= GRID_MARGIN_KM / km_per_lon; lon1 += GRID_MARGIN_KM / km_per_lon

    n_lat = max(2, int(round((lat1 - lat0) / (GRID_TARGET_KM / km_per_lat))) + 1)
    n_lon = max(2, int(round((lon1 - lon0) / (GRID_TARGET_KM / km_per_lon))) + 1)

    # Coarsen the longer axis until the point count is within budget.
    while n_lat * n_lon > GRID_MAX_POINTS and (n_lat > 2 or n_lon > 2):
        if n_lat >= n_lon: n_lat -= 1
        else:              n_lon -= 1

    return {
        'lat0': round(lat0, 5), 'lon0': round(lon0, 5),
        'dLat': round((lat1 - lat0) / (n_lat - 1), 6),
        'dLon': round((lon1 - lon0) / (n_lon - 1), 6),
        'nLat': n_lat, 'nLon': n_lon,
    }


def grid_points(grid):
    """Grid coordinates in row-major order: latitude outer, longitude inner."""
    return [
        (round(grid['lat0'] + i * grid['dLat'], 5), round(grid['lon0'] + j * grid['dLon'], 5))
        for i in range(grid['nLat'])
        for j in range(grid['nLon'])
    ]


def fetch_grid(model, endpoint, grid, start_date, end_date):
    """{epoch_ms: [(u, v), ...]} in grid order, for one model and date range."""
    pts = grid_points(grid)
    params = {
        'latitude':        ','.join(str(p[0]) for p in pts),
        'longitude':       ','.join(str(p[1]) for p in pts),
        'start_date':      start_date.isoformat(),
        'end_date':        end_date.isoformat(),
        'hourly':          'wind_speed_10m,wind_direction_10m',
        'wind_speed_unit': 'kn',
        'timeformat':      'unixtime',
    }
    if endpoint is FORECAST_API:
        params['models'] = model

    url = f'{endpoint}?{urllib.parse.urlencode(params)}'
    with urllib.request.urlopen(url, timeout=180) as resp:
        payload = json.load(resp)

    locations = payload if isinstance(payload, list) else [payload]
    if len(locations) != len(pts):
        raise RuntimeError(f'expected {len(pts)} locations, got {len(locations)}')

    by_hour = {}
    for idx, loc in enumerate(locations):
        h     = loc['hourly']
        times = h['time']
        spds  = _field(h, 'wind_speed_10m')
        dirs  = _field(h, 'wind_direction_10m')
        if spds is None or dirs is None:
            raise RuntimeError('grid response missing wind fields')

        for t, spd, wdir in zip(times, spds, dirs):
            if spd is None or wdir is None:
                continue
            slot = by_hour.setdefault(t * 1000, [None] * len(pts))
            slot[idx] = to_uv(spd, wdir)

    # An hour is only usable if every cell reported; a hole would interpolate
    # against a zero and bend the flow toward it.
    return {t: cells for t, cells in by_hour.items() if all(c is not None for c in cells)}


def month_spans(hours):
    """Group hours into (YYYY-MM, first_date, last_date) request windows."""
    by_month = {}
    for h in hours:
        d = datetime.fromtimestamp(h * 3600, tz=timezone.utc).date()
        by_month.setdefault(d.strftime('%Y-%m'), []).append(d)
    return [(m, min(ds), max(ds)) for m, ds in sorted(by_month.items())]


# ── Fetching ──────────────────────────────────────────────────────

def _field(hourly, needle):
    """Model-specific responses suffix field names (wind_speed_10m_gfs_hrrr)."""
    for key in hourly:
        if key.startswith(needle):
            return hourly[key]
    return None


def fetch_one(model, endpoint, lat, lon, start_date, end_date):
    """[(epoch_ms, speed_kn, dir_deg, gust_kn)] from one model, or [] if it has none."""
    params = {
        'latitude':        lat,
        'longitude':       lon,
        'start_date':      start_date.isoformat(),
        'end_date':        end_date.isoformat(),
        'hourly':          'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        'wind_speed_unit': 'kn',
        'timeformat':      'unixtime',
    }
    if endpoint is FORECAST_API:
        params['models'] = model

    url = f'{endpoint}?{urllib.parse.urlencode(params)}'
    with urllib.request.urlopen(url, timeout=90) as resp:
        payload = json.load(resp)

    if 'error' in payload:
        raise RuntimeError(payload.get('reason', 'unknown API error'))

    h     = payload['hourly']
    times = h['time']
    spds  = _field(h, 'wind_speed_10m')
    dirs  = _field(h, 'wind_direction_10m')
    gusts = _field(h, 'wind_gusts_10m') or [None] * len(times)
    if spds is None or dirs is None:
        return []

    rows = []
    for t, spd, wdir, gust in zip(times, spds, dirs, gusts):
        if spd is None or wdir is None:
            continue        # model gaps: leave the hour absent rather than guess
        rows.append((t * 1000, spd, wdir, gust))
    return rows


def fetch_hourly(lat, lon, start_date, end_date, unsupported):
    """
    Best available model for this place and date range, walking the ladder until
    one answers. Returns (model_index, rows).

    `unsupported` is the set of model ids already ruled out for this area and is
    updated in place — the domain of a model does not change between requests,
    so there is no point asking twice.
    """
    for i, (model, _name, endpoint) in enumerate(MODELS):
        if model in unsupported:
            continue

        try:
            rows = fetch_one(model, endpoint, lat, lon, start_date, end_date)
        except (urllib.error.HTTPError, RuntimeError):
            # A rejection: this area is outside the model's domain. Permanent.
            unsupported.add(model)
            continue
        except (urllib.error.URLError, TimeoutError, OSError):
            # A network problem says nothing about the model — try it again next
            # time rather than silently downgrading the whole area to ERA5.
            continue

        if rows:
            return i, rows
        # Empty is not a rejection: the model may simply not reach back this far
        # (HRDPS starts around May 2023). Fall through for this range only.

    return None, []


def content_stamp(obj):
    payload = json.dumps(obj, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return hashlib.sha1(payload).hexdigest()[:12]


def load_existing_grid(desired):
    """
    {(areaId, timeMs): [(u, v), ...]} from the previous wind-grid.bin.

    Without this the grid is silently destroyed by any incremental run: the
    binary is rebuilt from scratch, but only months that were actually fetched
    contribute cells, and months whose point rows are already cached are never
    fetched. Adding one track collapsed the grid from 344 hours to 5.

    Cells are only reused where the geometry still matches. If the grid has
    moved or resized — a new track extending the area does that — the stored
    cells describe different points on the ground, so they are dropped and
    refetched.
    """
    if not (os.path.exists(OUT_PATH) and os.path.exists(GRID_PATH)):
        return {}
    try:
        with open(OUT_PATH, encoding='utf-8') as f:
            doc = json.load(f)
        if doc.get('format') != FORMAT:
            return {}
        blob = array.array('b')
        with open(GRID_PATH, 'rb') as f:
            blob.frombytes(f.read())
    except (OSError, json.JSONDecodeError, ValueError):
        return {}

    out = {}
    for spec in doc.get('grids', []):
        area_id = spec['area']
        want = desired.get(area_id)
        if not want:
            continue

        same = (spec['nLat'] == want['nLat'] and spec['nLon'] == want['nLon'] and
                all(abs(spec[k] - want[k]) < 1e-9 for k in ('lat0', 'lon0', 'dLat', 'dLon')))
        if not same:
            print(f'  area {area_id}: grid geometry changed, refetching it')
            continue

        n      = spec['nLat'] * spec['nLon']
        stride = n * 2
        scale  = spec.get('scale', QUANT_KN)
        for i, t_ms in enumerate(spec['hours']):
            o = spec['offset'] + i * stride
            if o + stride > len(blob):
                break
            out[(area_id, t_ms)] = [(blob[o + k * 2] * scale, blob[o + k * 2 + 1] * scale)
                                    for k in range(n)]
    return out


def load_existing():
    """
    {(areaId, timeMs): row} already fetched, so re-runs only get what is new.
    A file written in an older format is discarded rather than merged.
    """
    if not os.path.exists(OUT_PATH):
        return {}
    try:
        with open(OUT_PATH, encoding='utf-8') as f:
            doc = json.load(f)
        if doc.get('format') != FORMAT:
            print('Existing wind.json is an older format; rebuilding from scratch.\n')
            return {}
        return {(r[1], r[0]): r for r in doc.get('hours', [])}
    except (json.JSONDecodeError, OSError, IndexError):
        return {}


# ── Main ──────────────────────────────────────────────────────────

def main():
    force = '--force' in sys.argv

    if not os.path.exists(MANIFEST):
        sys.exit('tracks.json not found — run build_tracks.py first.')

    with open(MANIFEST, encoding='utf-8') as f:
        manifest = json.load(f)
    tracks = manifest['tracks'] if isinstance(manifest, dict) else manifest

    if tracks and 'endMs' not in tracks[0]:
        sys.exit('tracks.json predates endMs — rerun build_tracks.py first.')

    areas = group_areas(tracks)
    print(f'{len(tracks)} tracks across {len(areas)} sailing area(s)\n')

    have = {} if force else load_existing()
    if have:
        print(f'Reusing {len(have)} hour(s) already fetched\n')

    rows      = dict(have)
    requests  = 0
    failures  = []
    used      = {}      # model index -> hours fetched, for the summary

    grids     = {a['id']: grid_for(a) for a in areas}
    grids     = {k: g for k, g in grids.items() if g}
    # (areaId, timeMs) -> [(u, v), ...] in grid order, carried over where the
    # geometry is unchanged so an incremental run does not wipe the field.
    grid_rows = {} if force else load_existing_grid(grids)
    if grid_rows:
        print(f'Reusing {len(grid_rows)} grid hour(s) already fetched\n')

    for area in areas:
        hours = wanted_hours(area)
        missing_points = {h for h in hours if (area['id'], h * HOUR_MS) not in rows}
        # An hour can have its point row cached but no grid cells — after a
        # geometry change, or the first run after the grid was introduced.
        missing_grid = ({h for h in hours if (area['id'], h * HOUR_MS) not in grid_rows}
                        if area['id'] in grids else set())
        missing = missing_points | missing_grid

        label = f"area {area['id']} ({area['lat']:.3f}, {area['lon']:.3f}) - {len(area['tracks'])} track(s)"
        if not missing:
            print(f'{label}: up to date')
            continue

        spans = month_spans(missing)
        print(f'{label}: {len(missing)} hour(s) missing over {len(spans)} request(s)')

        # Which models this area has already been refused by. Domains do not
        # change between requests, so one rejection is enough.
        unsupported = set()

        for month, first, last in spans:
            try:
                model_idx, fetched = fetch_hourly(area['lat'], area['lon'], first, last, unsupported)
                requests += 1
            except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as e:
                print(f'    {month}: FAILED - {e}')
                failures.append((area['id'], month, str(e)))
                continue

            if model_idx is None:
                print(f'    {month}: no model had data')
                failures.append((area['id'], month, 'no model had data'))
                continue

            kept = 0
            for t_ms, spd, wdir, gust in fetched:
                # Keep only hours a track actually spans; the API returns whole days.
                if t_ms // HOUR_MS not in hours:
                    continue
                rows[(area['id'], t_ms)] = [
                    t_ms, area['id'],
                    round(spd, 1), int(round(wdir)),
                    round(gust, 1) if gust is not None else None,
                    model_idx,
                ]
                kept += 1
            used[model_idx] = used.get(model_idx, 0) + kept
            print(f'    {month}: {kept} hour(s) from {MODEL_NAMES[model_idx]}')

            # A grid for the particle field, from the same model that just
            # answered — but only where that model is a North American one.
            grid = grids.get(area['id'])
            if grid and MODELS[model_idx][0] in GRID_MODELS:
                try:
                    cells = fetch_grid(MODELS[model_idx][0], MODELS[model_idx][2], grid, first, last)
                    kept_g = 0
                    for t_ms, uv in cells.items():
                        if t_ms // HOUR_MS not in hours:
                            continue
                        grid_rows[(area['id'], t_ms)] = uv
                        kept_g += 1
                    print(f'      grid: {kept_g} hour(s) x {grid["nLat"]}x{grid["nLon"]} cells')
                except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as e:
                    print(f'      grid: FAILED - {e}')
                    failures.append((area['id'], month, f'grid: {e}'))
                time.sleep(REQUEST_PAUSE)

            time.sleep(REQUEST_PAUSE)

    # Drop hours no track covers any more. Without this, deleting a track leaves
    # its wind behind forever — the builder otherwise only ever adds.
    wanted = set()
    for area in areas:
        for h in wanted_hours(area):
            wanted.add((area['id'], h * HOUR_MS))
    stale = [k for k in rows if k not in wanted]
    for k in stale:
        del rows[k]

    # The grid needs the same treatment. Pruning only the point rows left a
    # deleted track's wind field in wind-grid.bin forever, so the binary grew
    # monotonically and never shrank.
    stale_grid = [k for k in grid_rows if k not in wanted]
    for k in stale_grid:
        del grid_rows[k]

    if stale or stale_grid:
        print(f'\nPruned {len(stale)} point hour(s) and {len(stale_grid)} grid hour(s) '
              f'no longer covered by any track')

    if not rows:
        sys.exit('\nNo wind data retrieved; leaving data/wind.json alone.')

    hours_out = sorted(rows.values(), key=lambda r: (r[0], r[1]))
    areas_out = [
        {'id': a['id'], 'lat': a['lat'], 'lon': a['lon'], 'tracks': len(a['tracks'])}
        for a in areas
    ]

    # ── Grid sidecar ──────────────────────────────────────────────
    #
    # u and v as int8 at 0.25 kn. Stored as components rather than speed and
    # direction because interpolation has to happen in vector space anyway —
    # averaging 9 and 328 degrees numerically gives the opposite of the truth.
    grid_meta = []
    blob = array.array('b')

    for area_id in sorted(grids):
        grid  = grids[area_id]
        times = sorted(t for (a, t) in grid_rows if a == area_id)
        if not times:
            continue

        offset = len(blob)
        for t_ms in times:
            for u, v in grid_rows[(area_id, t_ms)]:
                blob.append(quantise(u))
                blob.append(quantise(v))

        grid_meta.append({
            'area':   area_id,
            **grid,
            'scale':  QUANT_KN,
            'offset': offset,
            'hours':  times,
        })

    if blob:
        with open(GRID_PATH, 'wb') as f:
            blob.tofile(f)
    elif os.path.exists(GRID_PATH):
        os.remove(GRID_PATH)

    body = {'areas': areas_out, 'models': MODEL_NAMES, 'grids': grid_meta, 'hours': hours_out}
    doc  = {
        'format': FORMAT,
        'stamp':  content_stamp(body),
        'built':  datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'Open-Meteo',
        'units':  {'speed': 'kn', 'direction': 'degrees true, direction wind comes FROM', 'gust': 'kn'},
        **body,
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))

    kb = os.path.getsize(OUT_PATH) / 1024
    print(f'\ndata/wind.json - {len(hours_out)} hour(s), {len(areas_out)} area(s), {kb:.1f} KB '
          f'({requests} request(s))')

    # Which model actually supplied each hour, counted over the whole file.
    tally = {}
    for r in hours_out:
        idx = r[5] if len(r) > 5 else None
        tally[idx] = tally.get(idx, 0) + 1
    for idx in sorted(tally, key=lambda i: (i is None, i)):
        name = MODEL_NAMES[idx] if idx is not None else 'unknown (older file)'
        print(f'  {name:16s} {tally[idx]:5d} hour(s)')

    if grid_meta:
        cells = sum(g['nLat'] * g['nLon'] * len(g['hours']) for g in grid_meta)
        print(f'\ndata/wind-grid.bin - {len(blob)/1024:.1f} KB, {cells} cells '
              f'across {len(grid_meta)} area(s)')
        for g in grid_meta:
            print(f"  area {g['area']}: {g['nLat']}x{g['nLon']} cells, {len(g['hours'])} hour(s)")
    else:
        print('\nNo grid written (no North American area had data).')

    if failures:
        print(f'{len(failures)} request(s) failed; rerun to fill the gaps:')
        for area_id, month, err in failures[:5]:
            print(f'  area {area_id} {month}: {err}')

    print('Done - commit data/wind.json.')


if __name__ == '__main__':
    main()
