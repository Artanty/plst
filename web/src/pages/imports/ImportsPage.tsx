import { useNavigate } from 'react-router-dom';
import { useLibraryApi } from '../../core/library-api';
import { useSession } from '../../core/session';
import { plural, timeAgo } from '../../core/format';
import { Loader } from '../../layout/Loader';
import './imports.scss';

/**
 * The queue. Building a playlist from an import is a PAGE now (route /imports/:id/build), not a
 * drawer: the drawer's state died with the page it was drawn on, and a half-ticked 200-track
 * import was one accidental reload away from being redone by hand.
 */
export default function ImportsPage() {
  const api = useLibraryApi();
  const session = useSession();
  const navigate = useNavigate();

  const imports = api.pendingImports;

  return (
    <div className="page-imports">
      <section className="head">
        <h1>Imports</h1>
        <p className="muted">
          Every scan the extension sends lands here first. Nothing is in a playlist until you say so
          — that is the whole point of the queue.
        </p>
      </section>

      {imports.loading ? (
        <Loader />
      ) : (imports.data?.imports ?? []).length === 0 ? (
        <p className="muted">
          Nothing pending for <strong>{session.userId}</strong>. Scan a playlist in the extension
          and press “Import to my library”, and it will show up here.
        </p>
      ) : (
        <ul className="cards">
          {(imports.data?.imports ?? []).map((imp) => (
            <li key={imp.id} className="card">
              <div className="row">
                <div>
                  <h2>{imp.source_label ?? 'Scanned playlist'}</h2>
                  <p className="meta">
                    {plural(imp.item_count, 'track')} · {imp.new_song_count} new to the library ·
                    scanned {timeAgo(imp.created_at)}
                    {imp.page_url && (
                      <>
                        {' · '}
                        <a href={imp.page_url} target="_blank" rel="noopener">
                          source
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <button className="primary" onClick={() => navigate(`/imports/${imp.id}/build`)}>
                  Build playlist
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
