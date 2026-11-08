import type { Logger, LogEntry } from './logger';

export const EXT_LOG_FILE: 'ext.log';

/** Second Logger instance: both filenames ext.log, console mirror OFF. */
export declare const extLogger: Logger;

export const MAX_ENTRIES_PER_REQUEST: 200;

/** One entry as received from an extension (all fields untrusted). */
export interface ExtLogEntry {
  ts?: unknown;
  level?: unknown;
  scope?: unknown;
  msg?: unknown;
  stack?: unknown;
  data?: unknown;
}

export interface ExtLogIngest {
  extensionId?: string | null;
  userId?: number | null;
  entries: unknown;
}

export interface NormalizeResult {
  entries: {
    ts: string;
    level: 'log' | 'warn' | 'error';
    scope: string;
    msg: string;
    stack?: string;
    data?: unknown;
  }[];
  dropped: number;
  capped: boolean;
}

/** Untrusted body → safe entries; everything bad counted and dropped, never thrown. */
export function normalizeExtEntries(raw: unknown): NormalizeResult;

/** Append a normalized batch, flush, and only then return ("stored" must be true). */
export function ingestExtLogs(
  normalized: NormalizeResult,
  ctx: { extensionId: string | null; userId: number | null },
): Promise<void>;

/** Read the extension stream back, newest last. */
export function readExtLogs(opts?: { last?: number }): Promise<LogEntry[]>;
