export type LogLevel = 'log' | 'warn' | 'error';
export type LogType = 'app' | 'error' | 'all';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  fn: string;
  msg: string;
  stack?: string;
  data?: unknown;
}

export interface LoggerOptions {
  dir?: string;
  filename?: string;
  errorFilename?: string;
  maxBytes?: number;
  maxFiles?: number;
  enabled?: boolean;
  /** mirror entries to the console as well as the file (default true, LOG_CONSOLE=off to disable) */
  console?: boolean;
}

export interface GetLogsOptions {
  /** inclusive start of the range */
  from?: Date;
  /** inclusive end of the range */
  to?: Date;
  /** return only the N most recent matching entries */
  last?: number;
  /** 'app' | 'error' | 'all' (default 'all') */
  type?: LogType;
  /** mask values of known-sensitive keys before returning */
  hideSensitive?: boolean;
  /** read this process's in-memory ring instead of the log files */
  memory?: boolean;
}

/** Deep-masks values of sensitive keys (recursive, circular-safe). */
export function sanitize(value: unknown, seen?: WeakSet<object>): unknown;

export class Logger {
  constructor(opts?: LoggerOptions);
  log(msg: string, data?: unknown, fn?: string): void;
  warn(msg: string, data?: unknown, fn?: string): void;
  /** errOrData: an Error (or error-like, has .stack) → stack captured; anything else → data. */
  error(msg: string, errOrData?: unknown, fn?: string): void;
  /** Await the write queue — MUST be called before process exit or pre-exit lines vanish. */
  flush(): Promise<void>;
  /** Parsed entries of any existing log file inside the log dir (e.g. 'ext.log'). */
  readLogFile(filename: string): Promise<LogEntry[]>;
  getLogs(opts?: GetLogsOptions): Promise<LogEntry[]>;
}

/** Shared singleton for the app; create your own Logger() per project/file if needed. */
export declare const logger: Logger;
