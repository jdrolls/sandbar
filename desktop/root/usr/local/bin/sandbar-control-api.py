#!/usr/bin/env python3
"""Small, dependency-free HTTP control surface for a Sandbar desktop.

This service intentionally has no authentication fallback: setting SANDBAR_TOKEN is
required before any computer-control endpoint can be used.
"""

import base64
import hmac
import json
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


DISPLAY = ":1"
MAX_BODY_BYTES = 1_024 * 1_024
MAX_OUTPUT_BYTES = 100 * 1_024
KEY_RE = re.compile(r"^[A-Za-z0-9_+]+$")
SCREENSHOT_PATH = "/tmp/.sandbar-shot.png"
SCREENSHOT_LOCK = threading.Lock()
CAPABILITIES = ["screenshot", "click", "type", "key", "scroll", "bash"]
UI_PATH = "/usr/local/share/sandbar-ui/index.html"


class APIError(Exception):
    """An error that can safely be returned to an API client."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def command_environment():
    """Keep GUI commands on Webtop's display even if the service env changes."""
    environment = os.environ.copy()
    environment["DISPLAY"] = DISPLAY
    return environment


def text_from_output(value):
    """Normalize subprocess output and cap it before it reaches a response."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    encoded = value.encode("utf-8")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return value
    return encoded[:MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore") + "\n[truncated]"


def run_gui_command(argv, timeout=15):
    """Run a fixed GUI command without ever involving a shell."""
    try:
        completed = subprocess.run(
            argv,
            env=command_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise APIError(504, "Desktop command timed out.") from error
    except OSError as error:
        raise APIError(500, "Desktop command could not start: %s" % error) from error

    if completed.returncode != 0:
        detail = text_from_output(completed.stderr).strip()
        message = "Desktop command failed."
        if detail:
            message += " " + detail
        raise APIError(500, message)
    return completed


def require_int(body, name, minimum=None, maximum=None):
    """Return an actual JSON integer (bool is deliberately not accepted)."""
    value = body.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise APIError(400, '"%s" must be an integer.' % name)
    if minimum is not None and value < minimum:
        raise APIError(400, '"%s" must be at least %d.' % (name, minimum))
    if maximum is not None and value > maximum:
        raise APIError(400, '"%s" must be at most %d.' % (name, maximum))
    return value


class SandbarControlHandler(BaseHTTPRequestHandler):
    """Routes public status/UI requests and authenticated control requests."""

    server_version = "SandbarControl/1.0"

    def log_message(self, format, *args):
        # Avoid default request logging; it adds noise and can reveal request paths.
        return

    def send_json(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, status, message):
        self.send_json(status, {"error": message})

    def endpoint(self):
        # Query parameters are intentionally not part of this small control API.
        return urlparse(self.path).path

    def authorized(self):
        token = os.environ.get("SANDBAR_TOKEN")
        if not token:
            self.send_error_json(
                403,
                "Control API is disabled. Set SANDBAR_TOKEN to enable it.",
            )
            return False

        authorization = self.headers.get("Authorization", "")
        prefix = "Bearer "
        supplied = authorization[len(prefix):] if authorization.startswith(prefix) else ""
        if not supplied or not hmac.compare_digest(supplied, token):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer realm="sandbar-control"')
            self.send_header("Content-Type", "application/json; charset=utf-8")
            data = json.dumps({"error": "Unauthorized."}, separators=(",", ":")).encode("utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return False
        return True

    def read_json_body(self):
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise APIError(411, "Content-Length is required.")
        try:
            length = int(length_header)
        except ValueError as error:
            raise APIError(400, "Invalid Content-Length.") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise APIError(413, "Request body is too large.")

        raw = self.rfile.read(length)
        if len(raw) != length:
            raise APIError(400, "Incomplete request body.")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise APIError(400, "Request body must be valid JSON.") from error
        if not isinstance(body, dict):
            raise APIError(400, "Request body must be a JSON object.")
        return body

    def do_GET(self):
        path = self.endpoint()
        if path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        if path in ("/", "/ui"):
            self.handle_ui()
            return
        if not self.authorized():
            return

        try:
            if path == "/info":
                self.handle_info()
            elif path == "/screenshot":
                self.handle_screenshot()
            else:
                raise APIError(404, "Not found.")
        except APIError as error:
            self.send_error_json(error.status, error.message)

    def do_POST(self):
        if not self.authorized():
            return
        try:
            body = self.read_json_body()
            path = self.endpoint()
            if path == "/click":
                self.handle_click(body)
            elif path == "/type":
                self.handle_type(body)
            elif path == "/key":
                self.handle_key(body)
            elif path == "/scroll":
                self.handle_scroll(body)
            elif path == "/bash":
                self.handle_bash(body)
            else:
                raise APIError(404, "Not found.")
        except APIError as error:
            self.send_error_json(error.status, error.message)

    def handle_ui(self):
        """Serve the editable container-side UI without exposing control endpoints."""
        try:
            with open(UI_PATH, "rb") as ui_file:
                data = ui_file.read()
        except FileNotFoundError:
            self.send_error_json(404, "Sandbar UI is not installed.")
            return
        except OSError as error:
            self.send_error_json(500, "Sandbar UI could not be read: %s" % error)
            return
        self.send_html(200, data)

    def handle_info(self):
        geometry = run_gui_command(["xdotool", "getdisplaygeometry"]).stdout.strip().split()
        if len(geometry) != 2 or not all(value.isdigit() and int(value) > 0 for value in geometry):
            raise APIError(500, "Desktop returned an invalid display geometry.")
        try:
            with open("/etc/sandbar/hermes-version", encoding="utf-8") as version_file:
                hermes_version = version_file.read(4096).strip()
        except OSError as error:
            raise APIError(500, "Hermes version is unavailable.") from error
        if not hermes_version:
            raise APIError(500, "Hermes version is unavailable.")

        self.send_json(
            200,
            {
                "display": DISPLAY,
                "resolution": {"width": int(geometry[0]), "height": int(geometry[1])},
                "hermes_version": hermes_version,
                "capabilities": CAPABILITIES,
            },
        )

    def handle_screenshot(self):
        # A fixed path is required by the image contract, so serialize capture/read pairs.
        with SCREENSHOT_LOCK:
            run_gui_command(["scrot", "-o", SCREENSHOT_PATH], timeout=30)
            try:
                with open(SCREENSHOT_PATH, "rb") as screenshot:
                    image = screenshot.read()
            except OSError as error:
                raise APIError(500, "Screenshot could not be read.") from error
        if not image:
            raise APIError(500, "Screenshot was empty.")
        self.send_json(200, {"image": base64.b64encode(image).decode("ascii"), "format": "png"})

    def handle_click(self, body):
        x = require_int(body, "x")
        y = require_int(body, "y")
        button = body.get("button")
        buttons = {"left": "1", "right": "3", "double": "1"}
        if button not in buttons:
            raise APIError(400, '"button" must be "left", "right", or "double".')
        run_gui_command(["xdotool", "mousemove", str(x), str(y)])
        if button == "double":
            run_gui_command(["xdotool", "click", "--repeat", "2", "1"])
        else:
            run_gui_command(["xdotool", "click", buttons[button]])
        self.send_json(200, {"status": "ok"})

    def handle_type(self, body):
        text = body.get("text")
        if not isinstance(text, str):
            raise APIError(400, '"text" must be a string.')
        run_gui_command(["xdotool", "type", "--delay", "12", "--", text])
        self.send_json(200, {"status": "ok"})

    def handle_key(self, body):
        key = body.get("key")
        if not isinstance(key, str) or not KEY_RE.fullmatch(key):
            raise APIError(400, '"key" must match ^[A-Za-z0-9_+]+$.')
        run_gui_command(["xdotool", "key", "--", key])
        self.send_json(200, {"status": "ok"})

    def handle_scroll(self, body):
        x = require_int(body, "x")
        y = require_int(body, "y")
        amount = require_int(body, "amount", minimum=1, maximum=10)
        direction = body.get("direction")
        buttons = {"up": "4", "down": "5"}
        if direction not in buttons:
            raise APIError(400, '"direction" must be "up" or "down".')
        run_gui_command(["xdotool", "mousemove", str(x), str(y)])
        run_gui_command(["xdotool", "click", "--repeat", str(amount), buttons[direction]])
        self.send_json(200, {"status": "ok"})

    def handle_bash(self, body):
        command = body.get("command")
        if not isinstance(command, str):
            raise APIError(400, '"command" must be a string.')
        timeout = require_int(body, "timeout", minimum=1, maximum=120)
        try:
            completed = subprocess.run(
                ["bash", "-lc", command],
                env=command_environment(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout,
                check=False,
            )
            self.send_json(
                200,
                {
                    "stdout": text_from_output(completed.stdout),
                    "stderr": text_from_output(completed.stderr),
                    "exit_code": completed.returncode,
                },
            )
        except subprocess.TimeoutExpired as error:
            stderr = text_from_output(error.stderr)
            if stderr:
                stderr += "\n"
            stderr += "Command timed out after %d seconds." % timeout
            self.send_json(
                200,
                {
                    "stdout": text_from_output(error.stdout),
                    "stderr": text_from_output(stderr),
                    "exit_code": 124,
                },
            )
        except OSError as error:
            raise APIError(500, "Bash command could not start: %s" % error) from error


def main():
    # Threading permits a slow screenshot or bash request without blocking /health.
    server = ThreadingHTTPServer(("0.0.0.0", 8080), SandbarControlHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
