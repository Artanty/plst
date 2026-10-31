import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * The current user, in localStorage, with no login. This is the deliberate hole in phase one: the
 * backend trusts an x-user-id header, so switching users is a dropdown and not a session. Replacing
 * this context with a real session is the only change real auth needs on this side — every page
 * reads `userId` and never touches the header itself.
 */
const STORAGE_KEY = 'plst.userId';
// The key was renamed with the app; read the old one so an existing browser keeps its user.
const LEGACY_KEY = 'yaum.userId';
const DEFAULT_USER_ID = 1;

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
}

function readStored(): number {
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_USER_ID;
}

export interface SessionValue {
  userId: number;
  users: SessionUser[];
  currentUser: SessionUser | null;
  setUsers: (users: SessionUser[]) => void;
  /** Any id we do not know about is worse than falling back to the default: a typo would 404 on boot. */
  switchTo: (id: number) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<number>(readStored);
  const [users, setUsers] = useState<SessionUser[]>([]);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== String(userId)) {
      localStorage.setItem(STORAGE_KEY, String(userId));
    }
  }, [userId]);

  const value = useMemo<SessionValue>(
    () => ({
      userId,
      users,
      currentUser: users.find((u) => u.id === userId) ?? null,
      setUsers,
      switchTo: (id: number) => {
        if (!Number.isInteger(id) || id <= 0) return;
        setUserId(id);
      },
    }),
    [userId, users],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
