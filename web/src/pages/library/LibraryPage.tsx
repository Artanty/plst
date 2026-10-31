import { useState } from 'react';
import { PAGE, useLibraryApi } from '../../core/library-api';
import { artistCredit, durationText, plural, timeAgo } from '../../core/format';
import { errorText } from '../../core/http';
import type { YoutubeExport } from '../../core/models';
import { Loader } from '../../layout/Loader';
import './library.scss';

export default function LibraryPage() {
  const api = useLibraryApi();

  const [playlistName, setPlaylistName] = useState('');
  const [targetPlaylist, setTargetPlaylist] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [matching, setMatching] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [report, setReport] = useState<YoutubeExport | null>(null);

  const songs = api.songs;
  const total = songs.data?.total ?? 0;
  const from = total === 0 ? 0 : api.offset + 1;
  const to = Math.min(api.offset + PAGE, total);

  const hasFilters =
    !!api.query.trim() ||
    api.albumFilter !== null ||
    api.artistFilter !== null ||
    api.genreFilter !== null;

  const setSearch = (value: string) => {
    api.setQuery(value);
    api.setOffset(0);
  };
  const filter = (setter: (id: number | null) => void, current: number | null, id: number) => {
    setter(current === id ? null : id);
    api.setOffset(0);
  };
  const clear = () => {
    api.setQuery('');
    api.setAlbumFilter(null);
    api.setArtistFilter(null);
    api.setGenreFilter(null);
    api.setOffset(0);
  };
  const next = () => {
    if (to < total) api.setOffset(api.offset + PAGE);
  };
  const prev = () => api.setOffset(Math.max(0, api.offset - PAGE));

  // -------------------------------------------------- selection -> playlist

  const pageIds = (songs.data?.songs ?? []).map((s) => s.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => api.isSelected(id));
  const togglePage = () => api.selectPage(pageIds, !allOnPageSelected);

  const finish = (ok: string) => {
    setBusy(false);
    api.clearSelection();
    setMessage(ok);
  };

  const createPlaylist = async () => {
    const name = playlistName.trim();
    const songIds = api.selectedList;
    if (!name || !songIds.length || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.createPlaylistFromSelection(name, songIds);
      setPlaylistName('');
      finish(`✓ “${name}” — ${plural(res.added, 'song')} added`);
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const addToPlaylist = async () => {
    const songIds = api.selectedList;
    if (typeof targetPlaylist !== 'number' || !songIds.length || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.addTracks(targetPlaylist, songIds);
      setTargetPlaylist('');
      finish(`✓ ${plural(res.added, 'song')} added to the playlist`);
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  /** Playlists that can be written to: yours, plus shared ones you may edit. */
  const editablePlaylists = [
    ...(api.playlists.data?.mine ?? []).map((p) => ({ id: p.id, name: p.name, shared: false })),
    ...(api.playlists.data?.shared ?? [])
      .filter((p) => p.can_edit)
      .map((p) => ({ id: p.id, name: p.name, shared: true })),
  ];

  // ------------------------------------------------------- youtube links

  const songTitle = (songId: number) =>
    songs.data?.songs.find((s) => s.id === songId)?.title ?? `#${songId}`;

  const matchOne = async (songId: number) => {
    if (busy) return;
    setMatching(songId);
    setMessage(null);
    try {
      const res = await api.matchSong(songId);
      setMatching(null);
      api.refresh();
      setMessage(
        res.status === 'search_failed'
          ? `⚠ YouTube Music was unreachable — “${songTitle(songId)}” was never searched. ${res.reason ?? ''} — fix the connection and match again.`
          : res.status === 'not_found'
            ? `no YouTube Music match for “${res.ytTitle ?? songTitle(songId)}” — nothing was stored`
            : `✓ matched (${Math.round(res.score * 100)}%)`,
      );
    } catch (err) {
      setMatching(null);
      setMessage(errorText(err));
    }
  };

  const matchSelected = async () => {
    const ids = api.selectedList;
    if (!ids.length || exporting) return;
    setExporting(true);
    setMessage(`matching ${plural(ids.length, 'song')}…`);
    // Sequential on purpose: each match can fan out into several YouTube searches, and firing 50 at
    // once from a browser is exactly the kind of thing that gets rate-limited into uselessness.
    try {
      for (const id of ids) await api.matchSong(id);
      api.refresh();
      setMessage(`✓ matched ${plural(ids.length, 'song')}`);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const exportSelected = async () => {
    const ids = api.selectedList;
    if (!ids.length || exporting) return;
    setExporting(true);
    setMessage(null);
    try {
      setReport(await api.exportYoutube({ songIds: ids }));
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const copyExport = async (text: string, matched: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`✓ copied ${plural(matched, 'link')}`);
    } catch (err) {
      // Non-secure contexts have no navigator.clipboard. Say so instead of leaving the user
      // clicking a button that appears broken — the textarea above is selectable either way.
      setMessage(
        `could not use the clipboard (${(err as Error)?.name ?? 'unknown'}) — select the text above instead`,
      );
    }
  };

  return (
    <div className="page-library">
      <section className="head">
        <h1>Library</h1>
        <input
          className="search"
          type="search"
          placeholder="search by title or artist…"
          value={api.query}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the library by title or artist"
        />
        {hasFilters && (
          <button className="ghost" onClick={clear}>
            clear filters
          </button>
        )}
      </section>

      <section className="facets">
        <div className="facet">
          <h2>Genres</h2>
          {api.genres.data?.genres.length ? (
            <div className="chips">
              {api.genres.data.genres.map((g) => (
                <button
                  key={g.id}
                  className={`chip${api.genreFilter === g.id ? ' on' : ''}`}
                  onClick={() => filter(api.setGenreFilter, api.genreFilter, g.id)}
                >
                  {g.name} <span className="n">{g.song_count}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              No genres yet. The table and the filter are ready — a genre provider just has not
              filled it in.
            </p>
          )}
        </div>

        <div className="facet">
          <h2>Artists</h2>
          <div className="chips scroll">
            {(api.artists.data?.artists ?? []).map((a) => (
              <button
                key={a.id}
                className={`chip${api.artistFilter === a.id ? ' on' : ''}`}
                onClick={() => filter(api.setArtistFilter, api.artistFilter, a.id)}
              >
                {a.name}
              </button>
            ))}
            {!api.artists.data?.artists.length && <p className="muted">nothing scanned yet</p>}
          </div>
        </div>

        <div className="facet">
          <h2>Albums</h2>
          <div className="chips scroll">
            {(api.albums.data?.albums ?? []).map((al) => (
              <button
                key={al.id}
                className={`chip${api.albumFilter === al.id ? ' on' : ''}`}
                onClick={() => filter(api.setAlbumFilter, api.albumFilter, al.id)}
              >
                {al.title} <span className="n">{al.song_count}</span>
              </button>
            ))}
            {!api.albums.data?.albums.length && <p className="muted">nothing scanned yet</p>}
          </div>
        </div>
      </section>

      {songs.loading ? (
        <Loader />
      ) : songs.error ? (
        <p className="err">could not load the library: {songs.error}</p>
      ) : (
        <>
          <p className="count">
            {total === 0
              ? 'nothing here yet — scan a playlist in the extension, then press “Import to my library”.'
              : `showing ${from}–${to} of ${plural(total, 'song')}`}
          </p>

          <table className="songs">
            <thead>
              <tr>
                <th className="pick">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={togglePage}
                    disabled={!pageIds.length}
                    aria-label="Select every song on this page"
                  />
                </th>
                <th>Title</th>
                <th>Artists</th>
                <th>Album</th>
                <th className="num">Time</th>
                <th className="num">Seen</th>
                <th className="num">YouTube</th>
              </tr>
            </thead>
            <tbody>
              {(songs.data?.songs ?? []).map((s) => (
                <tr key={s.id} className={api.isSelected(s.id) ? 'picked' : undefined}>
                  <td className="pick">
                    <input
                      type="checkbox"
                      checked={api.isSelected(s.id)}
                      onChange={() => api.toggleSelected(s.id)}
                      aria-label={`Select ${s.title}`}
                    />
                  </td>
                  <td className="title">{s.title}</td>
                  <td className="artists">{artistCredit(s)}</td>
                  <td className="album">{s.album_title ?? '—'}</td>
                  <td className="num">{durationText(s.duration_s)}</td>
                  <td className="num" title={`first seen ${timeAgo(s.first_seen_at)}`}>
                    {s.seen_count}×
                  </td>
                  <td className="num">
                    {s.yt_video_id ? (
                      <a
                        href={`https://music.youtube.com/watch?v=${s.yt_video_id}`}
                        target="_blank"
                        rel="noopener"
                      >
                        link
                      </a>
                    ) : (
                      <button
                        className="linky"
                        disabled={matching !== null}
                        onClick={() => matchOne(s.id)}
                      >
                        {matching === s.id ? 'matching…' : 'find match'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {api.selectedCount > 0 ? (
            <div className="selbar">
              <strong>{api.selectedCount}</strong> selected
              <input
                className="name"
                type="text"
                placeholder="new playlist name…"
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                aria-label="Name for the new playlist"
              />
              <button disabled={busy || !playlistName.trim()} onClick={createPlaylist}>
                create playlist
              </button>
              <select
                value={targetPlaylist}
                onChange={(e) =>
                  setTargetPlaylist(e.target.value === '' ? '' : Number(e.target.value))
                }
                aria-label="Add the selection to an existing playlist"
              >
                <option value="">add to…</option>
                {editablePlaylists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.shared ? ' (shared)' : ''}
                  </option>
                ))}
              </select>
              <button disabled={busy || targetPlaylist === ''} onClick={addToPlaylist}>
                add
              </button>
              <button className="ghost" disabled={busy} onClick={() => api.clearSelection()}>
                clear
              </button>
              <span className="spacer" />
              <button disabled={exporting} onClick={matchSelected}>
                match with YouTube
              </button>
              <button disabled={exporting} onClick={exportSelected}>
                export links
              </button>
              {message && <span className="msg">{message}</span>}
            </div>
          ) : (
            message && <p className="msg standalone">{message}</p>
          )}

          {report && (
            <div className="export" role="dialog" aria-label="YouTube Music links">
              <div className="head">
                <strong>{report.matched}</strong> of {report.total} matched
                {report.unmatched.length > 0 && (
                  <span className="warn">{report.unmatched.length} without a match</span>
                )}
                <span className="spacer" />
                <button onClick={() => copyExport(report.text, report.matched)}>copy links</button>
                <button className="ghost" onClick={() => setReport(null)}>
                  close
                </button>
              </div>
              <textarea readOnly value={report.text} rows={10} aria-label="The exported links" />
              {report.uncertain.length > 0 && (
                <p className="warnp">
                  {report.uncertain.length} uncertain match(es) are comments, not links, so pasting
                  skips them on purpose:{' '}
                  {report.uncertain.map((u) => (
                    <span key={u.songId} className="chipgap">
                      {u.title} → {u.url}
                    </span>
                  ))}
                </p>
              )}
              {report.unmatched.length > 0 && (
                <p className="muted">
                  Listed but unmatched — they are in the export as comments so the list cannot
                  quietly look complete:{' '}
                  {report.unmatched.map((u) => (
                    <span key={u.songId} className="chipgap">
                      {u.title}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          {total > PAGE && (
            <div className="pager">
              <button className="ghost" disabled={api.offset === 0} onClick={prev}>
                ← prev
              </button>
              <button className="ghost" disabled={to >= total} onClick={next}>
                next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
