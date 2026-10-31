// The logging changes are only worth anything if they are readable and non-noisy, so both are
// pinned here: /api/library/logs must return what just happened, and the poll suppression must
// not silence real activity.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, logger } from '../src/lib/logger.js';
import type { Store } from '../src/db.js';
import { registerLibraryRoutes } from '../src/library/routes.js';
import type { LibraryStore } from '../src/library/store.js';

// A stand-in store: these tests are about the logging layer, so every call is a fixed answer and
// no database is involved. The real store is covered by library.test.ts and e2e-library.ts.
const stubStore = {
  listUsers: async () => [{ id: 1, username: 'artyom', display_name: 'Artyom' }],
  getUser: async (id: number) => (id === 1 ? { id: 1, username: 'artyom', display_name: 'Artyom' } : null),
  importScan: async (opts: { userId: number; tracks: unknown[] }) => ({
    importId: 7,
    trackCount: opts.tracks.length,
    newCount: opts.tracks.length,
    dupCount: 0,
    skippedCount: 0,
  }),
  pendingImportCount: async () => 0,
} as unknown as LibraryStore;

const LIB = '/api/library';

function build() {
  const app = Fastify({ logger: false });
  registerLibraryRoutes(app, stubStore);
  return app;
}

describe('library log endpoint', () => {
  let app: ReturnType<typeof build>;
  beforeAll(async () => {
    app = build();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns recent entries from memory', async () => {
    logger.log('library: test marker for the log endpoint', { marker: 12345 });
    const res = await app.inject({ method: 'GET', url: `${LIB}/logs?source=memory&last=50` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('memory');
    expect(body.entries.length).toBeGreaterThan(0);
    const hit = body.entries.find((e: { msg: string }) => e.msg.includes('test marker'));
    expect(hit).toBeTruthy();
    expect(hit.data).toEqual({ marker: 12345 });
  });

  it('caps the result at last=N and defaults to a sane size', async () => {
    const res = await app.inject({ method: 'GET', url: `${LIB}/logs?source=memory&last=3` });
    expect(res.json().entries.length).toBeLessThanOrEqual(3);
  });

  it('exposes whether file writing is on, so a quiet log is explainable', async () => {
    const res = await app.inject({ method: 'GET', url: `${LIB}/logs?source=memory&last=1` });
    expect(res.json()).toHaveProperty('fileWriting');
    expect(typeof res.json().fileWriting).toBe('boolean');
  });

  it('does not leak sensitive keys', async () => {
    logger.log('library: sensitive probe', { token: 'super-secret-value', keep: 'ok' });
    const res = await app.inject({ method: 'GET', url: `${LIB}/logs?source=memory&last=100` });
    expect(res.body).not.toContain('super-secret-value');
    const hit = res.json().entries.find((e: { msg: string }) => e.msg.includes('sensitive probe'));
    expect(hit.data.token).toBe('***REDACTED***');
    expect(hit.data.keep).toBe('ok');
  });
});

describe('library request logging', () => {
  it('logs a scan with its outcome, which is the line that answers "why is it empty"', async () => {
    const app = build();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `${LIB}/scan`,
      headers: { 'content-type': 'application/json' },
      payload: { userId: 1, label: 'My playlist', tracks: [{ title: 'a', artists: ['b'] }] },
    });
    expect(res.statusCode).toBe(200);

    const logged = (await logger.getLogs({ memory: true, last: 50 })).find((e) =>
      e.msg.includes('scan accepted'),
    );
    expect(logged).toBeTruthy();
    expect(logged!.data).toMatchObject({
      importId: 7,
      user: 'artyom',
      tracksIn: 1,
      newCount: 1,
      label: 'My playlist',
    });
    await app.close();
  });

  it('logs WHY a scan was rejected, so a 400 is not a silent no-op', async () => {
    const app = build();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `${LIB}/scan`,
      headers: { 'content-type': 'application/json' },
      payload: { userId: 1, tracks: [{ artists: ['no title here'] }] },
    });
    expect(res.statusCode).toBe(400);

    const logged = (await logger.getLogs({ memory: true, last: 50 })).find(
      (e) => e.msg.includes('scan rejected') && e.level === 'warn',
    );
    expect(logged).toBeTruthy();
    expect(String(logged!.data?.reason)).toMatch(/missing a title/);
    await app.close();
  });
});

describe('a logged line is not lost when the process exits right after', () => {
  // Found the hard way: the SIGTERM poll-suppression report printed to the console and was missing
  // from the log file, because logger.log() queues an async append and process.exit() won the race.
  // AGENTS.md tells whoever is debugging to read the FILE, so a line lost to exit is worse than no
  // line at all. This pins the fix: flush() must make the entry readable on disk.
  it('lands in the log file once flush() resolves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plst-logflush-'));
    try {
      const log = new Logger({ dir, console: false });
      log.log('flush-me', { why: 'test' }, 'flushTest');
      await log.flush();

      const text = await readFile(join(dir, 'app.log'), 'utf8');
      expect(text).toContain('flush-me');
      const parsed = JSON.parse(text.trim().split('\n').at(-1)!);
      expect(parsed).toMatchObject({ level: 'log', msg: 'flush-me', fn: 'flushTest' });
      // and it must also be readable through the getter, since that is what the endpoint uses
      expect((await log.getLogs({ last: 1 }))[0]?.msg).toBe('flush-me');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reportSkipCounters awaits the flush before it resolves', async () => {
    // The app-level half of the same guarantee: the shutdown handler calls the reporter and then
    // exits, so the reporter itself has to await the write. Spied rather than file-asserted, because
    // the logger singleton is built at import time and cannot be pointed at a temp dir here — and
    // "it awaited flush" is the behaviour under test, not which directory it lands in.
    const { buildApp } = await import('../src/server.js');
    const app = buildApp(stubStore as unknown as Store, stubStore);
    await app.ready();

    let flushes = 0;
    const realFlush = logger.flush.bind(logger);
    (logger as unknown as { flush: () => Promise<void> }).flush = async () => {
      flushes += 1;
      await realFlush();
    };

    try {
      for (const url of [`${LIB}/me`, `${LIB}/notifications`]) await app.inject({ method: 'GET', url });
      expect(app.skipPollStats().skippedPolls).toBe(2);
      expect(flushes).toBe(0);

      await app.reportSkipCounters('unit-test');
      expect(flushes).toBeGreaterThan(0);

      const reported = (await logger.getLogs({ memory: true, last: 20 })).find((e) =>
        e.msg.includes('poll requests suppressed so far'),
      );
      expect(reported).toBeTruthy();
      expect(reported!.data).toMatchObject({ skippedPolls: 2, why: 'unit-test' });
    } finally {
      (logger as unknown as { flush: () => Promise<void> }).flush = realFlush;
      await app.close();
    }
  });
});
