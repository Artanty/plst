import type * as net from 'node:net';

export interface DbAction {
  /** One line a human can act on, ordered most-likely-first. */
  text: string;
  /** Optional ready-to-run command or SQL. */
  code?: string;
}

export interface DbVerdict {
  kind:
    | 'ok'
    | 'timeout'
    | 'refused'
    | 'dns'
    | 'reset'
    | 'access_denied'
    | 'db_access_denied'
    | 'unknown';
  headline: string;
  actions: DbAction[];
}

/** Pure classifier: layer + next step for a connection-level MySQL error. */
export function classifyDbError(err: unknown, host?: string): DbVerdict;

/** Grant-fix SQL; the password is NEVER interpolated (always the placeholder). */
export function grantSqlForUser(user: string, clientHost?: string | null): string;

export interface TcpProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error?: NodeJS.ErrnoException;
}

/** `connect` is injectable (default net.createConnection) so tests need no network. */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs?: number,
  connect?: typeof net.createConnection,
): Promise<TcpProbeResult>;

export interface DbConfig {
  host: string;
  port: number;
  user?: string | undefined;
  password?: string | undefined;
  database?: string | undefined;
  connectTimeoutMs?: number;
}

export interface DbProbeResult {
  verdict: DbVerdict;
  latencyMs: number | null;
  identity?: { user: string; host: string; version: string };
  grants?: string[];
  songCount?: number | null;
}

/** Full login probe: identity + grants + song count, classified on failure. */
export function checkDatabase(cfg: DbConfig): Promise<DbProbeResult>;

/** This machine's public IP via ifconfig.me; null on any failure. `fetchImpl` injectable. */
export function publicIp(fetchImpl?: typeof fetch): Promise<string | null>;
