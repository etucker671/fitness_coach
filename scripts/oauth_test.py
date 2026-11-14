#!/usr/bin/env python3
"""End-to-end check of the OAuth sign-in on the Worker, the way an app like Claude does it.

Usage (needs `wrangler dev` running, or pass the live URL):
    python3 scripts/oauth_test.py [base_url]            # automatic: the script fills in the password
    python3 scripts/oauth_test.py [base_url] --browser  # you sign in yourself in your browser

The owner password is read from the OWNER_PASSWORD environment variable, or asked for
(hidden) if that is not set. It is never taken as an argument, so it stays out of shell history.

Steps: register a client -> PKCE -> /authorize (wrong password, then right) -> code ->
token -> /mcp tools/list -> refresh -> /mcp again -> reuse the code (must fail and
cancel the sign-in) -> /mcp with the cancelled token (must fail).
Stdlib only. Each run registers a new client; registrations expire after 90 days.
"""
import base64
import getpass
import hashlib
import http.server
import json
import os
import re
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BROWSER = "--browser" in sys.argv
BASE = (args[0] if args else "http://localhost:8799").rstrip("/")
CALLBACK_PORT = 8765
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}/callback"
TIMEOUT = 30

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")
    return ok


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # we want to see the 302 ourselves, not follow it


_opener = urllib.request.build_opener(_NoRedirect)


def call(method, path, body=None, headers=None, form=None):
    """Returns (status, headers, text). `form` sends application/x-www-form-urlencoded."""
    headers = dict(headers or {})
    if form is not None:
        body = urllib.parse.urlencode(form, doseq=True).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None and not isinstance(body, bytes):
        body = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers)
    try:
        resp = _opener.open(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        resp = e
    return resp.status, resp.headers, resp.read().decode()


def mcp_tools_list(token):
    status, _, text = call(
        "POST", "/mcp",
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"},
    )
    return status, len(re.findall(r'"name":"', text))


def code_from_redirect(location):
    return urllib.parse.parse_qs(urllib.parse.urlparse(location).query).get("code", [None])[0]


def sign_in_automatically(query):
    """Does what your browser would: load the page, post the form, read the redirect."""
    password = os.environ.get("OWNER_PASSWORD") or getpass.getpass("Owner password: ")
    status, headers, page = call("GET", "/authorize?" + query)
    check("sign-in page loads", status == 200, status)
    check("client-supplied name is escaped", "&#60;script&#62;" in page and "<script>" not in page)

    # The page's one-time handle only works together with the cookie it set
    # (so a form can't be forged from another site). A browser does this for us.
    cookie = "; ".join(v.split(";")[0] for k, v in headers.items() if k.lower() == "set-cookie")
    m = re.search(r'name="handle" value="([^"]+)"', page)
    if not check("page contains the one-time handle", m is not None):
        return None
    handle = m.group(1)

    def submit(pw):
        return call("POST", "/authorize", headers={"Cookie": cookie},
                    form={"handle": handle, "password": pw, "decision": "approve"})

    status, _, _ = submit("definitely-not-the-password")
    check("wrong password is refused (401)", status == 401, status)

    status, headers, _ = submit(password)
    location = headers.get("Location", "")
    check("right password redirects back to the app (302)", status == 302 and location.startswith(REDIRECT_URI),
          f"{status} {location[:80]}")
    return code_from_redirect(location)


def sign_in_with_browser(query):
    """Opens the real page in your browser and catches the redirect on a tiny local server,
    exactly like a desktop app would."""
    result = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result.update({k: v[0] for k, v in params.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Got it. You can close this tab and go back to the terminal.")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("localhost", CALLBACK_PORT), Callback)
    thread = threading.Thread(target=server.handle_request)  # handle exactly one request
    thread.start()
    url = f"{BASE}/authorize?{query}"
    print(f"\n  Opening your browser. If it does not open, visit:\n  {url}\n")
    webbrowser.open(url)
    print("  Waiting for you to click Allow or Deny...")
    thread.join(timeout=300)
    server.server_close()
    if "error" in result:
        check("sign-in approved", False, result["error"])
        return None
    print(f"  The browser was sent to {REDIRECT_URI}?code=...")
    return result.get("code")


def main():
    print(f"OAuth test against {BASE}  ({'browser' if BROWSER else 'automatic'} mode)\n")

    # 1. Discovery: what an app reads first, after /mcp answers 401.
    status, headers, _ = call("POST", "/mcp")
    check("/mcp without a token is 401 with a resource_metadata pointer",
          status == 401 and "resource_metadata=" in headers.get("WWW-Authenticate", ""), status)
    status, _, text = call("GET", "/.well-known/oauth-authorization-server")
    check("authorization server metadata is published", status == 200 and "token_endpoint" in text, status)

    # 2. Dynamic client registration: the app introduces itself.
    status, _, text = call("POST", "/oauth/register", {
        "client_name": "oauth_test.py <script>",  # the <script> checks the page escapes it
        "redirect_uris": [REDIRECT_URI],
        "token_endpoint_auth_method": "none",  # a "public" app with no client secret, like a phone app
    })
    if not check("client registers (201)", status == 201, f"{status} {text[:200]}"):
        return
    client_id = json.loads(text)["client_id"]

    # 3. PKCE: a random verifier we keep, and its hash (the challenge) we send now.
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": secrets.token_urlsafe(8),
        "scope": "fitness",
        "resource": f"{BASE}/mcp",
    })

    # 4. Sign in and get the one-time code.
    code = sign_in_with_browser(query) if BROWSER else sign_in_automatically(query)
    if not check("received a one-time code", bool(code)):
        return

    # 5. Exchange the code for tokens, proving we hold the PKCE verifier.
    exchange = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI,
                "client_id": client_id, "code_verifier": verifier}
    status, _, text = call("POST", "/oauth/token", form=exchange)
    if not check("code exchanged for tokens (200)", status == 200, f"{status} {text[:200]}"):
        return
    tokens = json.loads(text)
    check("got an access token and a refresh token",
          bool(tokens.get("access_token")) and bool(tokens.get("refresh_token")))
    print(f"        access token lasts {tokens.get('expires_in')} seconds")

    # 6. Use it.
    status, tools = mcp_tools_list(tokens["access_token"])
    check("/mcp tools/list with the access token", status == 200 and tools > 0, f"{status}, {tools} tools")

    # 7. Refresh: new access token AND new refresh token (rotation).
    status, _, text = call("POST", "/oauth/token", form={
        "grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": client_id})
    refreshed = json.loads(text) if status == 200 else {}
    check("refresh gives a new access token", refreshed.get("access_token") not in (None, tokens["access_token"]), status)
    check("refresh rotates the refresh token", refreshed.get("refresh_token") not in (None, tokens["refresh_token"]))
    if refreshed.get("access_token"):
        status, tools = mcp_tools_list(refreshed["access_token"])
        check("/mcp works with the refreshed token", status == 200 and tools > 0, status)

    # 8. Replaying a used code must fail AND cancel everything from that sign-in.
    status, _, _ = call("POST", "/oauth/token", form=exchange)
    check("reusing the one-time code is refused", status == 400, status)
    if refreshed.get("access_token"):
        status, _ = mcp_tools_list(refreshed["access_token"])
        check("...and the sign-in's tokens are now cancelled", status == 401, status)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print(f"\nCould not reach {BASE}: {e.reason}. Is `wrangler dev` running?")
        sys.exit(1)
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
