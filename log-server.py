#!/usr/bin/env python3
"""
Local log collector for the Coupon Tester Chrome extension.
Listens on http://localhost:7777/log — accepts POST with JSON body.
Writes structured logs to extension.log in this directory.
"""

import json
import logging
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG_FILE = "extension.log"
PORT = 7777

file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
file_handler.setFormatter(logging.Formatter("%(message)s"))
stdout_handler = logging.StreamHandler(sys.stdout)
stdout_handler.setFormatter(logging.Formatter("%(message)s"))

logger = logging.getLogger("ext")
logger.setLevel(logging.DEBUG)
logger.addHandler(file_handler)
logger.addHandler(stdout_handler)


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._cors()
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path != "/log":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {"raw": body.decode(errors="replace")}

        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        source = data.get("source", "?")
        level  = data.get("level", "log").upper()
        msg    = data.get("message", "")
        extra  = data.get("data", None)

        line = f"[{ts}] [{source}] [{level}] {msg}"
        if extra:
            line += f"\n  {json.dumps(extra, ensure_ascii=False)}"
        logger.info(line)

        self._cors()
        self.send_response(204)
        self.end_headers()

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def log_message(self, *_):
        pass  # suppress HTTP access log noise


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[log-server] Listening on http://localhost:{PORT}/log")
    print(f"[log-server] Writing to {LOG_FILE}")
    print("[log-server] Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[log-server] Stopped.")
