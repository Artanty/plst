import { Link } from 'react-router-dom';
import { useLibraryApi } from '../../core/library-api';
import { notificationText, timeAgo } from '../../core/format';
import { Loader } from '../../layout/Loader';
import './notifications.scss';

export default function NotificationsPage() {
  const api = useLibraryApi();

  const data = api.notifications;
  const items = data.data?.notifications ?? [];
  const unread = data.data?.unread ?? 0;

  const markAllRead = () => {
    void api.markRead().then(() => api.refresh());
  };

  /** Where a notification wants to take you, or null when it is only a message. */
  const href = (n: { playlist_id: number | null; import_id: number | null }): string | null => {
    if (n.import_id) return '/imports';
    if (n.playlist_id) return `/playlists/${n.playlist_id}`;
    return null;
  };

  return (
    <div className="page-notifications">
      <section className="head">
        <h1>Alerts</h1>
        {unread > 0 && (
          <button className="ghost" onClick={markAllRead}>
            mark all read ({unread})
          </button>
        )}
      </section>

      {data.loading ? (
        <Loader />
      ) : items.length === 0 ? (
        <p className="muted">
          Nothing here. You get a notification when someone shares a playlist with you, or edits one
          you share.
        </p>
      ) : (
        <ul className="list">
          {items.map((n) => {
            const to = href(n);
            const body = (
              <>
                <span className="text">{notificationText(n)}</span>
                <span className="when">{timeAgo(n.created_at)}</span>
              </>
            );
            return (
              <li key={n.id} className={n.is_read ? undefined : 'unread'}>
                {to ? <Link to={to}>{body}</Link> : <div>{body}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
