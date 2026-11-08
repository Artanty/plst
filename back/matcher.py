"""Track matcher — port of back-node-js/src/matcher.ts (behavior frozen by its tests).

Scoring uses rapidfuzz's WRatio, the C++ port of the same algorithm fuzzball wraps; the
0.6*title + 0.4*artist weighting, the qualifier/duration modifiers and the thresholds all come
from settings like in the node build.
"""
import re
import unicodedata

from rapidfuzz import fuzz

from config import settings
from lib.logger import logger

BRACKET_RE = re.compile(r"[\(\[\{][^\)\]\}]*[\)\]\}]", re.UNICODE)
NOISE_RE = re.compile(
    r"\b(official\s*(audio|video|mv|m/v)?\s*(music)?(video)?|official|audio|video|lyrics?|visualizer|"
    r"official\s*lyrics|explicit|clean|hd|hq|4k)\b",
    re.IGNORECASE,
)

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", "і": "i", "џ": "dz", "ґ": "g", "є": "ye", "ї": "yi",
}

_TRANSLIT_CLASS = re.compile("[" + re.escape("".join(TRANSLIT.keys())) + "]", re.IGNORECASE)

# A qualifier that changes the RECORDING (not just the mastering). normalize() deletes all
# bracketed text, so a remix in brackets would otherwise score identically to the studio cut.
# Remasters are deliberately NOT here — a remaster is the same recording.
QUALIFIER_RE = re.compile(r"\b(remix|live|acoustic|cover|instrumental|karaoke|demo|sped[\s-]?up|slowed(?:\s*down)?)\b", re.IGNORECASE)


def transliterate(text: str) -> str:
    if not any(ch.lower() in TRANSLIT for ch in text):
        return text
    return "".join(TRANSLIT.get(ch.lower(), ch) for ch in text)


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).lower()
    t = BRACKET_RE.sub(" ", t)
    t = NOISE_RE.sub(" ", t)
    t = _TRANSLIT_CLASS.sub(lambda m: TRANSLIT.get(m.group(0).lower(), m.group(0)), t)
    # node: strip everything that is not a letter/number/space (\p{L}\p{N})
    t = "".join(ch if (ch.isalnum() or ch.isspace()) else " " for ch in t)
    return " ".join(t.split()).strip()


def feature(text: str) -> str:
    return " ".join(sorted(normalize(text).split(" ")))


def duration_ok(a, b, tol: float):
    if not a or not b:
        return None
    diff = abs(a - b)
    if diff <= tol:
        return True
    return diff <= max(0.1 * min(a, b), tol)


def _wratio(a: str, b: str) -> float:
    return fuzz.WRatio(a, b) / 100


def score_candidate(track: dict, cand: dict) -> float:
    t_sim = max(
        _wratio(normalize(track["title"]), normalize(cand["title"])),
        _wratio(feature(track["title"]), feature(cand["title"])),
    )
    src_artists = " ".join(normalize(a) for a in track["artists"])
    cand_artists = normalize(cand["artists"])
    a_sim = max(
        [_wratio(src_artists, cand_artists)]
        + [_wratio(normalize(a), cand_artists) for a in track["artists"]]
    )
    combined = 0.6 * t_sim + 0.4 * a_sim
    if QUALIFIER_RE.search(cand["title"]) and not QUALIFIER_RE.search(track["title"]):
        combined *= 0.5
    if duration_ok(track.get("duration"), cand.get("duration"), settings.duration_tolerance) is False:
        combined *= 0.3
    return combined


def build_queries(track: dict) -> list[str]:
    main = track["artists"][0] if track["artists"] else ""
    variants: list[str] = []
    seen: set[str] = set()

    def add(q: str):
        q = q.strip()
        if q and q.lower() not in seen:
            seen.add(q.lower())
            variants.append(q)

    add(f"{main} {track['title']}")
    add(f"{track['title']} {main}")
    tr_title = transliterate(track["title"])
    tr_main = transliterate(main)
    if tr_title != track["title"] or tr_main != main:
        add(f"{tr_main} {tr_title}")
    if len(track["artists"]) > 1:
        add(f"{track['artists'][1]} {track['title']}")
    return variants


def match_track(track: dict, candidates: list[dict]) -> dict:
    """{status, score, videoId, ytTitle?, ytArtist?, ytDuration?} — parity with the node build."""
    best = None
    for cand in candidates:
        score = score_candidate(track, cand)
        if best is None or score > best["score"]:
            best = {
                "status": "not_found",
                "score": score,
                "videoId": cand["videoId"],
                "ytTitle": cand["title"],
                "ytArtist": cand["artists"],
                "ytDuration": cand.get("duration"),
            }
    if best is None:
        logger.log("matchTrack: no candidates", {"title": track["title"]})
        return {"status": "not_found", "score": 0}
    if best["score"] >= settings.match_accept:
        best["status"] = "matched"
    elif best["score"] >= settings.match_uncertain:
        best["status"] = "uncertain"
    else:
        best["status"] = "not_found"
    logger.log(
        f"matchTrack: \"{track['title']}\" -> {best['status']} (score {best['score']:.2f})",
        {"title": track["title"], "status": best["status"], "score": best["score"], "videoId": best["videoId"]},
    )
    return best
