import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionProvider, useSession } from './session';

const wrapper = ({ children }: { children: ReactNode }) => (
  <SessionProvider>{children}</SessionProvider>
);

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('session', () => {
  it('falls back to the legacy yaum key so a renamed browser keeps its user', () => {
    localStorage.setItem('yaum.userId', '42');
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.userId).toBe(42);
  });

  it('prefers the current key over the legacy one', () => {
    localStorage.setItem('plst.userId', '2');
    localStorage.setItem('yaum.userId', '42');
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.userId).toBe(2);
  });

  it('defaults to the first user when nothing is stored or the value is nonsense', () => {
    localStorage.setItem('plst.userId', 'banana');
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.userId).toBe(1);
  });

  it('persists a switch under the current key', () => {
    const { result } = renderHook(() => useSession(), { wrapper });
    act(() => result.current.switchTo(3));
    expect(localStorage.getItem('plst.userId')).toBe('3');
  });

  it('ignores a switch to an id that would 404 on boot', () => {
    const { result } = renderHook(() => useSession(), { wrapper });
    act(() => result.current.switchTo(-1));
    expect(result.current.userId).toBe(1);
    act(() => result.current.switchTo(2.5));
    expect(result.current.userId).toBe(1);
  });
});
