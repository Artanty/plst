#!/usr/bin/env python3
"""`npm run db:check` equivalent — port of back-node-js/src/cliDb.ts.

The "it happened again, what do I do" command. Runs the diagnosis ladder in the order the
failures actually stack (network → firewall → grants → data) and prints, at every failed step,
the verdict plus the ready-to-run next step.

Run: cd back && venv/bin/python cli_db.py
Exit code 1 when the TCP or login step fails, 0 otherwise.
"""
import sys

from config import settings
from lib.db_diag import check_database, classify_db_error, probe_tcp, public_ip


def main() -> int:
    host = settings.db_host or "127.0.0.1"
    port = settings.db_port

    print("plst database check")
    print("===================")
    print(f"target:   {host}:{port}  db={settings.db_name or '(default)'}  user={settings.db_user or '(default)'}")
    print(f"ytmProxy: {settings.ytm_proxy or '(none)'}   yandexProxy: {settings.yandex_proxy or '(none)'}")

    exit_code = 0

    # 1. What does the VPS see as our address? Both the firewall rule and the grant key off this.
    ip = public_ip()
    print(f"\n[1/4] this machine's public IP: {ip or 'unknown (ifconfig.me unreachable — itself a network hint)'}")

    # 2. Raw TCP — firewall layer, before MySQL has any opinion.
    print(f"\n[2/4] TCP {host}:{port} …")
    tcp = probe_tcp(host, port)
    if tcp["ok"]:
        print(f"  open — handshake in {tcp['latencyMs']}ms. Firewall lets this IP through.")
    else:
        verdict = classify_db_error(tcp["error"], host)
        print(f"  FAILED: {verdict['headline']}")
        for a in verdict["actions"]:
            print(f"  → {a['text']}")
            if a.get("code"):
                print(_indent_code(a["code"]))
        # No point logging in when TCP is dead — but say so rather than looking hung.
        print("\nStopping here: MySQL cannot be reached at the TCP layer, so a login would only time out too.")
        return 1

    # 3. Login + identity + grants — the grant layer.
    print(f"\n[3/4] MySQL login as {settings.db_user or '(default)'} …")
    probe = check_database({
        "host": host,
        "port": port,
        "user": settings.db_user,
        "password": settings.db_password,
        "database": settings.db_name,
    })
    if probe["verdict"]["kind"] == "ok":
        print(f"  ok — {probe['verdict']['headline']}, round-trip {probe['latencyMs']}ms")
        if probe.get("grants"):
            print("  grants:")
            for g in probe["grants"]:
                print(f"    {g}")
    else:
        print(f"  FAILED: {probe['verdict']['headline']}")
        for a in probe["verdict"]["actions"]:
            print(f"  → {a['text']}")
            if a.get("code"):
                print(_indent_code(a["code"]))
        exit_code = 1

    # 4. Is it the RIGHT database, with the data in it? Only meaningful once logged in — after a
    # login failure "no songs table" would be a red herring on top of the real error.
    print("\n[4/4] data sanity:")
    if probe["verdict"]["kind"] != "ok":
        print("  skipped — the login step above failed, so there is no data to inspect yet.")
    elif probe.get("songCount") is not None:
        print(f"  songs table: {probe['songCount']} rows")
        if probe["songCount"] == 0:
            print("  ⚠ empty — DB_HOST may point at a different MySQL than your library lives in.")
    else:
        print("  no songs table reachable (fresh install, or no rights on this schema).")

    if probe["verdict"]["kind"] != "ok":
        print("\nVerdict: the DATABASE LAYER is the problem — fix it before touching app code.")
    else:
        print("\nVerdict: database is reachable and correctly logged into. If the app still fails,")
        print("the failing call is elsewhere — check back/logs/error.log for the exact route.")

    return exit_code


def _indent_code(code: str) -> str:
    """Node: a.code.replace(/^/gm, '      ') — every line indented six spaces."""
    return "\n".join("      " + line for line in code.split("\n"))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # node: main().catch → print + exitCode 1
        print(f"db:check itself failed: {err}", file=sys.stderr)
        sys.exit(1)
