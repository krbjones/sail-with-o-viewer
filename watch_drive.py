#!/usr/bin/env python3
"""
watch_drive.py — Publish new tracks dropped in the Google Drive folder.

    python watch_drive.py                 # watch forever
    python watch_drive.py --once          # one pass, then exit
    python watch_drive.py --dry-run       # report what it would do, change nothing
    python watch_drive.py --no-push       # commit locally but do not push

Watches the Drive for Desktop folder, copies genuinely new GPX files into the
repo, runs the build scripts, commits and pushes. Google Pages picks it up from
there.

Polling rather than filesystem events, deliberately: no dependency to install,
and it sidesteps the odd event sequences Drive produces while materialising a
file. Thirty seconds is irrelevant for a track uploaded after sailing, and if
the machine is off the files simply queue until it next starts.
"""

import os, re, sys, json, time, shutil, subprocess
from datetime import datetime
from xml.etree import ElementTree as ET

FOLDER    = os.path.dirname(os.path.abspath(__file__))
MANIFEST  = os.path.join(FOLDER, 'tracks.json')
IGNORE    = os.path.join(FOLDER, 'ingest_ignore.txt')
LOG_PATH  = os.path.join(FOLDER, 'watch_drive.log')

WATCH_DIR = r'G:\My Drive\Sailing_Geospatial_Data_KevinJONES'

POLL_SECONDS  = 30
# Size and mtime must be unchanged this many polls running before a file is
# touched. Drive can list a file before it has finished syncing, and parsing a
# half-written one throws it away as malformed — possibly for good, since it
# then looks like it has already been seen.
SETTLE_POLLS  = 2

# Only these are ever staged. Never `git add -A`, or an unattended commit will
# sweep up whatever happens to be open in the editor.
STAGE_PATHS   = ['data', 'tracks.json']


# ── Logging ───────────────────────────────────────────────────────

def log(message):
    line = f'{datetime.now():%Y-%m-%d %H:%M:%S}  {message}'
    print(line, flush=True)
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


# ── Identity ──────────────────────────────────────────────────────

def first_time_ms(path):
    """
    Epoch ms of the first track point. This is a track's real identity — the
    filename is not: the same sail has already appeared in Drive under two
    different names, and the naming convention has changed three times.
    """
    try:
        for _event, elem in ET.iterparse(path, events=('end',)):
            if elem.tag.split('}')[-1] != 'time' or not elem.text:
                continue
            try:
                t = elem.text.strip().replace(' ', 'T')
                if not t.endswith('Z'):
                    t += 'Z'
                return int(datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp() * 1000)
            except ValueError:
                continue
    except (ET.ParseError, OSError):
        return None
    return None


def known_start_times():
    """Start times already in the archive, so a renamed track is not re-added."""
    try:
        with open(MANIFEST, encoding='utf-8') as f:
            doc = json.load(f)
        tracks = doc['tracks'] if isinstance(doc, dict) else doc
        return {t['startMs']: t['file'] for t in tracks}
    except (OSError, json.JSONDecodeError, KeyError):
        return {}


def ignored_entries():
    """Filenames or start times deliberately kept out, one per line, # comments."""
    names, starts = set(), set()
    try:
        with open(IGNORE, encoding='utf-8') as f:
            for line in f:
                line = line.split('#', 1)[0].strip()
                if not line:
                    continue
                if re.fullmatch(r'\d{10,}', line):
                    starts.add(int(line))
                else:
                    names.add(line)
    except OSError:
        pass
    return names, starts


# ── Scanning ──────────────────────────────────────────────────────

def stable_files(seen):
    """
    GPX files whose size and mtime have held steady for SETTLE_POLLS.
    `seen` carries state between polls and is updated in place.
    """
    ready = []
    current = {}

    try:
        entries = os.listdir(WATCH_DIR)
    except OSError as e:
        log(f'Cannot read {WATCH_DIR}: {e}')
        return []

    for name in entries:
        if not name.lower().endswith('.gpx'):
            continue
        path = os.path.join(WATCH_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue                      # vanished mid-scan, or still a placeholder
        if st.st_size == 0:
            continue

        sig = (st.st_size, int(st.st_mtime))
        prev_sig, count = seen.get(name, (None, 0))
        count = count + 1 if sig == prev_sig else 1
        current[name] = (sig, count)

        if count >= SETTLE_POLLS:
            ready.append(name)

    seen.clear()
    seen.update(current)
    return sorted(ready)


def classify(names):
    """Split candidates into (to_ingest, [(name, reason_skipped)])."""
    known   = known_start_times()
    ig_names, ig_starts = ignored_entries()

    ingest, skipped = [], []
    for name in names:
        if os.path.exists(os.path.join(FOLDER, name)):
            continue                      # already published; the quiet common case
        if name in ig_names:
            skipped.append((name, 'listed in ingest_ignore.txt'))
            continue

        src = os.path.join(WATCH_DIR, name)
        start = first_time_ms(src)
        if start is None:
            skipped.append((name, 'no readable timestamp inside the file'))
            continue
        if start in ig_starts:
            skipped.append((name, 'start time listed in ingest_ignore.txt'))
            continue
        if start in known:
            skipped.append((name, f'same start time as {known[start]} — a rename, not a new track'))
            continue

        ingest.append((name, start))

    return ingest, skipped


# ── Git ───────────────────────────────────────────────────────────

def git(*args, check=True):
    return subprocess.run(['git', *args], cwd=FOLDER, check=check,
                          capture_output=True, text=True)


def tree_is_clean_enough():
    """
    Refuse to commit alongside unrelated edits. A watcher that commits whatever
    it finds will eventually publish someone's half-finished work.
    """
    out = git('status', '--porcelain').stdout.strip()
    if not out:
        return True, []
    dirty = []
    for line in out.splitlines():
        path = line[3:].strip().strip('"')
        top = path.split('/')[0]
        if top in STAGE_PATHS or path.lower().endswith('.gpx') or path == os.path.basename(LOG_PATH):
            continue
        dirty.append(path)
    return not dirty, dirty


def publish(new_names, push):
    git('add', '--', *STAGE_PATHS, *new_names)

    if not git('diff', '--cached', '--name-only').stdout.strip():
        log('  nothing staged after the build; no commit')
        return

    subject = (f'Add track {new_names[0]}' if len(new_names) == 1
               else f'Add {len(new_names)} tracks')
    body = 'Ingested automatically from the Drive folder by watch_drive.py.\n\n' \
           + '\n'.join(f'  {n}' for n in new_names)
    git('commit', '-m', subject, '-m', body)
    log(f'  committed: {subject}')

    if not push:
        log('  --no-push, leaving it local')
        return

    try:
        git('pull', '--rebase')
        git('push')
        log('  pushed')
    except subprocess.CalledProcessError as e:
        # Offline, or the remote moved in a way rebase could not resolve. The
        # commit is safe locally; try again next cycle.
        log(f'  push failed, will retry next cycle: {(e.stderr or "").strip().splitlines()[-1:] or e}')


# ── Build ─────────────────────────────────────────────────────────

def run_build(script, args=(), required=True):
    log(f'  running {script} {" ".join(args)}'.rstrip())
    try:
        r = subprocess.run([sys.executable, script, *args], cwd=FOLDER,
                           capture_output=True, text=True, timeout=3600)
    except subprocess.TimeoutExpired:
        log(f'  {script} timed out')
        return False
    if r.returncode != 0:
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        log(f'  {script} failed{" (blocking)" if required else " (continuing)"}: {" / ".join(tail)}')
        return False
    return True


# ── One pass ──────────────────────────────────────────────────────

def pass_once(seen, dry_run, push):
    ready = stable_files(seen)
    if not ready:
        return

    ingest, skipped = classify(ready)

    for name, reason in skipped:
        log(f'skip {name}: {reason}')

    if not ingest:
        return

    for name, start in ingest:
        when = datetime.fromtimestamp(start / 1000).strftime('%Y-%m-%d %H:%M')
        log(f'new track {name} (starts {when} local)')

    if dry_run:
        log('  --dry-run, stopping here')
        return

    clean, dirty = tree_is_clean_enough()
    if not clean:
        log(f'  working tree has unrelated changes, refusing to commit: {", ".join(dirty[:5])}')
        return

    names = []
    for name, _start in ingest:
        shutil.copy2(os.path.join(WATCH_DIR, name), os.path.join(FOLDER, name))
        names.append(name)
        log(f'  copied into the repo')

    if not run_build('build_tracks.py', ['--skip-existing']):
        log('  build_tracks failed; leaving the copied file in place for a retry')
        return

    # Best effort from here: a network blip must not stop a track being published.
    run_build('build_wind.py', required=False)
    run_build('build_races.py', required=False)

    publish(names, push)


def main():
    global WATCH_DIR
    dry_run = '--dry-run' in sys.argv
    once    = '--once' in sys.argv
    push    = '--no-push' not in sys.argv

    # Handy for testing against a scratch folder, and for the day Drive comes
    # back on a different drive letter.
    if '--folder' in sys.argv:
        WATCH_DIR = sys.argv[sys.argv.index('--folder') + 1]

    if not os.path.isdir(WATCH_DIR):
        sys.exit(f'Watch folder not found: {WATCH_DIR}\n'
                 'Is Google Drive for Desktop running and the folder synced?')

    log(f'watching {WATCH_DIR}' + (' (dry run)' if dry_run else '')
        + (' (single pass)' if once else f', every {POLL_SECONDS}s'))

    seen = {}
    if once:
        # Nothing has been observed yet, so prime the settle state and look again.
        stable_files(seen)
        pass_once(seen, dry_run, push)
        return

    while True:
        try:
            pass_once(seen, dry_run, push)
        except KeyboardInterrupt:
            log('stopped')
            return
        except Exception as e:                      # keep watching whatever happens
            log(f'unexpected error, continuing: {type(e).__name__}: {e}')
        time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    main()
