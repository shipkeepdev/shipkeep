# Built by real_samples_test.go with Railpack and Nixpacks (ADR 0030).
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Greeting(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"{os.environ.get('GREETING', 'hello')} from the shipkeep build test\n".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("", int(os.environ.get("PORT", "3000"))), Greeting).serve_forever()
