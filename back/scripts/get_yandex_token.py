#!/usr/bin/env python3
"""One-time Yandex Music token fetch via OAuth Device Flow — port of scripts/get_yandex_token.mjs.

  venv/bin/python scripts/get_yandex_token.py

Put the printed access_token into .env as YANDEX_TOKEN.
"""
import random
import sys
import time

import urllib.request
import urllib.parse
import json

CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d"
CLIENT_SECRET = "53bc75238f0c4d08a118e51fe9203300"
OAUTH_BASE = "https://oauth.yandex.ru"


def random_device_id() -> str:
    chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(random.choice(chars) for _ in range(10))


def post_form(url: str, data: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(data).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode()
            status = res.status
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        status = err.code
    try:
        body = json.loads(text)
    except ValueError:
        raise RuntimeError(f"HTTP {status}: {text[:300]}")
    if status >= 400:
        raise RuntimeError(f"HTTP {status}: {text[:500]}")
    return body


def main() -> None:
    code = post_form(f"{OAUTH_BASE}/device/code", {
        "client_id": CLIENT_ID,
        "device_id": random_device_id(),
        "device_name": "plst",
    })
    print(f"\nOpen {code.get('verification_url') or 'https://oauth.yandex.ru/authorize'} and enter the code: {code['user_code']}\n")

    interval = (code.get("interval") or 5)
    deadline = (code.get("expires_in") or 600)
    waited = 0
    while waited < deadline:
        time.sleep(interval)
        waited += interval
        try:
            token = post_form(f"{OAUTH_BASE}/token", {
                "grant_type": "device_code",
                "code": code.get("device_code") or code.get("code"),
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
            })
        except RuntimeError as err:
            if "authorization_pending" in str(err):
                continue
            raise
        print("access_token: ", token["access_token"])
        print("refresh_token:", token["refresh_token"])
        print("expires_in:   ", token["expires_in"])
        return
    raise RuntimeError("device code expired without confirmation")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)
