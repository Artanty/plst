import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LibraryApiProvider } from './core/library-api';
import { SessionProvider } from './core/session';
import { Loader } from './layout/Loader';
import { Shell } from './layout/Shell';

const LibraryPage = lazy(() => import('./pages/library/LibraryPage'));
const ImportsPage = lazy(() => import('./pages/imports/ImportsPage'));
const BuildPlaylistPage = lazy(() => import('./pages/imports/BuildPlaylistPage'));
const PlaylistsPage = lazy(() => import('./pages/playlists/PlaylistsPage'));
const PlaylistDetailPage = lazy(() => import('./pages/playlist-detail/PlaylistDetailPage'));
const NotificationsPage = lazy(() => import('./pages/notifications/NotificationsPage'));

/** The `title:` on each Angular route, in one place: React has no per-route title option. */
function titleFor(path: string): string {
  if (/^\/imports\/\d+\/build/.test(path)) return 'Build playlist — plst';
  if (path.startsWith('/imports')) return 'Imports — plst';
  if (/^\/playlists\/\d+/.test(path)) return 'Playlist — plst';
  if (path.startsWith('/playlists')) return 'Playlists — plst';
  if (path.startsWith('/notifications')) return 'Alerts — plst';
  return 'Library — plst';
}

function DocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = titleFor(pathname);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <LibraryApiProvider>
          <DocumentTitle />
          <Shell>
            <Suspense fallback={<Loader label="loading the page…" />}>
              <Routes>
                <Route path="/" element={<Navigate to="/library" replace />} />
                <Route path="/library" element={<LibraryPage />} />
                <Route path="/imports" element={<ImportsPage />} />
                <Route path="/imports/:id/build" element={<BuildPlaylistPage />} />
                <Route path="/playlists" element={<PlaylistsPage />} />
                <Route path="/playlists/:id" element={<PlaylistDetailPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="*" element={<Navigate to="/library" replace />} />
              </Routes>
            </Suspense>
          </Shell>
        </LibraryApiProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
