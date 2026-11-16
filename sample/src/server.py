"""Runtime server. It imports the log reader."""

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from logview import read_log


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, "ok")
            return
        if parsed.path == "/log":
            name = parse_qs(parsed.query).get("name", ["app.log"])[0]
            if ".." in name.replace("\\", "/").split("/"):
                self._send(400, "path escapes the log root")
                return
            try:
                body = read_log(name)
            except Exception as exc:
                self._send(400, str(exc))
                return
            self._send(200, body)
            return
        self._send(404, "not found")

    def _send(self, status: int, body: str) -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
