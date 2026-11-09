"""Entry point: serve the static HTML front end."""

import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import mpivr20_cms as cms
from introduce import Introduce


def main() -> None:
    """Serve the static folder until Ctrl+C."""
    sys.stdout.reconfigure(encoding="utf-8")
    info = Introduce()
    print(f"[main] {info.program} {info.version}")
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(cms.STATIC_DIR))
    server = ThreadingHTTPServer((cms.HOST, cms.PORT), handler)
    print(f"[main] 本機：http://localhost:{cms.PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[main] 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
