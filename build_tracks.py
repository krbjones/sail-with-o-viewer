#!/usr/bin/env python3
"""
build_tracks.py — Pre-process GPX files into compact monthly JSON bundles.

Run this whenever new GPX tracks are added:
    python build_tracks.py                  # rebuild everything
    python build_tracks.py --skip-existing  # reuse already-parsed tracks

Output:
    data/YYYY-MM.json   one file per month, compact point arrays
    tracks.json         manifest with per-track stats and per-month content hashes

Month bundle record:
    {"id":"2024-07-15_121559.gpx","s":1721044559000,"e":1721051234000,
     "bbox":[minLat,minLon,maxLat,maxLon],
     "dist":12.4,"maxSpd":7.8,"avgSpd":4.1,"movingMs":5400000,
     "pts":[[lat,lon,timeMs,speedKts],...]}

Manifest:
    {"buildStamp":"2026-07-31T18:42:00Z",
     "months":{"2024-07":"<content hash>"},
     "tracks":[{"file":...,"startMs":...,"endMs":...,"month":...,"bbox":[...],
                "dist":...,"maxSpd":...,"avgSpd":...,"movingMs":...,"n":...}]}

The per-month hash lets the browser cache month bundles in IndexedDB and refetch
only the months whose contents actually changed.
"""

import os, re, sys, json, math, hashlib
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

FOLDER   = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(FOLDER, 'data')
os.makedirs(DATA_DIR, exist_ok=True)

KNOTS_PER_MS   = 1.94384        # m/s -> knots
METRES_PER_NM  = 1852.0
SMOOTH_W       = 2              # half-width of the moving average; must match js/data/gpxParser.js
MOVING_MIN_KTS = 0.5            # below this the boat counts as stopped

# GPS receivers occasionally emit a fix hundreds of metres away for a single
# sample. Left in, one such glitch produced a 1572 kt "max speed" and inflated
# the track distance.
#
# A glitch has to satisfy BOTH tests. Speed alone is not enough: these logs are
# 1 Hz, and at that rate ordinary jitter combined with sub-second timestamp
# rounding trips a 25 kt threshold hundreds of times in a perfectly clean track.
# Distance separates them cleanly — real 1 Hz steps top out around 9 m
# (p99.9 is under 7 m), while an actual teleport is hundreds of metres.
# Note: about 20 tracks sustain 20-59 kt for minutes at a time. Those are not
# glitches and must not be filtered — they are passages under power, confirmed
# by the wind data (one averages 10.5 kt of boat speed in 9 kt of wind). The
# distance test below is what keeps them: they move fast but never teleport.
MAX_PLAUSIBLE_KTS     = 25.0
MIN_GLITCH_METRES     = 50.0
# Do not drop indefinitely: after a recording gap the boat really has moved, so
# resync rather than discarding the rest of the track. The limit has to outlast
# a whole bad excursion — one track wanders 3.2 km away for seven samples before
# snapping back, and a limit of 3 let the tail of that excursion through.
MAX_CONSECUTIVE_DROPS = 20
# Speed and distance are unmeasurable across a break in the log, so a step
# longer than this is bridged: the position is kept, the speed is not invented.
GAP_SECONDS           = 60.0


# ── Helpers ───────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_gpx(filepath):
    """Return [[lat, lon, timeMs, speedKts], ...] plus stats, or None on failure."""
    raw = []
    lat = lon = t_ms = None
    in_trkpt = False

    try:
        for event, elem in ET.iterparse(filepath, events=('start', 'end')):
            tag = elem.tag.split('}')[-1]   # strip namespace

            if event == 'start' and tag == 'trkpt':
                try:
                    lat = float(elem.get('lat'))
                    lon = float(elem.get('lon'))
                    in_trkpt = True
                    t_ms = None
                except (TypeError, ValueError):
                    in_trkpt = False

            elif event == 'end' and tag == 'time' and in_trkpt:
                if elem.text:
                    try:
                        t_str = elem.text.strip().replace(' ', 'T')
                        if not t_str.endswith('Z'):
                            t_str += 'Z'
                        dt   = datetime.fromisoformat(t_str.replace('Z', '+00:00'))
                        t_ms = int(dt.timestamp() * 1000)
                    except ValueError:
                        pass

            elif event == 'end' and tag == 'trkpt':
                if in_trkpt and lat is not None and t_ms is not None:
                    raw.append((t_ms, lat, lon))
                in_trkpt = False
                elem.clear()   # free memory

    except ET.ParseError:
        return None

    if len(raw) < 2:
        return None

    # Sort on time only, and stably. Sorting whole tuples would break ties on
    # latitude, so which of a pair of same-timestamp fixes survives dedup would
    # depend on the coordinates — and would not match the browser-side parser in
    # js/data/gpxParser.js, which keeps the first in file order.
    raw.sort(key=lambda r: r[0])

    # Reject bad fixes, then compute speed and distance over what is left
    clean    = [raw[0]]
    speeds   = [0.0]
    # continuous[i] — is the interval from point i-1 to i a real, measured one?
    # False across a log gap or a resync, where speed and distance are unknown.
    continuous = [False]
    dist_m   = 0.0
    dropped  = dupes = 0
    run      = 0

    for t_ms, lat, lon in raw[1:]:
        pt_ms, pt_lat, pt_lon = clean[-1]
        dt = (t_ms - pt_ms) / 1000

        # Repeated timestamp — carries no new time information and would divide
        # by zero. Not a glitch, just a duplicate sample.
        if dt <= 0:
            dupes += 1
            continue

        step = haversine(pt_lat, pt_lon, lat, lon)
        kts  = step / dt * KNOTS_PER_MS

        if step > MIN_GLITCH_METRES and kts > MAX_PLAUSIBLE_KTS and run < MAX_CONSECUTIVE_DROPS:
            dropped += 1
            run     += 1
            continue

        # Resyncing after dropped fixes, or bridging a gap in the log: keep the
        # position but do not pretend to know how fast the boat got there.
        bridged = run > 0 or dt > GAP_SECONDS
        run = 0

        clean.append((t_ms, lat, lon))
        continuous.append(not bridged)
        if bridged:
            speeds.append(0.0)
        else:
            speeds.append(kts)
            dist_m += step

    raw = clean
    n   = len(raw)
    if n < 2:
        return None

    # Moving-average smooth over a (2*SMOOTH_W + 1) window
    pts       = []
    max_spd   = 0.0
    moving_ms = 0
    for i in range(n):
        s = max(0, i - SMOOTH_W)
        e = min(n - 1, i + SMOOTH_W)
        avg = max(0.0, sum(speeds[j] for j in range(s, e + 1)) / (e - s + 1))

        t_ms, lat, lon = raw[i]
        pts.append([round(lat, 6), round(lon, 6), t_ms, round(avg, 2)])

        if avg > max_spd:
            max_spd = avg
        # Only count time we actually measured — a bridged gap is not sailing time.
        if i > 0 and continuous[i] and avg >= MOVING_MIN_KTS:
            moving_ms += raw[i][0] - raw[i - 1][0]

    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]

    dist_nm = dist_m / METRES_PER_NM
    # Average over time actually under way — a long drift at anchor otherwise
    # drags the figure toward zero and says nothing about the sail. Needs a
    # meaningful sample, or a few seconds of movement reads as a huge average.
    avg_spd = (dist_nm / (moving_ms / 3600000)) if moving_ms >= 60000 else 0.0

    return {
        'pts':       pts,
        'bbox':      [round(min(lats), 6), round(min(lons), 6),
                      round(max(lats), 6), round(max(lons), 6)],
        'dist':      round(dist_nm, 2),
        'maxSpd':    round(max_spd, 2),
        'avgSpd':    round(avg_spd, 2),
        'movingMs':  moving_ms,
        'dropped':   dropped,
        'dupes':     dupes,
    }


FNAME_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})_\d{6}\.gpx$')


def first_time_ms(filepath):
    """
    Timestamp of the first track point, read without parsing the whole file.
    Used only for files whose name does not follow the archive convention.
    """
    try:
        for event, elem in ET.iterparse(filepath, events=('end',)):
            if elem.tag.split('}')[-1] != 'time' or not elem.text:
                continue
            try:
                t_str = elem.text.strip().replace(' ', 'T')
                if not t_str.endswith('Z'):
                    t_str += 'Z'
                return int(datetime.fromisoformat(t_str.replace('Z', '+00:00')).timestamp() * 1000)
            except ValueError:
                continue
    except ET.ParseError:
        pass
    return None


def month_key(fname, filepath=None):
    """
    Group by *local* month. Track filenames usually encode local start time
    ("2025-08-02_201002.gpx"), which is authoritative and independent of the
    build machine's timezone. A track starting at 20:10 local on Jul 31 is
    already Aug 1 in UTC and would otherwise land in the wrong bundle.

    Loggers do not all agree on that format — one writes "2026-08-01_11-19-07"
    and means the time the file was saved, not the time the track began. Rather
    than trust an unfamiliar name, fall back to the first timestamp inside the
    file. Do not fall back to "now" or to zero: an earlier version passed 0 here
    and filed the track under 1969-12.
    """
    m = FNAME_RE.match(fname)
    if m:
        return f'{m.group(1)}-{m.group(2)}'

    start_ms = first_time_ms(filepath) if filepath else None
    if start_ms is None:
        return None
    return datetime.fromtimestamp(start_ms / 1000).strftime('%Y-%m')


def load_existing(month):
    """Existing month bundle indexed by track id, for --skip-existing."""
    path = os.path.join(DATA_DIR, f'{month}.json')
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            return {rec['id']: rec for rec in json.load(f)}
    except (json.JSONDecodeError, KeyError, OSError):
        return {}


def content_hash(obj):
    payload = json.dumps(obj, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return hashlib.sha1(payload).hexdigest()[:12]


# ── Main ──────────────────────────────────────────────────────────

def main():
    skip_existing = '--skip-existing' in sys.argv

    gpx_files = sorted(f for f in os.listdir(FOLDER) if f.endswith('.gpx'))
    print(f'Found {len(gpx_files)} GPX files'
          f'{" (reusing already-parsed tracks)" if skip_existing else ""}\n')

    # Group by month up front so each bundle can be written and freed in turn —
    # holding every month's points in memory at once is gigabytes.
    files_by_month = {}
    undated = []
    for fname in gpx_files:
        month = month_key(fname, os.path.join(FOLDER, fname))
        if month is None:
            undated.append(fname)
            continue
        files_by_month.setdefault(month, []).append(fname)

    for fname in undated:
        print(f'  SKIP (no readable timestamp): {fname}')

    print('Writing monthly bundles:')
    manifest = []
    months   = {}
    total_kb = 0
    skipped  = reused = total_dropped = total_dupes = glitchy = 0

    for month in sorted(files_by_month):
        existing = load_existing(month) if skip_existing else {}
        records  = []

        for fname in files_by_month[month]:
            # Reuse a previously parsed record when the track is already in the
            # bundle. Per track, not per month — a new track added to an
            # existing month used to be dropped entirely.
            record = existing.get(fname)
            if record is not None and 'movingMs' in record:
                reused += 1
            else:
                parsed = parse_gpx(os.path.join(FOLDER, fname))
                if not parsed:
                    print(f'  SKIP (no valid points): {fname}')
                    skipped += 1
                    continue
                total_dupes += parsed['dupes']
                if parsed['dropped']:
                    total_dropped += parsed['dropped']
                    glitchy       += 1
                record = {
                    'id':       fname,
                    's':        parsed['pts'][0][2],
                    'e':        parsed['pts'][-1][2],
                    'bbox':     parsed['bbox'],
                    'dist':     parsed['dist'],
                    'maxSpd':   parsed['maxSpd'],
                    'avgSpd':   parsed['avgSpd'],
                    'movingMs': parsed['movingMs'],
                    'pts':      parsed['pts'],
                }

            records.append(record)
            manifest.append({
                'file':     fname,
                'startMs':  record['s'],
                'endMs':    record['e'],
                'month':    month,
                'bbox':     record['bbox'],
                'dist':     record['dist'],
                'maxSpd':   record['maxSpd'],
                'avgSpd':   record['avgSpd'],
                'movingMs': record['movingMs'],
                'n':        len(record['pts']),
            })

        if not records:
            continue

        records.sort(key=lambda r: r['s'])
        out_path = os.path.join(DATA_DIR, f'{month}.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(records, f, separators=(',', ':'))

        months[month] = content_hash(records)
        kb = os.path.getsize(out_path) / 1024
        total_kb += kb
        print(f'  data/{month}.json - {len(records)} track(s), {kb:.1f} KB')

        records = existing = None   # free before the next month

    # Remove bundles no month claims any more. Deleting the last track in a
    # month leaves its file behind otherwise: the loop above only writes months
    # it still has records for, so nothing ever cleans up the empty one and it
    # sits on disk unreferenced by tracks.json.
    for name in sorted(os.listdir(DATA_DIR)):
        if not (name.endswith('.json') and name[0].isdigit()):
            continue                       # wind.json, races.json and friends
        if name[:-5] in months:
            continue
        os.remove(os.path.join(DATA_DIR, name))
        print(f'  removed data/{name} - no tracks left in that month')

    manifest.sort(key=lambda m: m['startMs'])
    with open(os.path.join(FOLDER, 'tracks.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'buildStamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'months':     months,
            'tracks':     manifest,
        }, f, indent=1)

    print(f'\n{len(manifest)} tracks -> {len(months)} monthly files, '
          f'{total_kb:.0f} KB total ({reused} reused, {skipped} skipped)')
    if total_dupes:
        print(f'Dropped {total_dupes} duplicate timestamp(s)')
    if total_dropped:
        print(f'Rejected {total_dropped} GPS glitch(es) '
              f'(>{MIN_GLITCH_METRES:.0f} m and >{MAX_PLAUSIBLE_KTS:.0f} kt) '
              f'across {glitchy} track(s)')
    print('Done - commit the data/ folder and tracks.json.')


if __name__ == '__main__':
    main()
