"""Pasted extension track JSON — port of back-node-js/src/pasteJson.ts (pure functions).

Error message strings are byte-identical to the node build's (the HTTP layer surfaces them
as text/plain bodies).
"""
import math


def _to_artists(value) -> list[str]:
    if isinstance(value, list):
        out = []
        for a in value:
            if isinstance(a, str):
                s = a.strip()
            else:
                # node: String(a?.name ?? '').trim() — null/undefined name -> ''
                name = a.get("name") if isinstance(a, dict) else None
                s = ("" if name is None else str(name)).strip()
            if s:
                out.append(s)
        return out
    if isinstance(value, str):
        return [s.strip() for s in value.split(",") if s.strip()]
    return []


def _to_duration(value) -> int:
    if isinstance(value, str):
        try:
            n: object = float(value)
        except ValueError:
            return 0
    else:
        n = value
    if isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and n > 0:
        return round(n)  # node Math.round
    return 0


def parse_track_json(raw: str) -> dict:
    """{tracks: [TrackMeta], skipped: int} — raises ValueError with node's message text."""
    import json

    try:
        data = json.loads(raw)
    except ValueError as err:
        raise ValueError(f"not valid JSON: {err}") from err
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict) and isinstance(data.get("tracks"), list):
        rows = data["tracks"]
    else:
        rows = None
    if rows is None:
        raise ValueError('expected a JSON array of tracks, or an object with a "tracks" array')

    tracks = []
    skipped = 0
    for row in rows:
        if not isinstance(row, dict):
            row = {}
        # node: String(row?.title ?? '').trim() — nullish -> '', but falsy values like 0 stringify
        raw_title = row.get("title")
        title = ("" if raw_title is None else str(raw_title)).strip()
        if not title:
            skipped += 1
            continue
        artists = _to_artists(row.get("artists"))
        raw_album = row.get("album")
        album = ("" if raw_album is None else str(raw_album)).strip()
        tracks.append({
            "title": title,
            "artists": artists if artists else ["Unknown"],
            "album": album or None,
            "duration": _to_duration(row.get("durationS") if isinstance(row, dict) else None),
            "sourceId": None,
        })

    if not tracks:
        raise ValueError(f"no usable rows: {len(rows)} input row(s), all missing a title")
    return {"tracks": tracks, "skipped": skipped}
