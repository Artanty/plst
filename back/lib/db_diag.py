"""db-diag feature — MySQL unreachability diagnosis (python implementation).

Contract: back/spec/db-diag.md. Vendored by consumers (plst: -> back/lib/db_diag.py).
Ported from the js-node build. The classifier and probe_tcp are dependency-free; check_database
lazy-imports the MySQL driver at call time (mysql-connector-python or PyMySQL via a URL arg —
consumers pass `connect`, defaulting to the one available).
"""
import os
import socket
import time
from datetime import datetime, timedelta

HOST_HINT = "run `npm run db:check` in back/ for the full ladder (TCP → login → grants)"


def classify_db_error(err, host=None):
    """Pure classifier: layer + next step for a connection-level MySQL error (see the spec table)."""
    target = host or os.environ.get("DB_HOST") or "185.114.247.197"
    code = getattr(err, "code", "") or getattr(err, "errno", "") or ""
    if isinstance(code, int):
        # PyMySQL raises OperationalError with errno int; map the well-known ones.
        code = {2003: "ECONNREFUSED", 2005: "ENOTFOUND", 2004: "ETIMEDOUT",
                1045: "ER_ACCESS_DENIED_ERROR", 1044: "ER_DBACCESS_DENIED_ERROR",
                1049: "ER_DBACCESS_DENIED_ERROR"}.get(code, "")
    message = str(err).split("\n")[0][:200]

    if code in ("ETIMEDOUT", "PROTOCOL_SEQUENCE_TIMEOUT"):
        return {
            "kind": "timeout",
            "headline": f"TCP to the database timed out — packets were dropped before MySQL answered: {message}",
            "actions": [
                {"text": "If this machine is on a NEW network/location: the VPS firewall only lets certain public IPs through. Open port 3306 for this IP in the Timeweb panel (or SSH-tunnel, see below)."},
                {"text": f"Check the VPS itself is up: ping {target} (this host flapped once on 2026-10-19)."},
                {"text": "Prove which layer it is from this network:", "code": f"nc -z -v {target} 3306"},
                {"text": HOST_HINT},
            ],
        }
    if code == "ECONNREFUSED":
        return {
            "kind": "refused",
            "headline": f"TCP reached the host but MySQL refused the connection — nothing is listening on that port: {message}",
            "actions": [
                {"text": "MySQL/Percona is down or bound to another interface on the VPS. Start it there:", "code": "systemctl status mysql"},
                {"text": "Or DB_PORT in back/.env points at the wrong port."},
                {"text": HOST_HINT},
            ],
        }
    if code in ("ENOTFOUND", "EAI_AGAIN"):
        return {
            "kind": "dns",
            "headline": f"DNS lookup for the database host failed: {message}",
            "actions": [
                {"text": f"DB_HOST ({target}) in back/.env no longer resolves — the VPS IP may have changed. Look it up in the Timeweb panel and update DB_HOST."},
                {"text": "Or this network blocks DNS; try another network."},
            ],
        }
    if code in ("ECONNRESET", "EPIPE", "PROTOCOL_CONNECTION_ERROR", "PROTOCOL_CONNECTION_LOST"):
        lost = code == "PROTOCOL_CONNECTION_LOST"
        return {
            "kind": "reset",
            "headline": (
                "The connection was cut — "
                + ("the server closed it (restart, firewall drop, or idle past wait_timeout)"
                   if lost else "usually a proxy/firewall resetting foreign IPs")
                + f": {message}"
            ),
            "actions": [
                *(
                    [
                        {"text": "A one-off of this after idle time is MySQL closing an unused pooled connection (wait_timeout) — normal, the next query just opens a fresh one."},
                        {"text": "If queries started FAILING at the same moment: the VPS restarted or the firewall dropped established connections. Check the host, then run db:check."},
                    ]
                    if lost
                    else [
                        {"text": "A NEW location often gets its handshake reset by the VPS firewall instead of a timeout. Same fix as the timeout case: allow this public IP in the Timeweb firewall, or use an SSH tunnel."},
                    ]
                ),
                {"text": HOST_HINT},
            ],
        }
    if code == "ER_ACCESS_DENIED_ERROR":
        # Reaching this error PROVES the firewall is open — two causes remain: wrong password,
        # or no grant for the address MySQL reported seeing.
        import re as _re

        observed = _re.search(r"for user '([^']+)'@'([^']+)'", message)
        account = observed.group(1) if observed else "cs99850_yaum"
        seen_from = observed.group(2) if observed else None
        return {
            "kind": "access_denied",
            "headline": (
                f"MySQL answered and REJECTED the login{f' from {seen_from}' if seen_from else ''}"
                f" — either DB_PASSWORD in .env is wrong, or no grant matches this address: {message}"
            ),
            "actions": [
                {"text": "If you did NOT change location/network: the address is already known to MySQL, so a wrong DB_PASSWORD in back/.env gives exactly this error. Compare it with the one on the VPS."},
                {
                    "text": f"If you ARE at a new location: MySQL saw you as '{account}'@'{seen_from or '<address-from-error>'}' and no grant matches. Run as MySQL root on the VPS:",
                    "code": grant_sql_for_user(account, seen_from),
                },
                {"text": "Safer alternative that works from any location without exposing MySQL: SSH tunnel + DB_HOST=127.0.0.1 in back/.env."},
                {"text": HOST_HINT},
            ],
        }
    if code == "ER_DBACCESS_DENIED_ERROR":
        return {
            "kind": "db_access_denied",
            "headline": f"The login was accepted but the user has no rights on the configured database (wrong DB_DATABASE, or the grant is for another schema): {message}",
            "actions": [
                {"text": "Check DB_DATABASE in back/.env against the GRANT list.", "code": "SHOW GRANTS;"},
                {"text": HOST_HINT},
            ],
        }
    return {
        "kind": "unknown",
        "headline": f"Database connection failed with an unrecognised error: {message}",
        "actions": [{"text": HOST_HINT}],
    }


def grant_sql_for_user(user, client_host=None):
    """The grant-fix SQL. The password is NEVER interpolated — always the placeholder."""
    host = client_host or "PUBLIC_IP"
    database = os.environ.get("DB_DATABASE") or "cs99850_yaum"
    return "\n".join([
        "-- as MySQL root on the VPS; host below = the address MySQL saw this connection come from",
        f"CREATE USER IF NOT EXISTS '{user}'@'{host}' IDENTIFIED BY '<same-password-as-DB_PASSWORD>';",
        f"GRANT ALL PRIVILEGES ON `{database}`.* TO '{user}'@'{host}';",
        "FLUSH PRIVILEGES;",
        "-- if the account already exists with another password instead of creating it:",
        f"-- ALTER USER '{user}'@'{host}' IDENTIFIED BY '<same-password-as-DB_PASSWORD>';",
    ])


def probe_tcp(host, port, timeout_ms=5000, connect=None):
    """Raw TCP reachability — the layer BELOW MySQL. `connect` injectable for tests."""
    connect = connect or socket.create_connection
    started = time.monotonic()
    try:
        sock = connect((host, port), timeout=timeout_ms / 1000)
        latency_ms = int((time.monotonic() - started) * 1000)
        sock.close()
        return {"ok": True, "latencyMs": latency_ms}
    except socket.timeout:
        err = TimeoutError(f"connect ETIMEDOUT after {timeout_ms}ms")
        err.code = "ETIMEDOUT"
        return {"ok": False, "latencyMs": None, "error": err}
    except OSError as err:
        return {"ok": False, "latencyMs": None, "error": err}


def check_database(cfg):
    """Full login probe: identity + grants + song count, classified on failure.

    `cfg['connect']` (optional) is a callable (cfg) -> connection with `.query(sql)` returning
    rows; the default builds a PyMySQL connection (requires pymysql in the consumer).
    """
    started = time.monotonic()
    conn = None
    try:
        if "connect" in cfg:
            conn = cfg["connect"](cfg)
        else:
            import pymysql

            conn = pymysql.connect(
                host=cfg["host"],
                port=cfg["port"],
                user=cfg.get("user"),
                password=cfg.get("password"),
                database=cfg.get("database"),
                connect_timeout=int(cfg.get("connectTimeoutMs", 8000) / 1000),
            )
        latency_ms = int((time.monotonic() - started) * 1000)

        with conn.cursor() as cur:
            cur.execute("SELECT CURRENT_USER(), @@hostname, VERSION()")
            cu, hostname, version = cur.fetchone()
        identity = {"user": cu, "host": hostname, "version": version}

        grants = []
        try:
            with conn.cursor() as cur:
                cur.execute("SHOW GRANTS")
                grants = [list(row.values())[0] if isinstance(row, dict) else row[0] for row in cur.fetchall()]
        except Exception:
            pass  # SHOW GRANTS can be denied to restricted users — not worth failing over

        song_count = None
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM songs")
                song_count = cur.fetchone()[0]
        except Exception:
            pass  # no songs table (fresh install) — a sanity signal, not the point

        return {
            "verdict": {
                "kind": "ok",
                "headline": f"connected as {identity['user']} on {identity['host']} ({identity['version']})",
                "actions": [],
            },
            "latencyMs": latency_ms,
            "identity": identity,
            "grants": grants,
            "songCount": song_count,
        }
    except Exception as err:
        return {"verdict": classify_db_error(err, cfg.get("host")), "latencyMs": None}
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def public_ip(fetch_impl=None):
    """This machine's public IP via ifconfig.me; None on any failure. `fetch_impl` injectable."""
    import urllib.request

    def default_fetch(url, timeout):
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return res.status, res.read().decode()

    fetch = fetch_impl or default_fetch
    try:
        status, body = fetch("https://ifconfig.me/ip", 5)
        if status != 200:
            return None
        return body.strip() or None
    except Exception:
        return None
