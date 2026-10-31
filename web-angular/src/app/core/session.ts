import { Injectable, computed, effect, signal } from '@angular/core';

/**
 * The current user, in localStorage, with no login. This is the deliberate hole in phase one: the
 * backend trusts an x-user-id header, so switching users is a dropdown and not a session. Replacing
 * this service with a real session is the only change real auth needs on this side — every page
 * reads user() and never touches the header itself.
 */
const STORAGE_KEY = 'plst.userId';
// The key was renamed with the app; read the old one so an existing browser keeps its user.
const LEGACY_KEY = 'yaum.userId';
const DEFAULT_USER_ID = 1;

function readStored(): number {
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_USER_ID;
}

@Injectable({ providedIn: 'root' })
export class Session {
  private readonly _userId = signal<number>(readStored());
  private readonly _users = signal<{ id: number; username: string; display_name: string }[]>([]);

  readonly userId = this._userId.asReadonly();
  readonly users = this._users.asReadonly();
  readonly currentUser = computed(() => this._users().find((u) => u.id === this._userId()) ?? null);

  constructor() {
    effect(() => {
      const id = this._userId();
      if (localStorage.getItem(STORAGE_KEY) !== String(id)) localStorage.setItem(STORAGE_KEY, String(id));
    });
  }

  setUsers(users: { id: number; username: string; display_name: string }[]): void {
    this._users.set(users);
  }

  /** Any id we do not know about is worse than falling back to the default: a typo would 404 on boot. */
  switchTo(id: number): void {
    if (!Number.isInteger(id) || id <= 0) return;
    this._userId.set(id);
  }
}
