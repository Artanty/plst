"""Natural keys for the library, built on the SAME normalize() the matcher scores with.

Port of back-node-js/src/library/keys.ts — one normalizer means the import dedup and the
matcher can never disagree about "same track".
"""
import hashlib

from matcher import normalize


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def song_title_key(title: str) -> str:
    """Title key. Duration deliberately excluded: it is the field a bad scrape gets wrong."""
    return _sha1(f"t|{normalize(title)}")


def song_dedup_key(title: str, artists: list[str], duration_s: int) -> str:
    """Artists SORTED (B feat. A == A, B), set-joined with a NUL char (normalize can never produce it)."""
    norm_artists = sorted({normalize(a) for a in artists if normalize(a)})
    return _sha1("song|%s|%s|%d" % (normalize(title), "\x00".join(norm_artists), duration_s or 0))


def artist_key(name: str) -> str:
    return _sha1(f"artist|{normalize(name)}")


def album_key(title: str, artist_id: int | None, year: int | None) -> str:
    """Includes the owning artist id and year so 'Greatest Hits' by four artists stays four rows."""
    return _sha1(f"album|{normalize(title)}|{artist_id if artist_id is not None else ''}|{year if year is not None else ''}")
