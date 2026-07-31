#!/usr/bin/env python3
"""
build_tracks.py — Pre-process GPX files into compact monthly JSON bundles.

Run this whenever new GPX tracks are added:
    python build_tracks.py

Output:
    data/YYYY-MM.json   — one file per month, compact point arrays
    tracks.json         — manifest: [{file, startMs, month}]

Each track in a monthly file looks like:
    {"id":"2024-07-15_121559.gpx","s":1721044559000,"e":1721051234000,
     "pts":[[lat,lon,timeMs,speedKts],...]}
"""

import os, json, math
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

FOLDER   = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(FOLDER, 'data')
os.makedirs(DATA_DIR, exist_ok=True)

# ── Helpers ───────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def parse_gpx(filepath):
    """Return list of [lat, lon, timeMs, speedKts] arrays, or None on failure."""
    raw = []
    lat = lon = t_ms = None
    in_trkpt = False

    try:
        for event, elem in ET.iterparse(filepath, events=('start', 'end')):
            tag = elem.tag.split('}')[-1]  # strip namespace

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
                        dt    = datetime.fromisoformat(t_str.replace('Z', '+00:00'))
                        t_ms  = int(dt.timestamp() * 1000)
                    except ValueError:
                        pass

            elif event == 'end' and tag == 'trkpt':
                if in_trkpt and lat is not None and t_ms is not None:
                    raw.append((t_ms, lat, lon))
                in_trkpt = False
                elem.clear()  # free memory

    except ET.ParseError:
        return None

    if len(raw) < 2:
        return None

    raw.sort()

    # Compute raw speed (m/s → knots)
    speeds = [0.0]
    for i in range(1, len(raw)):
        dt   = (raw[i][0] - raw[i-1][0]) / 1000
        dist = haversine(raw[i-1][1], raw[i-1][2], raw[i][1], raw[i][2])
        speeds.append((dist / dt * 1.94384) if dt > 0 else 0.0)

    # 5-point moving-average smooth (W=2, same as browser)
    W = 2; n = len(raw)
    points = []
    for i, (t_ms, lat, lon) in enumerate(raw):
        s   = max(0, i - W); e = min(n - 1, i + W)
        avg = sum(speeds[j] for j in range(s, e + 1)) / (e - s + 1)
        points.append([round(lat, 6), round(lon, 6), t_ms, round(max(0.0, avg), 2)])

    return points

# ── Main ──────────────────────────────────────────────────────────

import sys
skip_existing = '--skip-existing' in sys.argv

gpx_files = sorted(f for f in os.listdir(FOLDER) if f.endswith('.gpx'))
print(f"Found {len(gpx_files)} GPX files\n")

manifest = []
by_month = {}   # "YYYY-MM" → [track_dict, ...]
skipped  = 0

for fname in gpx_files:
    if not fname.endswith('.gpx'):
        continue

    pts = parse_gpx(os.path.join(FOLDER, fname))
    if not pts:
        print(f"  SKIP (no valid points): {fname}")
        skipped += 1
        continue

    start_ms  = pts[0][2]   # first point time, already UTC ms
    end_ms    = pts[-1][2]
    # Month key from UTC timestamp — close enough for grouping
    dt_utc    = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    month_key = dt_utc.strftime("%Y-%m")

    # Skip if month file already written and --skip-existing passed
    # Compute bounding box from points
    lats = [p[0] for p in pts]; lons = [p[1] for p in pts]
    bbox = [round(min(lats),6), round(min(lons),6), round(max(lats),6), round(max(lons),6)]

    if skip_existing and os.path.exists(os.path.join(DATA_DIR, f"{month_key}.json")):
        manifest.append({"file": fname, "startMs": start_ms, "month": month_key, "bbox": bbox})
        continue
    by_month.setdefault(month_key, []).append({
        "id": fname, "s": start_ms, "e": end_ms, "bbox": bbox, "pts": pts
    })
    manifest.append({"file": fname, "startMs": start_ms, "month": month_key, "bbox": bbox})

# Write monthly JSON files
print("Writing monthly bundles:")
total_kb = 0
for month, month_tracks in sorted(by_month.items()):
    out_path = os.path.join(DATA_DIR, f"{month}.json")
    with open(out_path, 'w') as f:
        json.dump(month_tracks, f, separators=(',', ':'))
    kb = os.path.getsize(out_path) / 1024
    total_kb += kb
    print(f"  data/{month}.json — {len(month_tracks)} track(s), {kb:.1f} KB")

# Write manifest
with open(os.path.join(FOLDER, 'tracks.json'), 'w') as f:
    json.dump(manifest, f, indent=2)

print(f"\n{len(manifest)} tracks → {len(by_month)} monthly files, "
      f"{total_kb:.0f} KB total ({skipped} skipped)")
print("Done — commit the data/ folder and tracks.json.")
