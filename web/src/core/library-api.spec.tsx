import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryApiProvider, useLibraryApi } from './library-api';
import { SessionProvider } from './session';

const fetchMock = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => (
  <SessionProvider>
    <LibraryApiProvider>{children}</LibraryApiProvider>
  </SessionProvider>
);

const setup = () => renderHook(() => useLibraryApi(), { wrapper });

const callsTo = (needle: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(needle)) as [string, RequestInit][];

/** The single POST the "build playlist" drawer sends for import 7, parsed. */
const importBody = () => {
  const calls = fetchMock.mock.calls
    .map(([url, init]) => [String(url), init as RequestInit] as const)
    .filter(([url, init]) => url === '/api/library/imports/7/playlist' && init.method === 'POST');
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0][1].body as string) as Record<string, unknown>;
};

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '{}',
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LibraryApi song selection', () => {
  it('toggles a song on and off', () => {
    const { result } = setup();
    act(() => result.current.toggleSelected(7));
    expect(result.current.isSelected(7)).toBe(true);
    expect(result.current.selectedCount).toBe(1);
    act(() => result.current.toggleSelected(7));
    expect(result.current.isSelected(7)).toBe(false);
    expect(result.current.selectedCount).toBe(0);
  });

  it('keeps the selection when the page changes', () => {
    // The regression this guards: the songs resource is paged, so a selection held by the page
    // component would be rebuilt from the visible rows and page 1's ticks would vanish on "next".
    const { result } = setup();
    act(() => {
      result.current.toggleSelected(1);
      result.current.toggleSelected(2);
    });
    act(() => result.current.setOffset(50));
    expect([...result.current.selectedList].sort((a, b) => a - b)).toEqual([1, 2]);
    act(() => result.current.setOffset(0));
    expect([...result.current.selectedList].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('survives a filter change too', () => {
    const { result } = setup();
    act(() => result.current.toggleSelected(3));
    act(() => result.current.setQuery('roxanne'));
    expect(result.current.selectedList).toEqual([3]);
  });

  it('selectPage only touches the ids it is given', () => {
    const { result } = setup();
    act(() => result.current.toggleSelected(99));
    act(() => result.current.selectPage([1, 2], true));
    expect([...result.current.selectedList].sort((a, b) => a - b)).toEqual([1, 2, 99]);
    act(() => result.current.selectPage([1], false));
    expect([...result.current.selectedList].sort((a, b) => a - b)).toEqual([2, 99]);
  });

  it('clear empties everything', () => {
    const { result } = setup();
    act(() => {
      result.current.toggleSelected(1);
      result.current.toggleSelected(2);
    });
    act(() => result.current.clearSelection());
    expect(result.current.selectedCount).toBe(0);
  });
});

describe('LibraryApi youtube endpoints', () => {
  it('asks for the JSON export so the UI can report what did not match', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.exportYoutube({ playlistId: 3 });
    });
    const [url, init] = callsTo('export/youtube')[0];
    expect(url).toBe('/api/library/export/youtube?playlistId=3');
    expect((init.headers as Record<string, string>)['x-user-id']).toBe('1');
  });

  it('serialises a multi-song export as songIds', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.exportYoutube({ songIds: [4, 5, 6] });
    });
    expect(callsTo('export/youtube')[0][0]).toBe('/api/library/export/youtube?songIds=4,5,6');
  });

  it('posts to the playlist match endpoint', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.matchPlaylist(2);
    });
    const [url, init] = callsTo('/playlists/2/match')[0];
    expect(url).toBe('/api/library/playlists/2/match');
    expect(init.method).toBe('POST');
  });
});

describe('LibraryApi refresh', () => {
  it('refetches the songs page on refresh(), so a match shows up without a reload', async () => {
    // The Angular resource's url function did not read the tick, so `refresh()` after a match left
    // the table stale until a full page reload. The songs page must follow the tick here.
    const { result } = setup();
    await act(async () => {});
    const before = callsTo('/songs?').length;
    expect(before).toBeGreaterThan(0);

    act(() => result.current.refresh());
    await act(async () => {});
    expect(callsTo('/songs?').length).toBeGreaterThan(before);
  });
});

describe('LibraryApi building a playlist from an import', () => {
  it('omits songIds from an untouched import, so the backend "all new songs" default wins', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.createPlaylistFromImport(7, 'Scanned playlist');
    });
    const body = importBody();
    expect(body).toEqual({ name: 'Scanned playlist' });
    expect('songIds' in body).toBe(false);
  });

  it('sends songIds only when the user actually deselected something', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.createPlaylistFromImport(7, 'Scanned playlist', [1, 2]);
    });
    expect(importBody()).toEqual({ name: 'Scanned playlist', songIds: [1, 2] });
  });
});
