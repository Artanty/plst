import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorText } from './http';

/**
 * The `httpResource` equivalent: fetches `path` eagerly, refetches whenever `path` or `key`
 * changes, and reports data/loading/error.
 *
 * Two details are load-bearing and are deliberately NOT what a naive fetch hook does:
 *
 * - `data` survives a refetch, so a refresh (user switch, post-mutation) never blanks the screen;
 * - `error` survives a refetch *start*. A hook that clears `error` the moment it refetches cannot
 *   tell "first load, nothing yet" from "the refetch is retrying something that 404s", and the second
 *   one re-renders through the empty branch and back — a flicker, and (in Angular) an NG0100.
 *   A later success clears it.
 */
export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useResource<T>(
  path: string | undefined,
  key: string | number,
  userId?: number,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === undefined) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    apiFetch<T>(path, { userId })
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(errorText(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, key, nonce, userId]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, refetch };
}
