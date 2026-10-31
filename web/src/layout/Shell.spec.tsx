import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryApiProvider } from '../core/library-api';
import { SessionProvider } from '../core/session';
import { Shell } from './Shell';

const fetchMock = vi.fn();

/** A fetch the test resolves by hand — the whole point is what renders BEFORE users answers.
 *  Per-test: a promise settles only once, so a module-level one would leak between tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let users: ReturnType<typeof deferred<Response>>;
const page = <p data-testid="page-content">the actual page</p>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <SessionProvider>
      <LibraryApiProvider>{children}</LibraryApiProvider>
    </SessionProvider>
  </MemoryRouter>
);

const renderShell = () => render(<Shell>{page}</Shell>, { wrapper });

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }) as unknown as Response;

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  users = deferred();
  // Every library URL answers immediately EXCEPT /users, which the test drives by hand.
  fetchMock.mockImplementation((url: string) =>
    String(url).includes('/users') ? users.promise : Promise.resolve(okJson({})),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  // No RTL auto-cleanup without vitest globals — see Loader.spec.tsx.
  cleanup();
  vi.unstubAllGlobals();
});

describe('Shell — page content is gated on the users API', () => {
  it('shows the loader, not the page, while users is pending — and the switcher is disabled', () => {
    renderShell();
    expect(screen.getByRole('status').textContent).toContain('loading the app');
    expect(screen.queryByTestId('page-content')).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  });

  it('reveals the page and enables the switcher once users answers', async () => {
    renderShell();
    users.resolve(
      okJson({ users: [{ id: 1, username: 'a', display_name: 'Artyom' }] }),
    );
    await waitFor(() => expect(screen.getByTestId('page-content')).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);
  });

  it('shows the error with a working retry when users fails', async () => {
    renderShell();
    users.reject(new Error('network down'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not load'));
    expect(screen.queryByTestId('page-content')).toBeNull();

    // Retry refetches; the second attempt succeeds and the page appears.
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/users')
        ? Promise.resolve(okJson({ users: [{ id: 1, username: 'a', display_name: 'Artyom' }] }))
        : Promise.resolve(okJson({})),
    );
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByTestId('page-content')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
