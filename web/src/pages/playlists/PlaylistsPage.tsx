import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLibraryApi } from '../../core/library-api';
import { plural, timeAgo } from '../../core/format';
import { errorText } from '../../core/http';
import { Loader } from '../../layout/Loader';
import './playlists.scss';

export default function PlaylistsPage() {
  const api = useLibraryApi();

  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const playlists = api.playlists;
  const mine = playlists.data?.mine ?? [];
  const shared = playlists.data?.shared ?? [];

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.createPlaylist(name, null);
      setNewName('');
      api.refresh();
    } catch (err) {
      setBusy(false);
      setMessage(errorText(err));
    }
  };

  return (
    <div className="page-playlists">
      <section className="head">
        <h1>Playlists</h1>
        <form className="new" onSubmit={create}>
          <input
            type="text"
            placeholder="new playlist name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New playlist name"
          />
          <button className="primary" type="submit" disabled={busy || !newName.trim()}>
            Create
          </button>
        </form>
        {message && <p className="err">{message}</p>}
      </section>

      {playlists.loading ? (
        <Loader />
      ) : (
        <>
          <h2 className="section">Yours</h2>
          <ul className="list">
            {mine.map((p) => (
              <li key={p.id}>
                <Link to={`/playlists/${p.id}`}>
                  <span className="name">{p.name}</span>
                  <span className="meta">
                    {plural(p.item_count, 'track')} · updated {timeAgo(p.updated_at)}
                  </span>
                </Link>
              </li>
            ))}
            {mine.length === 0 && (
              <li className="muted empty">
                No playlists yet. Build one from an import, or create an empty one above.
              </li>
            )}
          </ul>

          <h2 className="section">Shared with you</h2>
          <ul className="list">
            {shared.map((p) => (
              <li key={p.id}>
                <Link to={`/playlists/${p.id}`}>
                  <span className="name">{p.name}</span>
                  <span className="meta">
                    by {p.owner_username} · {plural(p.item_count, 'track')} ·{' '}
                    <span className={p.can_edit ? 'editable' : undefined}>
                      {p.can_edit ? 'you can edit' : 'view only'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            {shared.length === 0 && <li className="muted empty">Nothing shared with you yet.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
