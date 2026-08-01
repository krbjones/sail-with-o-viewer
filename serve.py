#!/usr/bin/env python3
"""
serve.py — Local development server.

    python serve.py [port]      # defaults to 8080

Plain `python -m http.server` sends no cache headers, and browsers cache ES
modules aggressively: edit a file under js/, reload, and the old module is
still running. This serves source files with no-store so a reload always
picks up the edit, while leaving the large track bundles cacheable so a page
refresh does not redownload 80 MB.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Suffixes that are edited during development and must never be cached.
NO_CACHE_SUFFIXES = ('.js', '.css', '.html', '.json', '.webmanifest')


class DevHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split('?', 1)[0]

        # data/*.json are large and only change when build_tracks.py runs, so
        # they keep a short cache. Everything else source-like is no-store.
        if path.startswith('/data/'):
            self.send_header('Cache-Control', 'max-age=60')
        elif path.endswith(NO_CACHE_SUFFIXES) or path.endswith('/'):
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')

        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is enough; skip the timestamp noise.
        sys.stderr.write('%s %s\n' % (self.command, self.path.split('?', 1)[0]))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(DevHandler, directory='.')
    server = ThreadingHTTPServer(('127.0.0.1', port), handler)
    print(f'Serving http://127.0.0.1:{port}/  (Ctrl-C to stop)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
