"""plst backend — python port of back-node-js/src/server.ts (Flask).


Same .env, same routes, same JSON shapes, same text/plain error bodies. Run: `python app.py`
(listens on HOST:PORT from .env, default 0.0.0.0:3218 so the vite dev proxy target keeps
working unchanged).
"""
import json
import os
import time

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request

load_dotenv()

from config import API_PREFIX, PORT, settings  # noqa: E402  (after load_dotenv)
from lib.logger import logger  # noqa: E402
from lib.db_diag import classify_db_error  # noqa: E402
from paste_json import parse_track_json  # noqa: E402
from pipeline import start_job  # noqa: E402
from url_parser import from_form  # noqa: E402

REQUEST_LOG_SKIP_PREFIXES = [f"{API_PREFIX}/get-updates"]


class ApiError(Exception):
    """An HTTP error whose body is the message as text/plain (parity of node's HttpError)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def default_pipeline_deps():
    """The seams node wired as the module-level `defaultDeps` singleton: one shared anonymous
    Yandex client + the real YTM search."""
    from pipeline import PipelineDeps
    from yandex.client import YandexClient, fetch_collections
    from ytmusic.search import search_songs

    client = YandexClient()
    return PipelineDeps(
        fetch_collections=lambda target: fetch_collections(target, client),
        search_songs=search_songs,
    )


def create_app(store=None, library=None, match_deps=None, yandex_deps=None, pipeline_deps=None) -> Flask:
    app = Flask(__name__, template_folder="templates")

    # ---- request-logging parity: suppress shell-poll GETs, count them, log the rest ----------
    POLL_EXACT = {"/me", "/notifications", "/users", "/songs", "/playlists", "/imports/pending", "/healthz"}
    stats = {"skipPoll": os.environ.get("LOG_SKIP_POLL") != "off", "skippedPolls": 0, "loggedRequests": 0}

    def skip_poll_stats():
        return dict(stats)

    def report_skip_counters(why: str):
        """Parity of node's reportSkipCounters: reported on demand (shutdown / periodic timer) so
        the suppressed-poll totals are never a silent unknown. The flush matters: the write is
        queued, and without it the line dies with the process on Ctrl-C."""
        if not stats["skipPoll"] or stats["skippedPolls"] == 0:
            return
        logger.log(
            "library: poll requests suppressed so far",
            {"skippedPolls": stats["skippedPolls"], "loggedRequests": stats["loggedRequests"], "why": why},
        )
        logger.flush()

    app.report_skip_counters = report_skip_counters  # main() wires timers/signals to it

    @app.before_request
    def request_log_pre():
        import time

        request._plst_start = time.time()
        if request.path.startswith(f"{API_PREFIX}/get-updates"):
            return
        path = request.path
        if stats["skipPoll"] and path.startswith(f"{API_PREFIX}/library/"):
            tail = path[len(f"{API_PREFIX}/library/"):].rstrip("/")
            if tail in POLL_EXACT or not tail:
                stats["skippedPolls"] += 1
                return
        stats["loggedRequests"] += 1
        logger.log(
            f"HTTP {request.method} {request.path}",
            {"method": request.method, "url": request.path, "ip": request.remote_addr,
             "query": dict(request.args)},
            "preHandler",
        )

    @app.after_request
    def request_log_post(response):
        import time

        started = getattr(request, "_plst_start", None)
        if started is not None:
            ms = int((time.time() - started) * 1000)
            # Node's outcome line: >=500 error, >=400 warn, otherwise a plain log line.
            if response.status_code >= 500:
                logger.error(f"HTTP {request.method} {request.path} -> {response.status_code}", None, "onResponse")
            elif response.status_code >= 400:
                logger.warn(f"-> {response.status_code} {request.method} {request.path} in {ms}ms", None, "onResponse")
            else:
                logger.log(f"-> {response.status_code} {request.method} {request.path} in {ms}ms", None, "onResponse")
        return response

    # ---- cross-cutting: CORS reflect any origin (parity of @fastify/cors `origin: true`) ----
    @app.after_request
    def add_cors(response):
        response.headers["Access-Control-Allow-Origin"] = os.environ.get("ORIGIN", "*")
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "content-type,x-user-id"
        return response

    @app.errorhandler(404)
    def not_found(_err):
        # Parity: node's setNotFoundHandler returns text/plain "not found".
        return ("not found", 404, {"Content-Type": "text/plain; charset=utf-8"})

    @app.errorhandler(ApiError)
    def api_error(err):
        return (err.message, err.status, {"Content-Type": "text/plain; charset=utf-8"})

    # ---- the poll endpoints the shell + extension hit on timers --------------------------

    @app.get("/healthz")
    def healthz():
        return jsonify({
            "ok": True,
            "yandex_configured": bool(settings.yandex_token),
            "ytm_reachable_note": "search is anonymous; set YTM_PROXY if YTM is unreachable from this host",
        })

    @app.get(f"{API_PREFIX}/get-updates")
    def get_updates():
        envs = {
            "YANDEX_TOKEN": bool(settings.yandex_token),
            "YTM_PROXY": bool(settings.ytm_proxy),
            "LOG_DISABLED": os.environ.get("LOG_DISABLED") == "true",
        }
        return jsonify({
            "version": os.environ.get("TAG_VERSION"),
            "commit_message": os.environ.get("COMMIT_MESSAGE"),
            "project_id": os.environ.get("PROJECT_ID"),
            "namespace": os.environ.get("NAMESPACE"),
            "slave_repo": os.environ.get("SLAVE_REPO"),
            "envs": envs,
            "logs": {
                "app": logger.get_logs(type_="app", last=50),
                "error": logger.get_logs(type_="error", last=50),
                "start": logger.read_log_file("app.start.json"),
            },
            "urls": {
                "home": "/",
                "migrate": "/migrate",
                "getUpdates": f"{API_PREFIX}/get-updates",
                "jobs": "/jobs",
            },
        })

    @app.get(f"{API_PREFIX}/db-test")
    def db_test():
        # One direct connection + song count — a quick liveness probe for the VPS MySQL
        # (used to verify the snapdeploy container's whitelist; kept as a handy check).
        import pymysql

        started = time.monotonic()
        try:
            conn = pymysql.connect(
                host=settings.db_host, port=settings.db_port,
                user=settings.db_user, password=settings.db_password,
                database=settings.db_name, connect_timeout=5,
            )
        except Exception as err:
            verdict = classify_db_error(err)
            logger.log("db-test connect failed", {"errorClass": err.__class__.__name__}, "dbTest")
            return (jsonify({"ok": False, "error_class": err.__class__.__name__, "verdict": verdict}), 502)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS songs FROM songs")
                songs = cur.fetchone()[0]
        finally:
            conn.close()
        ms = round((time.monotonic() - started) * 1000)
        logger.log("db-test ok", {"songs": songs, "ms": ms}, "dbTest")
        return jsonify({
            "ok": True, "host": settings.db_host, "port": settings.db_port,
            "db": settings.db_name, "songs": songs, "ms": ms,
        })

    @app.get(f"{API_PREFIX}/features")
    def features():
        # Which remote feat web-components the app mounts where. MOCK for now — the planned
        # configuration GUI will edit exactly this data (see web/src/layout/FeatureSlot.tsx).
        return jsonify({
            "features": [
                {
                    "slot": "app-version",
                    "id": "version-display",
                    "element": "deploy-info",
                    "baseUrl": os.environ.get("FEAT_BACK_URL") or "https://feat.twc1.net",
                    "version": "v4",
                    "namespace": "js-web",
                }
            ]
        })

    # Library routes (the plst music library API).
    if library is not None:
        from library.routes import register_library_routes

        register_library_routes(app, library, match_deps=match_deps, yandex_deps=yandex_deps,
                                poll_stats=skip_poll_stats)
    # Converter routes + admin pages (Stage F) — parity of the tail of node's buildApp.

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.post("/migrate")
    def migrate():
        if pipeline_deps is not None:
            deps = pipeline_deps
        else:
            deps = default_pipeline_deps()
        body = request.form
        mode = body.get("mode") or ""
        source = (body.get("source") or "").strip()
        try:
            # Reject a bad paste up front rather than creating a job that is guaranteed to fail.
            if mode == "json":
                parse_track_json(source)
            else:
                from_form(mode, source)
        except ValueError as err:
            return (str(err), 400, {"Content-Type": "text/plain; charset=utf-8"})
        job_id = start_job(store, mode, source, deps)
        # Node replied 303 See Other; keep it so a form POST turns into a GET of the job page.
        return ("", 303, {"Location": f"/job/{job_id}"})

    @app.get("/jobs")
    def jobs():
        return render_template("jobs.html", jobs=store.list_jobs())

    @app.get("/job/<job_id>")
    def job_view(job_id: str):
        job = store.get_job(job_id)
        if not job:
            return ("job not found", 404, {"Content-Type": "text/plain; charset=utf-8"})
        items = store.job_items(job_id)
        fmt = request.args.get("format")

        if fmt == "json":
            summary = _parse_summary(job)
            return jsonify({"job": job, "items": items, "summary": summary})

        if fmt == "links":
            links = [
                f"https://music.youtube.com/watch?v={i['yt_video_id']}"
                for i in items
                if i.get("yt_video_id") and i.get("status") in ("matched", "uncertain")
            ]
            return ("\n".join(links), 200, {"Content-Type": "text/plain; charset=utf-8"})

        return render_template("job.html", job=job, items=items, summary=_parse_summary(job))

    return app


def _parse_summary(job: dict):
    """Node: JSON.parse(summary_json) on the happy path, [] on a parse failure, null when absent."""
    raw = job.get("summary_json")
    if raw:
        try:
            return json.loads(raw)
        except ValueError:
            return []
    return None


def init_database():
    """Everything that opens a MySQL connection — mirrored from node's initDatabase so a dead
    DB fails here, classified, and nothing else can be mislabeled 'database unreachable'."""
    from db import open_store
    from library.schema import init_library
    from library.migrations import migrate_library_songs, migrate_library_users
    from library.store import LibraryStore

    store = open_store()
    init_library(store.db)
    migrate_library_songs(store.db)
    migrate_library_users(store.db)
    library = LibraryStore(store.db)
    library.seed_users()
    return store, library


def main():
    store, library = init_database()
    app = create_app(store=store, library=library)
    report = app.report_skip_counters
    logger.log("server ready", {"logDir": str(logger.dir), "fileWriting": logger.enabled}, "onReady")

    # Boot parity of node's listen block: a periodic skip-counter report, and a SIGINT/SIGTERM
    # handler that flushes the report BEFORE exiting (an unflushed line never reaches the log file
    # — the exact failure the node build hit). A force-exit guard keeps a hung connection from
    # making Ctrl-C look like a freeze.
    import signal
    import threading

    def _periodic():
        timer = threading.Timer(5 * 60, _periodic)
        timer.daemon = True
        report("periodic")
        timer.start()

    _periodic()

    def _shutdown(signum, _frame):
        report(f"shutdown ({signal.Signals(signum).name})")
        logger.flush()  # queued writes must land in the file before os._exit drops them
        os._exit(0)

    for sig in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, sig), _shutdown)

    app.run(host=settings.host, port=PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
