#!/usr/bin/env python3
"""
build_races.py — Pull race results from the club's Sailwave page.

    python build_races.py                  # fetch the live results
    python build_races.py --file page.htm  # parse a saved copy instead

Writes data/races.json: one entry per race with the official start and finish
times, the whole fleet's elapsed and corrected times, and the race committee's
own wind observation. The start and finish are what matter most — a recorded
track is typically two to three hours of which only forty minutes is the race,
so without them every statistic is computed over the wrong window.

This parses someone else's HTML, which can change without warning. It therefore
validates what it finds and exits non-zero on anything unexpected rather than
quietly writing a half-empty file: a debrief built on silently missing races is
worse than no debrief.
"""

import os, re, sys, json, html, urllib.request
from datetime import datetime, timezone

FOLDER   = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(FOLDER, 'data')
OUT_PATH = os.path.join(DATA_DIR, 'races.json')

RESULTS_URL = 'https://nsc.ca/nsc_racing/results/2026/jam/summer_series.htm'

# The boat to centre the debrief on.
OUR_BOAT = 'O'

# Columns a Sailwave per-race table must have for this to be a race table.
RACE_COLUMNS = ['Rank', 'Boat Name', 'Sail #', 'PHRF', 'Start', 'Finish',
                'Elapsed', 'Corrected', 'BCE', 'Points']

MONTHS = {m: i + 1 for i, m in enumerate(
    ['January', 'February', 'March', 'April', 'May', 'June',
     'July', 'August', 'September', 'October', 'November', 'December'])}


# ── HTML ──────────────────────────────────────────────────────────

def text_of(fragment):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', fragment))).strip()


def cells(row):
    return [text_of(c) for c in re.findall(r'(?is)<t[dh][^>]*>(.*?)</t[dh]>', row)]


def parse_seconds(clock):
    """'0:54:29' or '19:28:12' to seconds, or None."""
    if not clock or not re.fullmatch(r'\d{1,2}:\d{2}:\d{2}', clock):
        return None
    h, m, s = (int(x) for x in clock.split(':'))
    return h * 3600 + m * 60 + s


def parse_start(raw):
    """Sailwave writes the gun as a bare '1837'."""
    m = re.fullmatch(r'(\d{1,2})(\d{2})', raw.strip())
    return (int(m.group(1)) * 3600 + int(m.group(2)) * 60) if m else None


# ── Parsing ───────────────────────────────────────────────────────

RACE_HEADING = re.compile(
    r'Race\s+(\d+)\s*-\s*(\w+)\s+Fleet\s*-\s*([A-Za-z]+)\s+(\d+)', re.I)


def parse_page(doc):
    """[{race, fleet, date, startSeconds, course, windDir, windSpeed, boats:[...]}]"""
    year_match = re.search(r'Summer Series\s+(\d{4})', doc)
    if not year_match:
        sys.exit('Could not find the series year on the page; the layout has changed.')
    year = int(year_match.group(1))

    # Each race table is preceded by a heading naming the race, fleet and date.
    chunks = re.split(r'(?is)(<table.*?</table>)', doc)
    races  = []
    pending = None

    for chunk in chunks:
        if not chunk.lower().startswith('<table'):
            pending = text_of(chunk)
            continue

        rows = re.findall(r'(?is)<tr.*?</tr>', chunk)
        if len(rows) < 2:
            continue
        header = cells(rows[0])
        if not all(col in header for col in RACE_COLUMNS):
            continue          # a series-summary table, not a race

        heading = RACE_HEADING.search(pending or '')
        if not heading:
            sys.exit('Found a race table with no "Race N - X Fleet - Month D" heading '
                     'before it; the layout has changed.')

        race_no, fleet, month_name, day = heading.groups()
        if month_name.capitalize() not in MONTHS:
            sys.exit(f'Unrecognised month "{month_name}" in a race heading.')
        date = f'{year}-{MONTHS[month_name.capitalize()]:02d}-{int(day):02d}'

        col = {name: i for i, name in enumerate(header)}
        boats = []
        for row in rows[1:]:
            c = cells(row)
            if len(c) < len(header):
                continue
            name = c[col['Boat Name']]
            if not name:
                continue
            boats.append({
                'rank':      c[col['Rank']],
                'name':      name,
                'type':      c[col['Boat Type']] if 'Boat Type' in col else '',
                'sail':      c[col['Sail #']],
                'helm':      c[col['Helm']] if 'Helm' in col else '',
                'phrf':      c[col['PHRF']],
                'finish':    c[col['Finish']],
                'elapsed':   parse_seconds(c[col['Elapsed']]),
                'corrected': parse_seconds(c[col['Corrected']]),
                'bce':       parse_seconds(c[col['BCE']]),
                'points':    c[col['Points']],
            })

        meta = pending or ''
        races.append({
            'race':      int(race_no),
            'fleet':     fleet.upper(),
            'date':      date,
            'start':     parse_start(_field(meta, 'Time')),
            'course':    _field(meta, 'Course'),
            'windDir':   _field(meta, 'Wind dir'),
            'windSpeed': _field(meta, 'Ave wind'),
            'boats':     boats,
        })

    return races


def _field(meta, label):
    m = re.search(rf'{label}:\s*([^,]+)', meta, re.I)
    return m.group(1).strip() if m else ''


# ── Main ──────────────────────────────────────────────────────────

def main():
    if '--file' in sys.argv:
        path = sys.argv[sys.argv.index('--file') + 1]
        print(f'Reading {path}')
        doc = open(path, encoding='utf-8', errors='replace').read()
    else:
        print(f'Fetching {RESULTS_URL}')
        try:
            with urllib.request.urlopen(RESULTS_URL, timeout=60) as r:
                doc = r.read().decode('utf-8', errors='replace')
        except Exception as e:
            sys.exit(f'Could not fetch the results page: {e}')

    races = parse_page(doc)
    if not races:
        sys.exit('No race tables found. The club page layout has probably changed — '
                 'rerun with --file on a saved copy to see what came back.')

    ours = [r for r in races if any(b['name'] == OUR_BOAT for b in r['boats'])]
    if not ours:
        sys.exit(f'Parsed {len(races)} races but none included a boat called "{OUR_BOAT}".')

    print(f'\n{len(races)} race table(s), {len(ours)} featuring "{OUR_BOAT}":\n')
    for r in sorted(ours, key=lambda r: r['date']):
        us = next(b for b in r['boats'] if b['name'] == OUR_BOAT)
        finishers = [b for b in r['boats'] if b['elapsed'] is not None]
        print(f"  {r['date']}  Race {r['race']} {r['fleet']} Fleet  "
              f"start {r['start']//3600:02d}:{r['start']%3600//60:02d}  "
              f"wind {r['windDir']} {r['windSpeed']}")
        print(f"     {OUR_BOAT}: {us['rank']} of {len(finishers)} scored  "
              f"elapsed {fmt(us['elapsed'])}  corrected {fmt(us['corrected'])}  "
              f"needed {fmt(us['bce'])} faster")

    os.makedirs(DATA_DIR, exist_ok=True)
    doc_out = {
        'source':  RESULTS_URL,
        'fetched': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'boat':    OUR_BOAT,
        'races':   sorted(races, key=lambda r: (r['date'], r['fleet'])),
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(doc_out, f, indent=1)

    print(f'\ndata/races.json - {len(races)} race(s), {os.path.getsize(OUT_PATH)/1024:.1f} KB')
    print('Done - commit data/races.json.')


def fmt(seconds):
    if seconds is None:
        return '--'
    return f'{seconds//3600}:{seconds%3600//60:02d}:{seconds%60:02d}' if seconds >= 3600 \
        else f'{seconds//60}:{seconds%60:02d}'


if __name__ == '__main__':
    main()
