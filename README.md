# sail-with-o-viewer

Sailing tracks visualization — a Leaflet map of GPX tracks coloured by speed,
with animated playback, a nautical chart overlay and per-track statistics.

## Running it

The app fetches `data/`, so it needs a server — `file://` will not work.

```bash
python serve.py
```

Then open <http://127.0.0.1:8080>. `serve.py` sends `no-store` for source files
so an edit under `js/` shows up on reload; `python -m http.server` does not, and
browsers cache ES modules aggressively.

## Adding tracks

Drop GPX files onto the sidebar and they are parsed in the browser and stored in
IndexedDB. That is per-browser only.

To publish tracks for everyone, put the `.gpx` files in this folder and rebuild:

```bash
python build_tracks.py
```

Then commit `data/` and `tracks.json`. `--skip-existing` reuses tracks already
in a bundle and only parses new ones.

The build rejects duplicate timestamps and GPS glitches (a fix both more than
50 m away and implying more than 25 kt), and where the log genuinely breaks it
keeps the position without inventing a speed across the gap.

## Wind

`data/wind.json` holds hourly wind for the hours the tracks actually cover —
1,095 hours across 8 sailing areas in 33 KB. Rebuild it after adding tracks:

```bash
python build_wind.py
```

Re-runs fetch only what is missing; `--force` refetches everything. The source
is the [Open-Meteo archive](https://open-meteo.com/en/docs/historical-weather-api)
(ERA5), which needs no API key.

It drives the wind readout on the map, the point-of-sail colouring, the
speed-versus-wind-angle polar in the stats panel, and the animated wind field
(the **🌬 Wind field** overlay in the layers control). All of it is optional —
with `data/wind.json` absent the app behaves exactly as it did before.

Two deliberate limits: wind covers **2025 onward only**, and the grid that
feeds the particle animation is built only for areas a North American model
serves, so UK tracks get a point reading but no field. Both are set near the
top of `build_wind.py` (`WIND_FROM`, `GRID_MODELS`).

Models are tried finest-first and the first with data wins — HRDPS 2.5 km,
then HRRR 3 km, then ICON-D2 2 km for Europe, with ERA5 at 25 km as a last
resort. The UI names whichever ones actually supplied the data.

**These are forecast models, not observations.** At 2.5 km nothing smaller
than about 5 km is resolved, so lake thermals and shoreline effects are
invisible and the hourly figures are means, not gusts. Treat the angles as
indicative. For observed wind, Environment Canada publishes free hourly station
data and Ottawa Airport is about 12 km from Lac Deschênes.

The particle animation is not scaled to ground speed — at this zoom real wind
would be imperceptible. It shows direction and relative strength.

## Layout

```
index.html          markup only
serve.py            dev server
build_tracks.py     GPX -> data/YYYY-MM.json + tracks.json
build_wind.py       tracks.json -> data/wind.json
css/                one file per area, plus responsive.css
js/
  config.js         constants
  core/             geo, formatting, state, DOM helpers, preferences
  data/             IndexedDB, manifest, loading, GPX parsing, URL state
  map/              map setup, basemaps, chart overlay, track and marker rendering
  ui/               sidebar, track list, filters, playback, stats, import, drawer
```

Native ES modules — no bundler, no npm, no build step. It deploys to GitHub
Pages exactly as it stands.

## Data

`tracks.json` is the manifest: per-track times, bounding box and statistics
(distance, max and average speed, moving time), plus a content hash per month.
It is small enough to browse and sort every track without loading any point
data. The hashes let the browser cache month bundles in IndexedDB and refetch
only what actually changed.
