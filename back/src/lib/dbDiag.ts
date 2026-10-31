import net from 'node:net';
import mysql from 'mysql2/promise';

/**
 * Diagnosing "the database is unreachable" — the recurring failure of the remote MySQL at
 * 185.114.247.197 (Timeweb VPS). Two DIFFERENT layers were proven to produce it on 2026-10-13/20,
 * and telling them apart is the entire point of this module:
 *
 * 1. FIREWALL (network layer): TCP SYN dropped — `connect ETIMEDOUT`, MySQL never speaks. On the
 *    VPS: Timeweb security group / iptables. Depends on the client's public IP, so it bites when
 *    the user works from a new location.
 * 2. GRANT (MySQL layer): connection reaches MySQL, which answers `Access denied for user
 *    'x'@'<ip>'` — the account is IP-pinned ('cs99850_yaum'@'93.100.74.64', no '%' entry), so a
 *    new location is refused even with the firewall open.
 *
 * Plus the ordinary causes: host down / route gone (also ETIMEDOUT but at ping level),
 * MySQL not listening (ECONNREFUSED), DNS gone (ENOTFOUND), and a half-open connection cut
 * mid-handshake (ECONNRESET / PROTOCOL_CONNECTION_ERROR).
 *
 * Everything here is pure-ish and injectable so tests need no network: the probes take their
 * dependencies as parameters, and classifyDbError is a pure function over error codes.
 */

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

const HOST_HINT = 'run `npm run db:check` in back/ for the full ladder (TCP → login → grants)';

/**
 * Classify a connection-level error into a verdict naming the layer and the next step. Pure over
 * the error; `host` only appears inside the advice (defaults to the configured DB_HOST, which the
 * config module has already loaded from .env by the time any caller runs — tests pass it in).
 */
export function classifyDbError(err: unknown, host?: string): DbVerdict {
  const target = host ?? process.env.DB_HOST ?? '185.114.247.197';
  const e = err as { code?: string; message?: string; errno?: number };
  const code = e?.code ?? '';
  const message = String(e?.message ?? err).split('\n')[0].slice(0, 200);

  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    return {
      kind: 'timeout',
      headline: `TCP to the database timed out — packets were dropped before MySQL answered: ${message}`,
      actions: [
        { text: 'If this machine is on a NEW network/location: the VPS firewall only lets certain public IPs through. Open port 3306 for this IP in the Timeweb panel (or SSH-tunnel, see below).' },
        { text: `Check the VPS itself is up: ping ${target} (this host flapped once on 2026-10-19).` },
        { text: 'Prove which layer it is from this network:', code: `nc -z -v ${target} 3306` },
        { text: HOST_HINT },
      ],
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      kind: 'refused',
      headline: `TCP reached the host but MySQL refused the connection — nothing is listening on that port: ${message}`,
      actions: [
        { text: 'MySQL/Percona is down or bound to another interface on the VPS. Start it there:', code: 'systemctl status mysql' },
        { text: 'Or DB_PORT in back/.env points at the wrong port.' },
        { text: HOST_HINT },
      ],
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      kind: 'dns',
      headline: `DNS lookup for the database host failed: ${message}`,
      actions: [
        { text: `DB_HOST (${target}) in back/.env no longer resolves — the VPS IP may have changed. Look it up in the Timeweb panel and update DB_HOST.` },
        { text: 'Or this network blocks DNS; try another network.' },
      ],
    };
  }
  // PROTOCOL_CONNECTION_LOST is the shape a mid-run flap most often takes: mysql2 saw the socket
  // 'close' with no prior error (verified live 2026-10-20 — resetAndDestroy produced exactly
  // "Connection lost: The server closed the connection." with that code). Also the natural
  // consequence of MySQL's wait_timeout closing a pooled connection that sat idle.
  if (
    code === 'ECONNRESET' ||
    code === 'PROTOCOL_CONNECTION_ERROR' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'EPIPE'
  ) {
    return {
      kind: 'reset',
      headline: `The connection was cut — ${code === 'PROTOCOL_CONNECTION_LOST' ? 'the server closed it (restart, firewall drop, or idle past wait_timeout)' : 'usually a proxy/firewall resetting foreign IPs'}: ${message}`,
      actions: [
        ...(code === 'PROTOCOL_CONNECTION_LOST'
          ? [
              { text: 'A one-off of this after idle time is MySQL closing an unused pooled connection (wait_timeout) — normal, the next query just opens a fresh one.' },
              { text: 'If queries started FAILING at the same moment: the VPS restarted or the firewall dropped established connections. Check the host, then run db:check.' },
            ]
          : [
              { text: 'A NEW location often gets its handshake reset by the VPS firewall instead of a timeout. Same fix as the timeout case: allow this public IP in the Timeweb firewall, or use an SSH tunnel.' },
            ]),
        { text: HOST_HINT },
      ],
    };
  }
  if (code === 'ER_ACCESS_DENIED_ERROR') {
    // The message itself carries both facts the fix needs: the account and the client address
    // MySQL SAW ("Access denied for user 'x'@'93.100.74.64' (using password: YES)"). Reaching
    // this error also PROVES the firewall is open for this IP — a dropped TCP never gets this
    // far — so only two causes remain: wrong DB_PASSWORD, or no grant for this address. Note
    // both, because the error alone cannot tell them apart. (MySQL may report a reverse-DNS
    // name instead of a bare IP when name resolution is on; either way it is the exact host
    // string a GRANT must use.)
    const observed = /for user '([^']+)'@'([^']+)'/.exec(message);
    const account = observed?.[1] ?? 'cs99850_yaum';
    const seenFrom = observed?.[2] ?? null;
    return {
      kind: 'access_denied',
      headline: `MySQL answered and REJECTED the login${seenFrom ? ` from ${seenFrom}` : ''} — either DB_PASSWORD in .env is wrong, or no grant matches this address: ${message}`,
      actions: [
        { text: 'If you did NOT change location/network: the address is already known to MySQL, so a wrong DB_PASSWORD in back/.env gives exactly this error. Compare it with the one on the VPS.' },
        {
          text: `If you ARE at a new location: MySQL saw you as '${account}'@'${seenFrom ?? '<address-from-error>'}' and no grant matches. Run as MySQL root on the VPS:`,
          code: grantSqlForUser(account, seenFrom ?? undefined),
        },
        { text: 'Safer alternative that works from any location without exposing MySQL: SSH tunnel + DB_HOST=127.0.0.1 in back/.env.' },
        { text: HOST_HINT },
      ],
    };
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR') {
    return {
      kind: 'db_access_denied',
      headline: `The login was accepted but the user has no rights on the configured database (wrong DB_DATABASE, or the grant is for another schema): ${message}`,
      actions: [
        { text: 'Check DB_DATABASE in back/.env against the GRANT list.', code: 'SHOW GRANTS;' },
        { text: HOST_HINT },
      ],
    };
  }
  return {
    kind: 'unknown',
    headline: `Database connection failed with an unrecognised error: ${message}`,
    actions: [{ text: HOST_HINT }],
  };
}

/**
 * The SQL that fixes an IP-pinned grant for a moved client. Password deliberately NOT interpolated
 * — it belongs in the .env, and printing it into a terminal transcript or a log would leak it.
 * `clientHost` is the address MySQL itself reported seeing (from the Access denied message) — fill
 * it when known, otherwise leave the PUBLIC_IP placeholder for the human to copy from db:check.
 */
export function grantSqlForUser(user: string, clientHost?: string | null): string {
  const host = clientHost ?? 'PUBLIC_IP';
  return [
    `-- as MySQL root on the VPS; host below = the address MySQL saw this connection come from`,
    `CREATE USER IF NOT EXISTS '${user}'@'${host}' IDENTIFIED BY '<same-password-as-DB_PASSWORD>';`,
    `GRANT ALL PRIVILEGES ON \`${process.env.DB_DATABASE ?? 'cs99850_yaum'}\`.* TO '${user}'@'${host}';`,
    `FLUSH PRIVILEGES;`,
    `-- if the account already exists with another password instead of creating it:`,
    `-- ALTER USER '${user}'@'${host}' IDENTIFIED BY '<same-password-as-DB_PASSWORD>';`,
  ].join('\n');
}

export interface TcpProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error?: NodeJS.ErrnoException;
}

/** Raw TCP reachability — the layer BELOW MySQL. Tells firewall-drop from port-closed. */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs = 5000,
  connect: typeof net.createConnection = net.createConnection,
): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error(`connect ETIMEDOUT after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      done({ ok: false, latencyMs: null, error: err });
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      done({ ok: true, latencyMs: Date.now() - started });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, latencyMs: null, error: err });
    });
  });
}

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

/**
 * Full login probe: connect as the app user, ask MySQL who we are, what we may do, and how many
 * songs are there — the three facts that answer "is the DB fine and is it the RIGHT DB".
 * connectTimeout is short on purpose: db.ts defaults to 10s, which makes a dead DB look like a
 * hung test rather than a diagnosis.
 */
export async function checkDatabase(cfg: DbConfig): Promise<DbProbeResult> {
  const started = Date.now();
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectTimeout: cfg.connectTimeoutMs ?? 8000,
    });
    const latencyMs = Date.now() - started;

    const [idRows] = (await conn.query(
      'SELECT CURRENT_USER() AS cu, @@hostname AS hostname, VERSION() AS version',
    )) as [{ cu: string; hostname: string; version: string }[], unknown];
    const identity = {
      user: idRows[0].cu,
      host: idRows[0].hostname,
      version: idRows[0].version,
    };

    let grants: string[] = [];
    try {
      const [g] = (await conn.query('SHOW GRANTS')) as [{ [k: string]: string }[], unknown];
      grants = g.map((row) => Object.values(row)[0]);
    } catch {
      /* SHOW GRANTS can be denied to restricted users — not worth failing the probe over */
    }

    let songCount: number | null = null;
    try {
      const [s] = (await conn.query('SELECT COUNT(*) AS n FROM songs')) as [{ n: number }[], unknown];
      songCount = s[0].n;
    } catch {
      /* no songs table (fresh install) — the count is a sanity signal, not the point */
    }

    return {
      verdict: {
        kind: 'ok',
        headline: `connected as ${identity.user} on ${identity.host} (${identity.version})`,
        actions: [],
      },
      latencyMs,
      identity,
      grants,
      songCount,
    };
  } catch (err) {
    return { verdict: classifyDbError(err, cfg.host), latencyMs: null };
  } finally {
    void conn?.end().catch(() => undefined);
  }
}

/** This machine's public IP — the value the VPS firewall and the grants actually see. */
export async function publicIp(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('https://ifconfig.me/ip', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}
