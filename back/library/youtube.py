"""Turning matched songs into the plain list of YouTube Music links — port of
back-node-js/src/library/youtube.ts. The text and JSON formats are byte-exact with the node
build.

Two rules, both learned the hard way:
1. UNMATCHED SONGS ARE LISTED BY NAME. A silently short export looks identical to a complete one.
2. AN UNCERTAIN MATCH IS NOT A LINK. Uncertain rows are reported separately, commented out, so
   pasting the list cannot quietly insert the wrong song.
"""


def yt_url(video_id: str) -> str:
    return f"https://music.youtube.com/watch?v={video_id}"


def build_youtube_export(songs):
    links = []
    uncertain = []
    unmatched = []
    search_failed = []

    for song in songs:
        if not song.get("yt_video_id"):
            entry = {
                "songId": song.get("id"),
                "title": song.get("title"),
                "artists": song.get("artists"),
            }
            # The stored verdict decides which list: search_failed was never answered by YouTube,
            # so it gets its own block and a "fix the network and retry" message instead of
            # "no match yet".
            if song.get("match_status") == "search_failed":
                search_failed.append(entry)
            else:
                unmatched.append(entry)
        elif is_confident(song.get("match_score")):
            links.append(_entry_with_link(song))
        else:
            uncertain.append(_entry_with_link(song))

    return {
        "links": links,
        "matched": len(links),
        "uncertain": uncertain,
        "unmatched": unmatched,
        "searchFailed": search_failed,
        "total": len(songs),
        "text": _render_text(len(songs), links, uncertain, unmatched, search_failed),
    }


# Kept importable under the same name the tests/routes use; matches library.match.isConfident.
try:
    from .match import is_confident  # noqa: F401
except ImportError:  # pragma: no cover - flat-import fallback
    from library.match import is_confident  # noqa: F401


def _entry_with_link(song):
    return {
        "songId": song.get("id"),
        "title": song.get("title"),
        "artists": song.get("artists"),
        "videoId": song.get("yt_video_id"),
        "url": yt_url(song.get("yt_video_id")),
        "score": song.get("match_score"),
    }


def _credit(artists) -> str:
    return ", ".join(artists) if artists else "unknown artist"


def _render_text(total, links, uncertain, unmatched, search_failed) -> str:
    lines = []
    for link in links:
        lines.append(link["url"])
    # Only separate the comment blocks from something. With no confident links the text would
    # otherwise start with a blank line, which is what you get when pasting into a playlist.

    def gap():
        if lines:
            lines.append("")

    if uncertain:
        gap()
        lines.append(f"# {len(uncertain)} uncertain match(es) — NOT pasted, check them by hand:")
        for song in uncertain:
            score = "no score" if song["score"] is None else f"score {song['score']:.2f}"
            lines.append(f"# - {song['title']} — {_credit(song['artists'])} ({score}) -> {song['url']}")

    # A different problem from "no match": these were never searched. The message names the
    # action (fix the network, match again) rather than leaving the reader to wonder.
    if search_failed:
        gap()
        lines.append(f"# {len(search_failed)} of {total} song(s) were never searched — YouTube Music was unreachable:")
        for song in search_failed:
            lines.append(f"# - {song['title']} — {_credit(song['artists'])}")
        lines.append("# Fix the connection (is YTM_PROXY running?) and press match again.")

    if unmatched:
        gap()
        lines.append(f"# {len(unmatched)} of {total} songs have no YouTube Music match yet:")
        for song in unmatched:
            lines.append(f"# - {song['title']} — {_credit(song['artists'])}")

    return "\n".join(lines)
