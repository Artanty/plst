// The extension ships its log here, so this endpoint is the difference between a trace that
// survives and one that dies with the browser profile. That makes the failure modes worth pinning:
// a hostile/naive body must not 500, a big batch must be capped visibly, a token must be masked on
// ingest (not just on read), and what was POSTed must be immediately readable.
//
// LOG_DIR is set BEFORE anything value-bearing is imported, on purpose: the Logger constructor reads
// it at construction time, and ESM hoists static imports above any assignment. Importing the routes
// statically here would write this file's test output into the real back/logs/ext.log.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LibraryStore } from '../src/library/store.js';

const prevLogDir = process.env.LOG_DIR;
const logDir = await mkdtemp(join(tmpdir(), 'plst-extlog-'));
process.env.LOG_DIR = logDir;

// Values, so: loaded now, after LOG_DIR is in place.
const { registerLibraryRoutes } = await import('../src/library/routes.js');

const stubStore = {
  listUsers: async () => [{ id: 1, username: 'artyom', display_name: 'Artyom' }],
  getUser: async (id: number) => (id === 1 ? { id: 1, username: 'artyom', display_name: 'Artyom' } : null),
} as unknown as LibraryStore;

const LIB = '/api/library';

describe('POST/GET /api/library/ext-logs', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerLibraryRoutes(app, stubStore);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (prevLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = prevLogDir;
    await rm(logDir, { recursive: true, force: true });
  });

  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `${LIB}/ext-logs`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: payload as object,
    });
  const get = (query = '') => app.inject({ method: 'GET', url: `${LIB}/ext-logs${query}` });
  const readAll = async (query: string) => (await get(query)).json();

  it('stores what the extension posted and reads it straight back', async () => {
    const res = await post({
      extensionId: 'abcdefghijklmnop',
      userId: 1,
      entries: [
        {
          ts: '2026-10-01T09:00:00.000Z',
          level: 'info',
          scope: 'popup',
          msg: 'import requested',
          data: { tracks: 2, server: 'http://127.0.0.1:8000' },
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, received: 1, stored: 1, dropped: 0, capped: false });

    // No flush dance on the client: a GET immediately after the POST must already see the entry.
    const body = await readAll('?extensionId=abcdefghijklmnop');
    expect(body.count).toBe(1);
    expect(body.source).toBe('ext.log');
    expect(body.entries[0]).toMatchObject({ level: 'log', fn: 'ext:popup', msg: 'import requested' });
    // The arrival time is the server's, but the client's own clock is kept too — otherwise every
    // shipped entry claims the second it arrived and true ordering is unrecoverable.
    expect(body.entries[0].data.extTs).toBe('2026-10-01T09:00:00.000Z');
    // Origin stays recoverable: which extension, which user, and the original data.
    expect(body.entries[0].data).toMatchObject({
      extensionId: 'abcdefghijklmnop',
      userId: 1,
      ext: { tracks: 2 },
    });
  });

  it('rejects a body with no entries, naming the field', async () => {
    const res = await post({ extensionId: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/entries is required/);
  });

  it('drops junk entries instead of failing the batch', async () => {
    // A naive sender sends strings; a hostile one sends arrays and a huge message. Neither may 500,
    // and the good entries must still be stored.
    const res = await post({
      extensionId: 'junk-test',
      entries: [
        'not an object',
        null,
        [1, 2, 3],
        { level: 'warn', scope: 'content', msg: 'scroller not found' },
        { msg: 'x'.repeat(5000) },
        { msg: '' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 6, stored: 2, dropped: 4, capped: false });

    const body = await readAll('?extensionId=junk-test');
    const long = body.entries.find((e: { msg: string }) => e.msg.startsWith('x'));
    expect(long.msg).toHaveLength(500); // bounded, not refused
    expect(body.entries.find((e: { level: string }) => e.level === 'warn')).toBeTruthy();
  });

  it('caps a huge batch and says so rather than silently truncating', async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 9, 1, 9, 0, i)).toISOString(),
      level: 'info',
      scope: 'scan',
      msg: `step ${i}`,
    }));
    const res = await post({ extensionId: 'big-batch', entries: many });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 260, stored: 200, capped: true });
    expect(res.json().note).toMatch(/kept the newest 200/);

    // last=200 explicitly: the endpoint defaults to 100, so count must reflect what was returned.
    const body = await readAll('?extensionId=big-batch&last=200');
    expect(body.count).toBe(200);
    expect(body.matchedInFile).toBe(200);
    // The newest survive, not the oldest: a truncated trace is most useful at its end.
    expect(body.entries.at(-1).msg).toBe('step 259');
    expect(body.entries[0].msg).toBe('step 60');
  });

  it('masks sensitive values on ingest, not only on read', async () => {
    await post({
      extensionId: 'secrets',
      entries: [{ level: 'error', scope: 'popup', msg: 'auth failed', data: { token: 'abc123', user: 'artyom' } }],
    });
    const body = await readAll('?extensionId=secrets&level=error');
    expect(body.count).toBe(1);
    expect(body.entries[0].data.ext).toEqual({ token: '***REDACTED***', user: 'artyom' });
  });

  it('filters by level and by user', async () => {
    await post({
      extensionId: 'mixed',
      userId: 1,
      entries: [
        { level: 'debug', scope: 'scan', msg: 'debug one' },
        { level: 'info', scope: 'scan', msg: 'info one' },
        { level: 'error', scope: 'import', msg: 'error one', stack: 'Error: boom\n  at x' },
      ],
    });
    expect((await readAll('?extensionId=mixed')).count).toBe(3);

    const errs = await readAll('?extensionId=mixed&level=error');
    expect(errs.count).toBe(1);
    expect(errs.entries[0].msg).toBe('error one');
    // The stack must ride WITH the error entry, or a level=error query drops it — which is the one
    // query you run when a crash happened.
    expect(errs.entries[0].data.extStack).toContain('Error: boom');

    expect((await readAll('?userId=1')).count).toBeGreaterThan(0);
    expect((await readAll('?userId=2')).count).toBe(0);
  });

  it('falls back to now for an unparseable timestamp instead of losing the message', async () => {
    const res = await post({
      extensionId: 'bad-ts',
      entries: [{ ts: 'not-a-date', level: 'warn', scope: 'popup', msg: 'kept anyway' }],
    });
    expect(res.json().stored).toBe(1);
    const body = await readAll('?extensionId=bad-ts');
    expect(body.entries[0].msg).toBe('kept anyway');
    expect(Number.isFinite(Date.parse(body.entries[0].ts))).toBe(true);
  });

  it('honours ?last', async () => {
    await post({
      extensionId: 'last-n',
      entries: Array.from({ length: 10 }, (_, i) => ({ level: 'info', scope: 'scan', msg: `m${i}` })),
    });
    const body = await readAll('?extensionId=last-n&last=3');
    expect(body.count).toBe(3);
    expect(body.entries.map((e: { msg: string }) => e.msg)).toEqual(['m7', 'm8', 'm9']);
  });

  it('reads nothing without complaining when no extension has ever shipped', async () => {
    const body = await readAll('?extensionId=never-seen');
    expect(body.count).toBe(0);
    expect(body.source).toBe('ext.log');
    expect(body.logDir).toBe(logDir);
  });
});