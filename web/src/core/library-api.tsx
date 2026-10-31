import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { apiFetch } from './http';
import { useResource, type Resource } from './useResource';
import { useSession } from './session';
import type {
  Album,
  AppNotification,
  Artist,
  Genre,
  ImportRow,
  MatchResultDto,
  Me,
  Playlist,
  SongsPage,
  User,
  YandexRef,
  YoutubeExport,
} from './models';

const BASE = '/api/library';

interface NotificationsResponse {
  notifications: AppNotification[];
  unread: number;
  pendingImports: number;
}

interface ScanResponse {
  importId: number;
  trackCount: number;
  newCount: number;
  dupCount: number;
  skippedCount: number;
  pendingImports: number;
}

export interface LibraryApiValue {
  /** A single refresh token for every resource, so one write refreshes every view. */
  reloadTick: number;
  refresh: () => void;

  users: Resource<{ users: User[] }>;
  me: Resource<Me>;
  notifications: Resource<NotificationsResponse>;
  pendingImports: Resource<{ imports: ImportRow[] }>;
  genres: Resource<{ genres: Genre[] }>;
  artists: Resource<{ artists: Artist[] }>;
  albums: Resource<{ albums: Album[] }>;
  playlists: Resource<{ mine: Playlist[]; shared: Playlist[] }>;
  songs: Resource<SongsPage>;

  /** Search inputs, owned by the library page — see the selection note below. */
  query: string;
  setQuery: (value: string) => void;
  albumFilter: number | null;
  artistFilter: number | null;
  genreFilter: number | null;
  setAlbumFilter: (id: number | null) => void;
  setArtistFilter: (id: number | null) => void;
  setGenreFilter: (id: number | null) => void;
  offset: number;
  setOffset: (value: number) => void;

  // ------------------------------------------------------------ selection
  //
  // Lives here rather than in the library page because the songs resource is PAGED: a selection
  // held by the page component would be rebuilt from whatever rows are currently rendered, so
  // ticking a song on page 1 and then pressing "next" would silently drop it. This is the same
  // reason the search inputs are here instead of in the component.
  selection: ReadonlySet<number>;
  selectedCount: number;
  selectedList: number[];
  isSelected: (songId: number) => boolean;
  toggleSelected: (songId: number) => void;
  /** Only for the rows currently on screen — selecting every song in a filtered library is a mistake. */
  selectPage: (songIds: number[], on: boolean) => void;
  clearSelection: () => void;

  // -------------------------------------------------------------- mutations

  createPlaylistFromImport: (
    importId: number,
    name: string,
    songIds?: number[],
  ) => Promise<{ playlistId: number; trackCount: number }>;
  createPlaylist: (name: string, description: string | null) => Promise<{ playlistId: number }>;
  /**
   * "Create a playlist from the library" in one request. Two calls (create, then add) would leave an
   * empty playlist behind if the second failed, and the user would have to clean it up by hand.
   */
  createPlaylistFromSelection: (
    name: string,
    songIds: number[],
  ) => Promise<{ playlistId: number; added: number }>;
  renamePlaylist: (playlistId: number, name: string) => Promise<{ ok: true }>;
  deletePlaylist: (playlistId: number) => Promise<{ ok: true }>;
  addTracks: (
    playlistId: number,
    songIds: number[],
  ) => Promise<{ added: number; notifiedUsers: number }>;
  removeTrack: (playlistId: number, itemId: number) => Promise<{ ok: true }>;
  share: (playlistId: number, userId: number, canEdit: boolean) => Promise<unknown>;
  unshare: (playlistId: number, userId: number) => Promise<{ ok: true }>;
  markRead: (ids?: number[]) => Promise<{ marked: number }>;
  /** Used by the extension replay in tests; not called from the app itself. */
  scan: (payload: { userId: number; tracks: unknown[]; pageUrl?: string }) => Promise<ScanResponse>;

  // ------------------------------------------------------- youtube music

  matchSong: (songId: number) => Promise<MatchResultDto>;
  matchPlaylist: (
    playlistId: number,
  ) => Promise<{ playlistId: number; total: number; matched: number; searchFailed: number }>;
  /**
   * "listen" — resolve a song to its music.yandex.ru page. 404 means nothing matched; the backend
   * never guesses a track, so the button must never open a wrong song silently.
   */
  yandexListen: (songId: number) => Promise<YandexRef>;
  /**
   * The export. Asks for JSON rather than text because the UI has to show "12 of 15 matched" —
   * text/plain cannot say that, and a bare list of links is exactly the output that hides its own
   * gaps.
   */
  exportYoutube: (target: { playlistId: number } | { songIds: number[] }) => Promise<YoutubeExport>;
}

const LibraryApiContext = createContext<LibraryApiValue | null>(null);

export function LibraryApiProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const { userId } = session;

  const [reloadTick, setReloadTick] = useState(0);
  // Stable: callers hold this in effects/deps and must not see its identity change between renders.
  const refresh = useCallback(() => setReloadTick((n) => n + 1), []);

  const [query, setQuery] = useState('');
  const [albumFilter, setAlbumFilterRaw] = useState<number | null>(null);
  const [artistFilter, setArtistFilterRaw] = useState<number | null>(null);
  const [genreFilter, setGenreFilterRaw] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);

  const [selection, setSelection] = useState<ReadonlySet<number>>(() => new Set());

  // One key for every per-user resource: bumping the tick or switching the user refetches them all.
  const userKey = `${reloadTick}:${userId}`;

  const users = useResource<{ users: User[] }>(`${BASE}/users`, 'static', userId);
  const me = useResource<Me>(`${BASE}/me`, userKey, userId);
  const notifications = useResource<NotificationsResponse>(
    `${BASE}/notifications`,
    userKey,
    userId,
  );
  const pendingImports = useResource<{ imports: ImportRow[] }>(
    `${BASE}/imports/pending`,
    userKey,
    userId,
  );
  const genres = useResource<{ genres: Genre[] }>(`${BASE}/genres`, 'static', userId);
  const artists = useResource<{ artists: Artist[] }>(`${BASE}/artists`, 'static', userId);
  const albums = useResource<{ albums: Album[] }>(`${BASE}/albums`, 'static', userId);
  const playlists = useResource<{ mine: Playlist[]; shared: Playlist[] }>(
    `${BASE}/playlists`,
    userKey,
    userId,
  );

  const songsPath = useMemo(() => {
    const params = new URLSearchParams();
    const q = query.trim();
    if (q) params.set('q', q);
    if (albumFilter !== null) params.set('albumId', String(albumFilter));
    if (artistFilter !== null) params.set('artistId', String(artistFilter));
    if (genreFilter !== null) params.set('genreId', String(genreFilter));
    params.set('limit', String(PAGE));
    params.set('offset', String(offset));
    return `${BASE}/songs?${params.toString()}`;
  }, [query, albumFilter, artistFilter, genreFilter, offset]);

  const songs = useResource<SongsPage>(songsPath, userKey, userId);

  const post = <T,>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body, userId });
  const patch = <T,>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body, userId });
  const del = <T,>(path: string) => apiFetch<T>(path, { method: 'DELETE', userId });

  const value: LibraryApiValue = {
    reloadTick,
    refresh,

    users,
    me,
    notifications,
    pendingImports,
    genres,
    artists,
    albums,
    playlists,
    songs,

    query,
    setQuery,
    albumFilter,
    artistFilter,
    genreFilter,
    setAlbumFilter: setAlbumFilterRaw,
    setArtistFilter: setArtistFilterRaw,
    setGenreFilter: setGenreFilterRaw,
    offset,
    setOffset,

    selection,
    selectedCount: selection.size,
    selectedList: [...selection],
    isSelected: (songId: number) => selection.has(songId),
    toggleSelected: (songId: number) =>
      setSelection((prev) => {
        const next = new Set(prev);
        if (!next.delete(songId)) next.add(songId);
        return next;
      }),
    selectPage: (songIds: number[], on: boolean) =>
      setSelection((prev) => {
        const next = new Set(prev);
        for (const id of songIds) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
    clearSelection: () => setSelection(new Set()),

    createPlaylistFromImport: (importId, name, songIds) =>
      post(`${BASE}/imports/${importId}/playlist`, {
        name,
        ...(songIds?.length ? { songIds } : {}),
      }),
    createPlaylist: (name, description) => post(`${BASE}/playlists`, { name, description }),
    createPlaylistFromSelection: (name, songIds) => post(`${BASE}/playlists`, { name, songIds }),
    renamePlaylist: (playlistId, name) => patch(`${BASE}/playlists/${playlistId}`, { name }),
    deletePlaylist: (playlistId) => del(`${BASE}/playlists/${playlistId}`),
    addTracks: (playlistId, songIds) => post(`${BASE}/playlists/${playlistId}/items`, { songIds }),
    removeTrack: (playlistId, itemId) => del(`${BASE}/playlists/${playlistId}/items/${itemId}`),
    share: (playlistId, userIdToShare, canEdit) =>
      post(`${BASE}/playlists/${playlistId}/share`, { userId: userIdToShare, canEdit }),
    unshare: (playlistId, userIdToUnshare) =>
      del(`${BASE}/playlists/${playlistId}/share/${userIdToUnshare}`),
    markRead: (ids) => post(`${BASE}/notifications/read`, ids?.length ? { ids } : {}),
    scan: (payload) => post(`${BASE}/scan`, payload),

    matchSong: (songId) => post(`${BASE}/songs/${songId}/match`, {}),
    matchPlaylist: (playlistId) => post(`${BASE}/playlists/${playlistId}/match`, {}),
    yandexListen: (songId) => apiFetch<YandexRef>(`${BASE}/songs/${songId}/yandex`, { userId }),
    exportYoutube: (target) => {
      const qs =
        'playlistId' in target
          ? `playlistId=${target.playlistId}`
          : `songIds=${target.songIds.join(',')}`;
      return apiFetch<YoutubeExport>(`${BASE}/export/youtube?${qs}`, { userId });
    },
  };

  return <LibraryApiContext.Provider value={value}>{children}</LibraryApiContext.Provider>;
}

export function useLibraryApi(): LibraryApiValue {
  const value = useContext(LibraryApiContext);
  if (!value) throw new Error('useLibraryApi must be used inside <LibraryApiProvider>');
  return value;
}

export const PAGE = 50;
