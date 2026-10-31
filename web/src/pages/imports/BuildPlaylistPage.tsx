import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLibraryApi } from '../../core/library-api';
import { useSession } from '../../core/session';
import { useResource } from '../../core/useResource';
import { durationText } from '../../core/format';
import { errorText } from '../../core/http';
import type { ImportDetailView } from '../../core/models';
import { Loader } from '../../layout/Loader';
import { clearBuildState, loadBuildState, saveBuildState } from './build-state';
import './imports.scss';

/**
 * Build-playlist as a real page (route /imports/:id/build), not a drawer — and its form state
 * lives in localStorage (see build-state.ts), so a reload or the backend dropping mid-build
 * cannot cost you the ticks you already made. The page says so on screen when it restores.
 */
export default function BuildPlaylistPage() {
  const api = useLibraryApi();
  const session = useSession();
  const navigate = useNavigate();
  const importId = Number(useParams().id);

  const detail = useResource<ImportDetailView>(
    Number.isInteger(importId) && importId > 0 ? `/api/library/imports/${importId}` : undefined,
    api.reloadTick,
    session.userId,
  );
  const tracks = detail.data?.tracks ?? [];

  // Restored ONCE, before the tracks arrive: the saved ids are the truth about what was ticked,
  // and "untouched" (no saved state, or selected === null) means the NEW tracks — exactly what
  // the backend does with an empty form. That old drawer lied about this (it showed every track
  // ticked while the backend would have taken only the new ones); this page ticks what it sends.
  const [restored] = useState(() => loadBuildState(importId));
  const [name, setName] = useState(restored?.name ?? '');
  const [selected, setSelected] = useState<ReadonlySet<number> | null>(() =>
    restored?.selected ? new Set(restored.selected) : null,
  );
  const effective = useMemo(
    () => new Set(selected ?? tracks.filter((t) => t.isNew).map((t) => t.id)),
    [selected, tracks],
  );

  // Always an EXPLICIT list: what you see ticked is what is sent. (An empty selection can never
  // be sent — Create is disabled at zero — because the API would read it as "untouched" and fall
  // back to the backend's own new-songs default.)
  const songIds = useMemo(
    () => tracks.filter((t) => effective.has(t.id)).map((t) => t.id),
    [tracks, effective],
  );
  const selectedCount = songIds.length;
  const suggestedName = detail.data
    ? `${detail.data.import.source_label ?? 'Scanned playlist'} (${selectedCount} tracks)`
    : '';

  // Save on the interaction itself, not from an effect: an effect re-runs when the resource
  // refetches (api.refresh() right after a successful create), which would re-save the selection
  // moments after clearBuildState removed it — a stale selection for the next visit.
  const persist = (nextName: string, nextSelected: ReadonlySet<number>) =>
    saveBuildState(importId, {
      name: nextName || null,
      selected: [...nextSelected],
      savedAt: Date.now(),
    });

  const toggle = (id: number) => {
    const next = new Set(selected ?? tracks.filter((t) => t.isNew).map((t) => t.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    persist(name, next);
  };
  const selectAll = () => {
    const next = new Set(tracks.map((t) => t.id));
    setSelected(next);
    persist(name, next);
  };
  const selectNone = () => {
    setSelected(new Set());
    persist(name, new Set());
  };

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const build = async () => {
    if (busy || !songIds.length || !detail.data) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.createPlaylistFromImport(importId, name.trim() || suggestedName, songIds);
      clearBuildState(importId);
      api.refresh();
      navigate(`/playlists/${res.playlistId}`);
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  // "listen": resolve to the track's page on music.yandex.ru and open it. Per-row busy and a
  // single shared error line — a 404 means nothing matched, and the backend never guesses.
  const [listening, setListening] = useState<number | null>(null);
  const [listenMessage, setListenMessage] = useState<string | null>(null);
  const listen = async (songId: number) => {
    setListening(songId);
    setListenMessage(null);
    try {
      const ref = await api.yandexListen(songId);
      window.open(ref.url, '_blank', 'noopener');
    } catch (err) {
      setListenMessage(errorText(err));
    } finally {
      setListening(null);
    }
  };

  return (
    <div className="page-imports page-build">
      <section className="head">
        <p className="crumbs">
          <Link to="/imports">← imports</Link>
        </p>
        <h1>Build a playlist</h1>
        <p className="muted">
          from “{detail.data?.import.source_label ?? 'Scanned playlist'}”
          {detail.data?.import.page_url && (
            <>
              {' · '}
              <a href={detail.data.import.page_url} target="_blank" rel="noopener">
                source page
              </a>
            </>
          )}
          {restored && <>{' · '}selection restored from before</>}
        </p>
      </section>

      {detail.loading ? (
        <Loader label="loading tracks…" />
      ) : detail.error ? (
        <>
          <p className="err">could not load this import: {detail.error}</p>
          <p className="muted">Your selection is saved as you go — retry without losing it.</p>
          <button className="ghost" onClick={() => api.refresh()}>
            retry
          </button>
        </>
      ) : (
        <>
          <label className="field">
            <span>Playlist name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                persist(e.target.value, effective);
              }}
              placeholder={suggestedName}
            />
          </label>

          <div className="toolbar">
            <span className="meta">
              {selectedCount} of {tracks.length} selected
            </span>
            <div className="buttons">
              <button className="ghost" onClick={selectAll}>
                select all
              </button>
              <button className="ghost" onClick={selectNone}>
                select none
              </button>
            </div>
          </div>

          <ul className="tracks">
            {tracks.map((t) => (
              <li key={t.id} className="track-row">
                <label>
                  <input
                    type="checkbox"
                    checked={effective.has(t.id)}
                    onChange={() => toggle(t.id)}
                  />
                  <span className="t">{t.title}</span>
                  <span className="a">
                    {t.artists.map((ar) => (
                      <span key={ar.id} className={ar.role !== 'main' ? 'feat' : undefined}>
                        {ar.name}
                      </span>
                    ))}
                  </span>
                </label>
                <span className="right">
                  {t.isNew && <span className="new">new</span>}
                  <span className="d">{durationText(t.duration_s)}</span>
                  <button
                    className="ghost listen"
                    disabled={listening === t.id}
                    onClick={() => listen(t.id)}
                  >
                    {listening === t.id ? '…' : '▶ listen'}
                  </button>
                </span>
              </li>
            ))}
          </ul>

          {message && <p className="err">{message}</p>}
          {listenMessage && <p className="err">{listenMessage}</p>}

          <footer>
            <button className="primary" disabled={busy || selectedCount === 0} onClick={build}>
              {busy ? 'creating…' : 'Create playlist'}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
