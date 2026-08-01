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

import os, sys, json, time, hashlib, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

FOLDER    = os.path.dirname(os.path.abspath(__file__))
DATA_DIR  = os.path.join(FOLDER, 'data')
MANIFEST  = os.path.join(FOLDER, 'tracks.json')
OUT_PATH  = os.path.join(DATA_DIR, 'wind.json')

API = 'https://archive-api.open-meteo.com/v1/archive'

# Tracks whose centres round to the same half-degree cell are one sailing area.
# Coarse on purpose: ERA5's own grid is ~25 km, so finer clustering would fetch
# the same grid cell repeatedly under different names.
AREA_PRECISION = 2          # multiples of 1/2 degree
PAD_HOURS      = 1          # keep an hour either side so interpolation has ends
REQUEST_PAUSE  = 0.4        # be polite to a free API
HOUR_MS        = 3600000


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
    hours = set()
    for t in area['tracks']:
        first = t['startMs'] // HOUR_MS - PAD_HOURS
        last  = t['endMs']   // HOUR_MS + PAD_HOURS
        hours.update(range(first, last + 1))
    return hours


def month_spans(hours):
    """Group hours into (YYYY-MM, first_date, last_date) request windows."""
    by_month = {}
    for h in hours:
        d = datetime.fromtimestamp(h * 3600, tz=timezone.utc).date()
        by_month.setdefault(d.strftime('%Y-%m'), []).append(d)
    return [(m, min(ds), max(ds)) for m, ds in sorted(by_month.items())]


# ── Fetching ──────────────────────────────────────────────────────

def fetch_hourly(lat, lon, start_date, end_date):
    """[(epoch_ms, speed_kn, dir_deg, gust_kn)] for a date range, UTC."""
    query = urllib.parse.urlencode({
        'latitude':        lat,
        'longitude':       lon,
        'start_date':      start_date.isoformat(),
        'end_date':        end_date.isoformat(),
        'hourly':          'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        'wind_speed_unit': 'kn',
        'timeformat':      'unixtime',
    })

    with urllib.request.urlopen(f'{API}?{query}', timeout=60) as resp:
        payload = json.load(resp)

    if 'error' in payload:
        raise RuntimeError(payload.get('reason', 'unknown API error'))

    h = payload['hourly']
    rows = []
    for t, spd, wdir, gust in zip(h['time'], h['wind_speed_10m'],
                                  h['wind_direction_10m'], h['wind_gusts_10m']):
        if spd is None or wdir is None:
            continue        # ERA5 gaps: leave the hour absent rather than guess
        rows.append((t * 1000, spd, wdir, gust))
    return rows


def content_stamp(obj):
    payload = json.dumps(obj, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return hashlib.sha1(payload).hexdigest()[:12]


def load_existing():
    """{(areaId, timeMs): row} already fetched, so re-runs only get what is new."""
    if not os.path.exists(OUT_PATH):
        return {}, []
    try:
        with open(OUT_PATH, encoding='utf-8') as f:
            doc = json.load(f)
        have = {(r[1], r[0]): r for r in doc.get('hours', [])}
        return have, doc.get('areas', [])
    except (json.JSONDecodeError, OSError, IndexError):
        return {}, []


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

    have, _ = ({}, []) if force else load_existing()
    if have:
        print(f'Reusing {len(have)} hour(s) already fetched\n')

    rows      = dict(have)
    requests  = 0
    failures  = []

    for area in areas:
        hours = wanted_hours(area)
        missing = {h for h in hours if (area['id'], h * HOUR_MS) not in rows}

        label = f"area {area['id']} ({area['lat']:.3f}, {area['lon']:.3f}) - {len(area['tracks'])} track(s)"
        if not missing:
            print(f'{label}: up to date')
            continue

        spans = month_spans(missing)
        print(f'{label}: {len(missing)} hour(s) missing over {len(spans)} request(s)')

        for month, first, last in spans:
            try:
                fetched = fetch_hourly(area['lat'], area['lon'], first, last)
                requests += 1
            except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as e:
                print(f'    {month}: FAILED - {e}')
                failures.append((area['id'], month, str(e)))
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
                ]
                kept += 1
            print(f'    {month}: {kept} hour(s)')
            time.sleep(REQUEST_PAUSE)

    if not rows:
        sys.exit('\nNo wind data retrieved; leaving data/wind.json alone.')

    hours_out = sorted(rows.values(), key=lambda r: (r[0], r[1]))
    areas_out = [
        {'id': a['id'], 'lat': a['lat'], 'lon': a['lon'], 'tracks': len(a['tracks'])}
        for a in areas
    ]

    body = {'areas': areas_out, 'hours': hours_out}
    doc  = {
        'stamp':  content_stamp(body),
        'built':  datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'Open-Meteo ERA5 reanalysis (~25 km grid)',
        'units':  {'speed': 'kn', 'direction': 'degrees true, direction wind comes FROM', 'gust': 'kn'},
        **body,
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))

    kb = os.path.getsize(OUT_PATH) / 1024
    print(f'\ndata/wind.json - {len(hours_out)} hour(s), {len(areas_out)} area(s), {kb:.1f} KB '
          f'({requests} request(s))')

    if failures:
        print(f'{len(failures)} request(s) failed; rerun to fill the gaps:')
        for area_id, month, err in failures[:5]:
            print(f'  area {area_id} {month}: {err}')

    print('Done - commit data/wind.json.')


if __name__ == '__main__':
    main()
