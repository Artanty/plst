// The diagnosis ladder behind `npm run db:check` and the classified boot/pool logs. Two outages
// (2026-10-13 grant mismatch, 2026-10-19 firewall/host flap) each cost a manual session of ping /
// nc / SHOW GRANTS to distinguish network-layer from grant-layer — this module is that session,
// automated, so what it must never do is mislabel one layer as another. Hence the tests below pin
// down: each error code maps to the layer it really belongs to, the access-denied advice carries
// ready SQL for the address MySQL itself reported, the password never appears in that SQL, and the
// probes fail the same way the real failures do (refused vs timeout).
import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { checkDatabase, classifyDbError, grantSqlForUser, probeTcp, publicIp } from '../src/lib/dbDiag.js';

/** Build an Error the way mysql2/Node surface it — code is what classifyDbError keys on. */
const codedError = (code: string, message: string): NodeJS.ErrnoException => {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

describe('classifyDbError', () => {
  it('maps each code to the layer that actually failed', () => {
    expect(classifyDbError(codedError('ETIMEDOUT', 'connect ETIMEDOUT'), '1.2.3.4').kind).toBe('timeout');
    expect(classifyDbError(codedError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3306')).kind).toBe('refused');
    expect(classifyDbError(codedError('ENOTFOUND', 'getaddrinfo ENOTFOUND db.example')).kind).toBe('dns');
    expect(classifyDbError(codedError('ECONNRESET', 'read ECONNRESET')).kind).toBe('reset');
    // The mid-run flap's real shape (verified live 2026-10-20): mysql2 labels the far side
    // closing the socket PROTOCOL_CONNECTION_LOST — it must not fall through to 'unknown'.
    expect(classifyDbError(codedError('PROTOCOL_CONNECTION_LOST', 'Connection lost: The server closed the connection.')).kind).toBe('reset');
    expect(classifyDbError(codedError('ER_ACCESS_DENIED_ERROR', "Access denied for user 'u'@'1.2.3.4'")).kind).toBe('access_denied');
    expect(classifyDbError(codedError('ER_DBACCESS_DENIED_ERROR', "Access denied to database 'x'")).kind).toBe('db_access_denied');
    // Anything unrecognised still gets a verdict — never a bare throw at boot.
    expect(classifyDbError(new Error('some odd failure')).kind).toBe('unknown');
  });

  it('timeout advice names the configured host in the commands it hands out', () => {
    const v = classifyDbError(codedError('ETIMEDOUT', 'connect ETIMEDOUT'), '9.9.9.9');
    const all = v.actions.map((a) => `${a.text} ${a.code ?? ''}`).join('\n');
    expect(all).toContain('9.9.9.9');        // ping / nc commands use the REAL target, not a baked-in IP
    expect(all).toContain('npm run db:check'); // and always point at the full ladder
    expect(v.headline).toContain('dropped');   // dropped-before-answered is the distinguishing fact
  });

  it('refused advice says nothing is LISTENING (firewall let the packet through)', () => {
    const v = classifyDbError(codedError('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:3306'));
    expect(v.headline).toContain('refused');
    expect(v.headline).toContain('nothing is listening'); // the distinguishing fact vs a firewall drop
    expect(v.actions.map((a) => `${a.text} ${a.code ?? ''}`).join(' ')).toContain('systemctl status mysql');
  });

  it('connection-lost advice separates routine idle recycling from an outage', () => {
    // Two very different situations produce the same error code: MySQL's wait_timeout closing an
    // unused pooled connection (normal, ignore) and the VPS/firewall dropping everyone (act now).
    // The advice must say both, or the user either panics at routine churn or shrugs off an outage.
    const v = classifyDbError(codedError('PROTOCOL_CONNECTION_LOST', 'Connection lost: The server closed the connection.'));
    const text = v.actions.map((a) => a.text).join(' ');
    expect(text).toContain('normal');      // the one-off case, named as such
    expect(text).toContain('wait_timeout');
    expect(text).toContain('FAILING');     // the outage case, with its own trigger condition
  });

  it('access-denied carries ready SQL for the address MySQL reported, minus any password', () => {
    // The real 2026-10-13 shape: IP-pinned account, client moved to a new location.
    const v = classifyDbError(
      codedError('ER_ACCESS_DENIED_ERROR', "Access denied for user 'cs99850_yaum'@'93.100.74.64' (using password: YES)"),
      '185.114.247.197',
    );
    expect(v.kind).toBe('access_denied');
    // Headline and actions must name BOTH surviving causes: wrong password, or no grant for the
    // address — the error alone cannot tell them apart, and 2026-10-13 taught us to check both.
    const text = `${v.headline} ${v.actions.map((a) => a.text).join(' ')}`;
    expect(text).toContain('DB_PASSWORD');
    expect(text).toContain('grant');
    const sql = v.actions.find((a) => a.code)?.code ?? '';
    expect(sql).toContain(`'cs99850_yaum'@'93.100.74.64'`); // auto-filled from the error message
    expect(sql).toContain('GRANT ALL PRIVILEGES');
    expect(sql).toContain('FLUSH PRIVILEGES');
    expect(sql).not.toContain('IDENTIFIED BY \'\';');        // placeholder, never a real/empty password
    expect(sql).not.toMatch(/IDENTIFIED BY '(?!<)/);          // anything but the <…> placeholder
  });

  it('every verdict points at a runnable next step — an unreachable DB must never be a dead end', () => {
    for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ER_ACCESS_DENIED_ERROR']) {
      const v = classifyDbError(codedError(code, `boom ${code}`));
      expect(v.actions.length).toBeGreaterThan(0);
      expect(v.headline.length).toBeGreaterThan(10);
    }
  });
});

describe('grantSqlForUser', () => {
  it('fills in the observed address when given, else leaves the PUBLIC_IP placeholder', () => {
    expect(grantSqlForUser('app', '5.6.7.8')).toContain(`'app'@'5.6.7.8'`);
    expect(grantSqlForUser('app')).toContain(`'app'@'PUBLIC_IP'`);
    // The password stays a placeholder in both forms — .env is the only place it may live.
    expect(grantSqlForUser('app', '5.6.7.8')).toContain('<same-password-as-DB_PASSWORD>');
  });
});

describe('probeTcp', () => {
  it('reports ok with latency against a live listener', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const r = await probeTcp('127.0.0.1', port, 2000);
      expect(r.ok).toBe(true);
      expect(r.latencyMs).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports ECONNREFUSED against a closed port — the refused/timeout distinction is the whole point', async () => {
    // Bind to grab a free port, then close it: connecting to a port nothing listens on must
    // produce refused, NOT the timeout a firewall-drop would produce.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const r = await probeTcp('127.0.0.1', port, 2000);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('ECONNREFUSED');
    expect(classifyDbError(r.error).kind).toBe('refused');
  });

  it('gives up with a synthetic ETIMEDOUT when the socket never answers', async () => {
    // Injected connect that never fires connect/error — a stand-in for a dropped SYN. probeTcp
    // calls it like net.createConnection, so the injected value must be the FACTORY, not a socket.
    const stubSocket = {
      once: () => stubSocket,
      destroy: () => undefined,
    };
    const dead = (() => stubSocket) as unknown as typeof net.createConnection;
    const r = await probeTcp('127.0.0.1', 3306, 50, dead);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('ETIMEDOUT');
    expect(classifyDbError(r.error).kind).toBe('timeout');
  });
});

describe('checkDatabase against the local harness MySQL', () => {
  it('logs in and reports identity + grants + song count', async () => {
    const r = await checkDatabase({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
    expect(r.verdict.kind).toBe('ok');
    expect(r.identity?.user).toContain('root');
    expect(r.identity?.version).toMatch(/\d+\.\d+/);
    expect(r.grants?.length).toBeGreaterThan(0);
    expect(r.latencyMs).not.toBeNull();
    // No database selected: the songs-table probe must degrade to null, not fail the whole check.
    expect(r.songCount).toBeNull();
  });

  it('classifies a wrong password as access_denied, not timeout or refused', async () => {
    const r = await checkDatabase({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'definitely-not-the-password',
      connectTimeoutMs: 3000,
    });
    expect(r.verdict.kind).toBe('access_denied');
    // Same dual-cause advice as the production incident, ready to run.
    const sql = r.verdict.actions.find((a) => a.code)?.code ?? '';
    expect(sql).toContain('CREATE USER');
  });

  it('classifies a closed port as refused', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const r = await checkDatabase({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeoutMs: 3000 });
    expect(r.verdict.kind).toBe('refused');
  });
});

describe('publicIp', () => {
  it('trims a successful answer', async () => {
    const fake = (async () => ({ ok: true, text: async () => '  203.0.113.9\n' })) as unknown as typeof fetch;
    expect(await publicIp(fake)).toBe('203.0.113.9');
  });

  it('returns null rather than throwing when the lookup fails — it is a hint, not a dependency', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await publicIp(failing)).toBeNull();

    const notOk = (async () => ({ ok: false, text: async () => '' })) as unknown as typeof fetch;
    expect(await publicIp(notOk)).toBeNull();
  });
});
