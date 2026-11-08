"""Genre detection — port of back-node-js/src/library/genre.ts.

A provider interface with a no-op implementation, on purpose: the SCHEMA and the FILTER exist
(`genres` / `song_genres`) and the lookup is not built — every real option costs something
(Last.fm key, MusicBrainz budget, Spotify OAuth, AcousticBrainz discontinued). The moment an
adapter exists it implements this interface and nothing else changes.
"""
from lib.logger import logger


class NullGenreProvider:
    """The default. Says nothing, breaks nothing, costs nothing."""

    name = "none"

    def lookup(self, input_):
        """Returns [] — "leave the rows alone", never "clear them"."""
        return []


NULL_GENRE_PROVIDER = NullGenreProvider()


def genre_text(song) -> str:
    return ", ".join(g["name"] for g in song.get("genres") or [])


def describe_provider(provider) -> str:
    if provider is NULL_GENRE_PROVIDER:
        logger.log("genre provider: none configured — genres stay empty until an adapter is added")
    return provider.name
