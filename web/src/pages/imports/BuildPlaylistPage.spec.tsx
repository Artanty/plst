import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryApiProvider } from '../../core/library-api';
import { SessionProvider } from '../../core/session';
import type { Song } from '../../core/models';
import BuildPlaylistPage from './BuildPlaylistPage';
import { clearBuildState, loadBuildState, saveBuildState } from './build-state';

const IMPORT_ID = 7;

const artist = (id: number, name: string) => ({ id, name, role: 'main' });

const song = (over: Partial<Song> & { id: number; title: string; isNew: boolean }): Song & { isNew: boolean } => ({
  duration_s: 200,
  album_id: null,
  album_title: null,
  yt_video_id: null,
  match_score: null,
  first_seen_at: 0,
  last_seen_at: 0,
  seen_count: 1,
  play_count: 0,
  artists: [artist(10 + over.id, `Artist ${over.id}`)],
  genres: [],
  ...over,
});

const TRACKS = [
  song({ id: 1, title: 'Old Song', isNew: false }),
  song({ id: 2, title: 'New Song', isNew: true }),
  song({ id: 3, title: 'Newer Song', isNew: true }),
];

const DETAIL = {
  import: { id: IMPORT_ID, source_label: 'My scan', page_url: null, track_count: 3, new_song_count: 2, created_at: 0 },
  tracks: TRACKS,
};

const fetchMock = vi.fn();
const okJson = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }) as unknown as Response;

/** Everything answers empty EXCEPT the URLs a test actually cares about. */
function routeFetch(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (String(url).includes(needle)) return Promise.resolve(okJson(body));
    }
    return Promise.resolve(okJson({}));
  });
  return routes;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[`/imports/${IMPORT_ID}/build`]}>
    <SessionProvider>
      <LibraryApiProvider>
        <Routes>
          <Route path="/imports/:id/build" element={children} />
          <Route path="/playlists/:id" element={<p data-testid="went-to-playlist">the playlist</p>} />
        </Routes>
      </LibraryApiProvider>
    </SessionProvider>
  </MemoryRouter>
);

const renderPage = () => render(<BuildPlaylistPage />, { wrapper });
const checkboxFor = (title: string) =>
  screen.getByText(title).closest('label')!.querySelector('input') as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  routeFetch({ [`/api/library/imports/${IMPORT_ID}`]: DETAIL });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('build-state — localStorage survives reloads and disconnects', () => {
  it('round-trips a saved selection per import', () => {
    saveBuildState(3, { name: 'kept', selected: [1, 2], savedAt: 42 });
    expect(loadBuildState(3)).toEqual({ name: 'kept', selected: [1, 2], savedAt: 42 });
    // A different import never sees another import's ticks.
    expect(loadBuildState(4)).toBeNull();
    clearBuildState(3);
    expect(loadBuildState(3)).toBeNull();
  });

  it('degrades hand-edited or garbage JSON to "untouched" instead of throwing', () => {
    localStorage.setItem('plst.build.5', '{not json');
    expect(loadBuildState(5)).toBeNull();
    localStorage.setItem('plst.build.5', '{"selected":"nope"}');
    expect(loadBuildState(5)).toEqual({ name: null, selected: null, savedAt: 0 });
  });
});

describe('BuildPlaylistPage', () => {
  it('ticks exactly the NEW tracks by default — what the backend would do with an empty form', async () => {
    renderPage();
    await screen.findByText('New Song');
    expect(checkboxFor('Old Song').checked).toBe(false);
    expect(checkboxFor('New Song').checked).toBe(true);
    expect(checkboxFor('Newer Song').checked).toBe(true);
    expect(screen.getByText('2 of 3 selected')).toBeTruthy();
  });

  it('restores a saved name and selection after a "reload"', async () => {
    saveBuildState(IMPORT_ID, { name: 'kept name', selected: [1], savedAt: Date.now() });
    renderPage();
    await screen.findByText('Old Song');
    await waitFor(() => expect((document.querySelector('.field input') as HTMLInputElement).value).toBe('kept name'));
    expect(checkboxFor('Old Song').checked).toBe(true);
    expect(checkboxFor('New Song').checked).toBe(false);
    expect(screen.getByText(/selection restored from before/)).toBeTruthy();
  });

  it('select all / select none drive the whole list and the count', async () => {
    renderPage();
    await screen.findByText('New Song');
    fireEvent.click(screen.getByText('select all'));
    expect(screen.getByText('3 of 3 selected')).toBeTruthy();
    expect(checkboxFor('Old Song').checked).toBe(true);

    fireEvent.click(screen.getByText('select none'));
    expect(screen.getByText('0 of 3 selected')).toBeTruthy();
    // Zero must be un-submittable: an empty songIds would collapse into "untouched" server-side.
    expect((screen.getByText('Create playlist') as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates with exactly the ticked ids, clears the saved state, and leaves the page', async () => {
    let posted: any = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes(`/api/library/imports/${IMPORT_ID}/playlist`)) {
        posted = JSON.parse(String(init?.body));
        return Promise.resolve(okJson({ playlistId: 5, importId: IMPORT_ID, trackCount: 2 }));
      }
      if (String(url).includes(`/api/library/imports/${IMPORT_ID}`)) return Promise.resolve(okJson(DETAIL));
      return Promise.resolve(okJson({}));
    });
    renderPage();
    await screen.findByText('New Song');

    // Untick one new track; the post must carry exactly the two ticked ids.
    fireEvent.click(screen.getByText('New Song').closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByText('Create playlist'));

    await waitFor(() => expect(screen.getByTestId('went-to-playlist')).toBeTruthy());
    expect(posted.songIds).toEqual([3]);
    expect(posted.name).toContain('My scan');
    // A successful build must not leave a stale selection behind for the next visit.
    expect(loadBuildState(IMPORT_ID)).toBeNull();
  });

  it('listens by opening the matched track on music.yandex.ru', async () => {
    routeFetch({
      [`/api/library/imports/${IMPORT_ID}`]: DETAIL,
      '/api/library/songs/3/yandex': {
        songId: 3,
        url: 'https://music.yandex.ru/track/42',
        trackId: '42',
        title: 'Newer Song',
        artists: ['Artist 3'],
      },
    });
    renderPage();
    await screen.findByText('New Song');

    // Per-row: the listen button in row 3, found via its row — every row has one.
    const row = screen.getByText('Newer Song').closest('li')!;
    fireEvent.click(row.querySelector('button.listen')!);

    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith('https://music.yandex.ru/track/42', '_blank', 'noopener'),
    );
    // The lookup went through the library endpoint, not a hardcoded URL.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/library/songs/3/yandex'))).toBe(true);
  });

  it('survives the import failing to load and offers a retry without losing the selection', async () => {
    saveBuildState(IMPORT_ID, { name: 'kept', selected: [2], savedAt: Date.now() });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes(`/api/library/imports/${IMPORT_ID}`)) {
        return Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => 'backend down' });
      }
      return Promise.resolve(okJson({}));
    });
    renderPage();
    await screen.findByText(/could not load this import/);
    expect(screen.getByText(/retry without losing it/)).toBeTruthy();
    // The saved state is untouched by the failed load.
    expect(loadBuildState(IMPORT_ID)).toEqual({ name: 'kept', selected: [2], savedAt: expect.any(Number) });
  });
});
