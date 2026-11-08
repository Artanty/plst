"""Settings — loaded from .env (dotenv), same keys/defaults as the node build's src/config.ts.

Every consumer reads `settings`, mirroring back-node-js/src/config.ts field-for-field.
"""
import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _opt(name: str):
    value = os.environ.get(name)
    return value if value else None


@dataclass
class Settings:
    yandex_token: str | None
    yandex_proxy: str | None
    ytm_proxy: str | None
    ytm_timeout: float
    search_concurrency: int
    match_accept: float
    match_uncertain: float
    duration_tolerance: int
    db_host: str | None
    db_port: int
    db_name: str | None
    db_user: str | None
    db_password: str | None
    host: str


settings = Settings(
    yandex_token=_opt("YANDEX_TOKEN"),
    yandex_proxy=_opt("YANDEX_PROXY"),
    ytm_proxy=_opt("YTM_PROXY"),
    ytm_timeout=float(os.environ.get("YTM_TIMEOUT") or 20000),
    search_concurrency=int(os.environ.get("SEARCH_CONCURRENCY") or 4),
    match_accept=float(os.environ.get("MATCH_ACCEPT") or 0.75),
    match_uncertain=float(os.environ.get("MATCH_UNCERTAIN") or 0.55),
    duration_tolerance=int(os.environ.get("DURATION_TOLERANCE") or 5),
    db_host=_opt("DB_HOST"),
    db_port=int(os.environ.get("DB_PORT") or 3306),
    db_name=_opt("DB_DATABASE"),
    db_user=_opt("DB_USERNAME"),
    db_password=_opt("DB_PASSWORD"),
    host=os.environ.get("HOST") or "0.0.0.0",
)

# The port the server listens on (node read it directly in server.ts; kept out of Settings for
# parity with the node code's shape).
PORT = int(os.environ.get("PORT") or 3218)
API_PREFIX = os.environ.get("API_PREFIX") or "/api"


def apply_ytm_proxy():
    """Mirror YTM_PROXY into the process-level proxy envs, like the node build's applyYtmProxy."""
    if settings.ytm_proxy:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            os.environ[key] = settings.ytm_proxy
