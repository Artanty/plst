import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLibraryApi } from '../../core/library-api';
import { useSession } from '../../core/session';
import { useResource } from '../../core/useResource';
import { artistCredit, durationText, timeAgo } from '../../core/format';
import { errorText } from '../../core/http';
import type { Collaborator, PlaylistDetail, Song, YoutubeExport } from '../../core/models';
import { Loader } from '../../layout/Loader';
import './playlist-detail.scss';

export default function PlaylistDetailPage() {
  const api = useLibraryApi();
  const session = useSession();
  const navigate = useNavigate();
  const { id: idParam } = useParams();
  const id = Number(idParam);

  const detail = useResource<{ playlist: PlaylistDetail; collaborators: Collaborator[] }>(
    `/api/library/playlists/${id}`,
    api.reloadTick,
    session.userId,
  );

  const playlist = detail.data?.playlist ?? null;
  const items = playlist?.items ?? [];
  const collaborators = detail.data?.collaborators ?? [];

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUserId, setShareUserId] = useState<number | null>(null);
  const [shareCanEdit, setShareCanEdit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [pickerQuery, setPickerQuery] = useState('');
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  // An empty query is deliberately NOT sent: it would dump the whole library into the picker.
  const candidates = useResource<{ songs: Song[] }>(
    pickerQuery.trim()
      ? `/api/library/songs?q=${encodeURIComponent(pickerQuery.trim())}&limit=20`
      : undefined,
    session.userId,
    session.userId,
  );

  const name = playlist?.name;
  useEffect(() => {
    if (name && !editingName) setDraftName(name);
  }, [name, editingName]);

  const isOwner = playlist?.owner_id === session.userId;

  const startRename = () => {
    setDraftName(playlist?.name ?? '');
    setEditingName(true);
  };

  const commitRename = async () => {
    const nextName = draftName.trim();
    if (!nextName || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.renamePlaylist(id, nextName);
      setBusy(false);
      setEditingName(false);
      api.refresh();
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const remove = async (itemId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.removeTrack(id, itemId);
      setBusy(false);
      api.refresh();
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const confirmDelete = async () => {
    if (busy) return;
    if (!confirm('Delete this playlist? The songs stay in your library.')) return;
    setBusy(true);
    try {
      await api.deletePlaylist(id);
      setBusy(false);
      api.refresh();
      navigate('/playlists');
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const togglePick = (songId: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId);
      else next.add(songId);
      return next;
    });

  const addPicked = async () => {
    const ids = [...picked];
    if (!ids.length || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.addTracks(id, ids);
      setBusy(false);
      setPicked(new Set());
      setPickerQuery('');
      setMessage(`Added ${res.added} track(s). ${res.notifiedUsers} collaborator(s) notified.`);
      api.refresh();
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const share = async () => {
    if (shareUserId === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.share(id, shareUserId, shareCanEdit);
      setBusy(false);
      setShareOpen(false);
      setMessage('Shared — they get a notification next time they load the app.');
      api.refresh();
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const unshare = async (userIdToUnshare: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.unshare(id, userIdToUnshare);
      setBusy(false);
      api.refresh();
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  // ------------------------------------------------------- youtube links

  const [report, setReport] = useState<YoutubeExport | null>(null);
  const [matchingAll, setMatchingAll] = useState(false);
  const matchedCount = items.filter((i) => i.song.yt_video_id).length;

  const matchOne = async (songId: number) => {
    if (busy || matchingAll) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.matchSong(songId);
      setBusy(false);
      api.refresh();
      setMessage(
        res.status === 'search_failed'
          ? `⚠ YouTube Music was unreachable — “${res.title ?? 'this song'}” was never searched. ${res.reason ?? ''}`
          : res.status === 'not_found'
            ? `No YouTube Music match for “${res.title ?? 'this song'}”.`
            : `✓ matched (${Math.round(res.score * 100)}%)`,
      );
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const matchAll = async () => {
    if (busy || matchingAll) return;
    setMatchingAll(true);
    setBusy(true);
    setMessage('matching… this is one YouTube search per song, so it takes a moment');
    try {
      const res = await api.matchPlaylist(id);
      setMatchingAll(false);
      setBusy(false);
      api.refresh();
      // The distinction that decides the next action: if EVERY failure is search_failed, no song
      // was ever asked about — say "YouTube unreachable, fix the network and retry", not "0 of 7
      // matched" (which reads as "these songs don't exist there" and stops the reader cold).
      setMessage(
        res.searchFailed === res.total && res.total > 0
          ? `⚠ YouTube Music was unreachable — none of the ${res.total} songs were searched. Start your proxy and press match all again.`
          : res.searchFailed > 0
            ? `✓ ${res.matched} of ${res.total} songs matched — ${res.searchFailed} could not be searched (YouTube Music unreachable), match again after fixing the connection`
            : `✓ ${res.matched} of ${res.total} songs matched`,
      );
    } catch (err) {
      setMatchingAll(false);
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const exportLinks = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setReport(await api.exportYoutube({ playlistId: id }));
      setBusy(false);
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  const copyExport = async (text: string, matched: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`✓ copied ${matched} link(s)`);
    } catch (err) {
      setMessage(
        `could not use the clipboard (${(err as Error)?.name ?? 'unknown'}) — select the text instead`,
      );
    }
  };

  if (playlist) {
    return (
      <div className="page-playlist-detail">
        <section className="head">
          <Link className="back" to="/playlists">
            ← playlists
          </Link>

          <div className="titleRow">
            {editingName ? (
              <>
                <input
                  className="rename"
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  aria-label="Playlist name"
                />
                <button className="primary" disabled={busy} onClick={commitRename}>
                  Save
                </button>
                <button className="ghost" onClick={() => setEditingName(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <h1>{playlist.name}</h1>
                {playlist.can_edit && (
                  <button className="ghost" onClick={startRename}>
                    rename
                  </button>
                )}
              </>
            )}
          </div>

          <p className="meta">
            by {playlist.owner_username} · {items.length} tracks ·{' '}
            {playlist.can_edit ? <>you can edit</> : <span className="ro">view only</span>} ·
            updated {timeAgo(playlist.updated_at)}
          </p>

          {message && <p className="note">{message}</p>}
        </section>

        {isOwner && (
          <section className="share">
            <h2>Shared with</h2>
            <ul className="people">
              {collaborators.map((c) => (
                <li key={c.user_id}>
                  <span>{c.display_name || c.username}</span>
                  <span className="role">{c.can_edit ? 'can edit' : 'view only'}</span>
                  <button className="ghost" onClick={() => unshare(c.user_id)}>
                    remove
                  </button>
                </li>
              ))}
              {collaborators.length === 0 && <li className="muted">not shared with anyone</li>}
            </ul>

            {shareOpen ? (
              <div className="shareForm">
                <select
                  value={shareUserId ?? ''}
                  onChange={(e) =>
                    setShareUserId(e.target.value === '' ? null : Number(e.target.value))
                  }
                  aria-label="Share with user"
                >
                  <option value="">pick a user…</option>
                  {session.users
                    .filter((u) => u.id !== session.userId)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name || u.username}
                      </option>
                    ))}
                </select>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={shareCanEdit}
                    onChange={(e) => setShareCanEdit(e.target.checked)}
                  />
                  can edit
                </label>
                <button className="primary" disabled={busy || shareUserId === null} onClick={share}>
                  Share
                </button>
                <button className="ghost" onClick={() => setShareOpen(false)}>
                  cancel
                </button>
              </div>
            ) : (
              <button className="ghost" onClick={() => setShareOpen(true)}>
                + share this playlist
              </button>
            )}

            <button className="danger" onClick={confirmDelete}>
              delete playlist
            </button>
          </section>
        )}

        {playlist.can_edit && (
          <section className="picker">
            <h2>Add tracks</h2>
            <div className="pickerRow">
              <input
                type="search"
                placeholder="find a song by title or artist…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                aria-label="Find a track to add"
              />
              <button className="primary" disabled={busy || picked.size === 0} onClick={addPicked}>
                Add {picked.size ? `(${picked.size})` : ''}
              </button>
            </div>

            {pickerQuery.trim() && (
              <ul className="found">
                {(candidates.data?.songs ?? []).map((s) => (
                  <li key={s.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.has(s.id)}
                        onChange={() => togglePick(s.id)}
                      />
                      <span className="t">{s.title}</span>
                      <span className="a">
                        {s.artists.map((ar) => (
                          <span key={ar.id}>{ar.name}</span>
                        ))}
                      </span>
                    </label>
                  </li>
                ))}
                {(candidates.data?.songs ?? []).length === 0 && (
                  <li className="muted">nothing matches “{pickerQuery}”</li>
                )}
              </ul>
            )}
          </section>
        )}

        <section className="yt">
          <div className="ytRow">
            <strong>{matchedCount}</strong> of {items.length} matched with YouTube Music
            <button disabled={busy || matchingAll || !items.length} onClick={matchAll}>
              {matchingAll ? 'matching…' : 'match all'}
            </button>
            <button disabled={busy || !items.length} onClick={exportLinks}>
              export links
            </button>
          </div>

          {report && (
            <div className="export">
              <div className="head">
                <strong>{report.matched}</strong> of {report.total} matched
                {report.searchFailed.length > 0 && (
                  <span className="warn">{report.searchFailed.length} never searched (YouTube unreachable)</span>
                )}
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
                  {report.uncertain.length} uncertain match(es) are in the export as comments, not
                  as links — pasting will skip them on purpose:{' '}
                  {report.uncertain.map((u) => (
                    <span key={u.songId} className="chipgap">
                      {u.title} → {u.url}
                    </span>
                  ))}
                </p>
              )}
              {report.searchFailed.length > 0 && (
                <p className="warnp">
                  These songs were never searched — YouTube Music was unreachable when matching
                  ran. Fix the connection (is the proxy running?) and match again:{' '}
                  {report.searchFailed.map((u) => (
                    <span key={u.songId} className="chipgap">
                      {u.title}
                    </span>
                  ))}
                </p>
              )}
              {report.unmatched.length > 0 && (
                <p className="muted">
                  Unmatched songs are listed as comments in the export, so a short list cannot look
                  like a complete one:{' '}
                  {report.unmatched.map((u) => (
                    <span key={u.songId} className="chipgap">
                      {u.title}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}
        </section>

        <ol className="tracks">
          {items.map((item) => (
            <li key={item.id}>
              <span className="pos">{item.position + 1}</span>
              <span className="t">{item.song.title}</span>
              <span className="a">{artistCredit(item.song)}</span>
              <span className="al">{item.song.album_title ?? ''}</span>
              <span className="d">{durationText(item.song.duration_s)}</span>
              <span className="ytlink">
                {item.song.yt_video_id ? (
                  <a
                    href={`https://music.youtube.com/watch?v=${item.song.yt_video_id}`}
                    target="_blank"
                    rel="noopener"
                  >
                    yt
                  </a>
                ) : (
                  <button className="linky" disabled={busy} onClick={() => matchOne(item.song.id)}>
                    find
                  </button>
                )}
              </span>
              <span className="by" title={`added by ${item.added_by_username}`}>
                +{item.added_by_username}
              </span>
              {playlist.can_edit && (
                <button
                  className="x"
                  onClick={() => remove(item.id)}
                  aria-label={`Remove ${item.song.title}`}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="muted">No tracks yet.</li>}
        </ol>
      </div>
    );
  }

  if (detail.error) {
    return (
      <div className="page-playlist-detail">
        <p className="err">could not load this playlist: {detail.error}</p>
      </div>
    );
  }

  if (detail.loading) {
    return (
      <div className="page-playlist-detail">
        <Loader />
      </div>
    );
  }

  return <div className="page-playlist-detail" />;
}
