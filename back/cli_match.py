#!/usr/bin/env python3
"""Match dry-run CLI — port of back-node-js/src/cli.ts.

  venv/bin/python cli_match.py match <yandex-url>
  venv/bin/python cli_match.py json <file.json|->   (track JSON from the browser extension)

Fetches the collection (or reads the pasted JSON), searches YouTube Music for each track with the
real matcher, prints per-track verdicts plus a plain link list. No job is created; nothing is
written to the database or the cache.
"""
import json
import sys

from config import apply_ytm_proxy
from matcher import build_queries, match_track
from model import artist_str
from paste_json import parse_track_json
from url_parser import parse_url
from yandex.client import YandexClient, fetch_collections
from ytmusic.search import search_songs

PERFECT = 0.9995


def match_one(track: dict) -> dict:
    best = None
    for query in build_queries(track):
        candidates = []
        try:
            candidates = search_songs(query)
        except Exception as err:
            print(f"  search error: {err}", file=sys.stderr)
        res = match_track(track, candidates)
        if best is None or res["score"] > best["score"]:
            best = res
        if res["status"] == "matched":
            break
    return best if best is not None else match_track(track, [])


def report(track: dict, res: dict) -> None:
    # Anything short of an exact normalized match gets flagged: a low artist score can still
    # clear MATCH_ACCEPT on a title-only hit and hand back the wrong artist entirely.
    review = 0 < res["score"] < PERFECT
    flag = "⚠ review" if review else "         "
    url = f"  https://music.youtube.com/watch?v={res['videoId']}" if res.get("videoId") else ""
    print(
        f"[{res['status'].ljust(9)}] {res['score']:.2f} {flag}  {artist_str(track)} — {track['title']} "
        f"({track['duration']}s)  ->  {res.get('ytArtist') or ''} — {res.get('ytTitle') or ''}{url}"
    )


def print_links(tracks: list, results: list) -> None:
    links = []
    for i, res in enumerate(results):
        if not res.get("videoId"):
            continue
        if res["status"] not in ("matched", "uncertain"):
            continue
        t = tracks[i]
        review = 0 < res["score"] < PERFECT
        links.append(f"https://music.youtube.com/watch?v={res['videoId']}" + ("  # review" if review else ""))
    if links:
        print("\n--- links ---")
        for l in links:
            print(l)


def run(tracks: list) -> list:
    results = []
    for i, track in enumerate(tracks):
        res = match_one(track)
        results.append(res)
        report(track, res)
        sys.stderr.write(f"\r[{i + 1}/{len(tracks)}] {track['title'][:48]}".ljust(70))
    sys.stderr.write("\n")
    return results


def cmd_match(url: str) -> None:
    target = parse_url(url)
    client = YandexClient()
    collections = fetch_collections(target, client)
    for coll in collections:
        print(f"\n=== {coll['title']} ({len(coll['tracks'])} tracks) ===")
        results = run(coll["tracks"])
        print_links(coll["tracks"], results)


def read_stdin() -> str:
    return sys.stdin.read()


def cmd_json(source: str) -> None:
    raw = read_stdin() if source == "-" else open(source, encoding="utf-8").read()
    parsed = parse_track_json(raw)
    tracks, skipped = parsed["tracks"], parsed["skipped"]
    skipped_note = f", {skipped} skipped: no title" if skipped else ""
    print(f"=== pasted JSON ({len(tracks)} tracks{skipped_note}) ===")
    results = run(tracks)
    print_links(tracks, results)
    counts: dict = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    flagged = sum(1 for r in results if 0 < r["score"] < PERFECT)
    breakdown = " ".join(f"{k}={v}" for k, v in counts.items())
    print(f"\nsummary: {breakdown} | flagged for review={flagged}")


def usage() -> None:
    print("usage: venv/bin/python cli_match.py match <yandex-url>", file=sys.stderr)
    print("       venv/bin/python cli_match.py json <file.json|->   (track JSON from the browser extension)", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    arg = sys.argv[2] if len(sys.argv) > 2 else None
    if not arg:
        usage()
    apply_ytm_proxy()
    if cmd == "match":
        cmd_match(arg)
    elif cmd == "json":
        cmd_json(arg)
    else:
        usage()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)
