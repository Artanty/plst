import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import view from '@fastify/view';
import cors from '@fastify/cors';
import ejs from 'ejs';
import { settings } from './config.js';
import { openStore, buildPool, type Store } from './db.js';
import { startJob } from './pipeline.js';
import { parseTrackJson } from './pasteJson.js';
import { fromForm } from './url.js';
import { logger } from './lib/logger.js';
import { classifyDbError } from './lib/dbDiag.js';
import { initLibrary } from './library/schema.js';
import { LibraryStore, SEED_USERS } from './library/store.js';
import { migrateLibrarySongs, migrateLibraryUsers } from './library/migrations.js';
import { registerLibraryRoutes, LIBRARY_PREFIX } from './library/routes.js';
import { describeProvider, NULL_GENRE_PROVIDER } from './library/genre.js';



const viewsRoot = fileURLToPath(new URL('../views/', import.meta.url));

const apiPrefix = process.env.API_PREFIX ?? '/api';

export function buildApp(store: Store, library?: LibraryStore) {
  const app = Fastify({ logger: false });
  const healthEnvs = {
    YANDEX_TOKEN: Boolean(settings.yandexToken),
    YTM_PROXY: Boolean(settings.ytmProxy),
    LOG_DISABLED: Boolean(process.env.LOG_DISABLED),
  };
  const requestLogSkipPrefixes = [`${apiPrefix}/get-updates`];

  // The Angular shell polls these on a timer, and the extension's popup re-reads some of them.
  // Logging every one buries the handful of lines that matter (a scan, a 4xx, a mutation) in
  // hundreds of identical GETs — which is exactly what happened before this existed. Skipped
  // requests are counted, and the totals are logged at startup, so a quiet log is never mistaken
  // for "the server did nothing". LOG_SKIP_POLL=off restores one line per request.
  const skipPoll = process.env.LOG_SKIP_POLL !== 'off';
  const POLL_EXACT = new Set([
    '/me',
    '/notifications',
    '/users',
    '/songs',
    '/playlists',
    '/imports/pending',
    '/healthz',
  ]);
  const isPoll = (url: string): boolean => {
    if (!skipPoll) return false;
    const path = url.split('?')[0].replace(/\/+$/, '');
    if (LIBRARY_PREFIX && path === `${LIBRARY_PREFIX}`) return false;
    return path.startsWith(`${LIBRARY_PREFIX}/`) && POLL_EXACT.has(path.slice(LIBRARY_PREFIX.length));
  };
  let skippedPolls = 0;
  let loggedOther = 0;

  app.addHook('preHandler', async (request) => {
    try {
      if (requestLogSkipPrefixes.some((prefix) => request.url.startsWith(prefix))) return;
      if (isPoll(request.url)) {
        skippedPolls += 1;
        return;
      }
      loggedOther += 1;
      logger.log(`HTTP ${request.method} ${request.url}`, {
        method: request.method,
        url: request.url,
        ip: request.ip,
        params: request.params,
        query: request.query,
        // A scan is the one POST worth being able to trace end to end from the log alone.
        tracks: Array.isArray((request.body as { tracks?: unknown[] } | undefined)?.tracks)
          ? (request.body as { tracks: unknown[] }).tracks.length
          : undefined,
      }, 'preHandler');
    } catch (err) {
      logger.error('request-logging hook failed', err instanceof Error ? err : new Error(String(err)), 'preHandler');
    }
  });

  app.addHook('onError', async (request, _reply, error) => {
    logger.error(`HTTP ${request.method} ${request.url} failed`, error, 'onError');
  });

  // The outcome line. Without it the log says a request ARRIVED and nothing about whether it
  // worked — so "it did nothing" and "it worked" look identical in the file.
  app.addHook('onResponse', async (request, reply) => {
    try {
      if (isPoll(request.url)) return;
      const ms = Math.round(reply.elapsedTime);
      const line = `-> ${reply.statusCode} ${request.method} ${request.url} in ${ms}ms`;
      if (reply.statusCode >= 500) logger.error(line, undefined, 'onResponse');
      else if (reply.statusCode >= 400) logger.warn(line, undefined, 'onResponse');
      else logger.log(line, undefined, 'onResponse');
    } catch (err) {
      logger.error('response-logging hook failed', err instanceof Error ? err : new Error(String(err)), 'onResponse');
    }
  });

  // Reported once the app is listening, so the skip counters are never a silent unknown.
  app.addHook('onReady', async () => {
    logger.log('server ready', {
      pollLogging: skipPoll ? 'suppressed (LOG_SKIP_POLL=off to log every request)' : 'every request',
      logDir: process.env.LOG_DIR ?? 'logs',
      consoleMirror: process.env.LOG_CONSOLE !== 'off',
      fileWriting: process.env.LOG_DISABLED !== 'true',
    }, 'onReady');
  });

  // Reported on demand rather than from a hook: app.addHook('onClose') does NOT fire on
  // SIGINT/SIGTERM, so a plain Ctrl-C never reaches it. The startup block below calls this from a
  // real signal handler, and the logs endpoint exposes it while the server is up.
  const reportSkipCounters = async (why: string) => {
    if (!skipPoll || skippedPolls === 0) return;
    logger.log('library: poll requests suppressed so far', {
      skippedPolls,
      loggedRequests: loggedOther,
      why,
    });
    // The file write is async, so awaiting it is the difference between this line existing and not.
    // Without this the report is printed to the console and then lost on process.exit() — i.e.
    // missing from the log file on every Ctrl-C, which is exactly when someone reads the log.
    await logger.flush();
  };
  app.decorate('reportSkipCounters', reportSkipCounters);
  app.decorate('skipPollStats', () => ({ skipPoll, skippedPolls, loggedRequests: loggedOther }));

  app.setNotFoundHandler((request, reply) => {
    logger.warn(`HTTP ${request.method} ${request.url} -> 404`, undefined, 'notFound');
    return reply.code(404).type('text/plain').send('not found');
  });
  app.register(formbody);
  app.register(view, {
    engine: { ejs },
    root: viewsRoot,
  });
  // The Angular dev server is a different origin, so the library API needs CORS for it. The plst
  // endpoints do not: the extension posts application/x-www-form-urlencoded, which is
  // CORS-safelisted and was already working without this. Only JSON callers (ng serve, and the
  // library API) benefit.
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  if (library) registerLibraryRoutes(app, library);

  app.get('/', async (_req, reply) => {
    return reply.view('index.ejs', {});
  });

  app.get(`${apiPrefix}/get-updates`, async (_req, reply) => {
    const [appEntries, errorEntries, startupEntries] = await Promise.all([
      logger.getLogs({ type: 'app' }).catch(() => []),
      logger.getLogs({ type: 'error' }).catch(() => []),
      logger.readLogFile('app.start.json').catch(() => []),
    ]);
    return reply.send({
      version: process.env.TAG_VERSION ?? null,
      commit_message: process.env.COMMIT_MESSAGE ?? null,
      project_id: process.env.PROJECT_ID ?? null,
      namespace: process.env.NAMESPACE ?? null,
      slave_repo: process.env.SLAVE_REPO ?? null,
      envs: healthEnvs,
      logs: {
        app: appEntries.slice(-50),
        error: errorEntries.slice(-50),
        start: startupEntries.slice(-50),
      },
      urls: {
        home: '/',
        migrate: `${apiPrefix}/migrate`,
        getUpdates: `${apiPrefix}/get-updates`,
        jobs: `${apiPrefix}/jobs`,
      },
    });
  });

  // Which remote feat web-components the app mounts where. MOCK for now — a static list;
  // the planned configuration GUI will edit exactly this data. One row per feature:
  //   slot     — the app's named mount point (web/src/layout/FeatureSlot.tsx looks it up)
  //   element  — the custom element name the feature's bundle defines
  //   baseUrl/id/version/namespace — assemble the bundle script URL
  //   (…/{baseUrl}/{id}/{version}/{namespace}/)
  // baseUrl comes from FEAT_BACK_URL so a feat redeploy/staging instance is a restart away,
  // never a code change.
  const featBackUrl = process.env.FEAT_BACK_URL ?? 'https://feat.twc1.net';
  app.get(`${apiPrefix}/features`, async (_req, reply) => {
    return reply.send({
      features: [
        {
          slot: 'app-version',
          id: 'version-display',
          element: 'deploy-info',
          baseUrl: featBackUrl,
          version: 'v4',
          namespace: 'js-web',
        },
      ],
    });
  });

  app.post('/migrate', async (req, reply) => {
    const body = req.body as Record<string, string> | undefined;
    const mode = body?.mode ?? '';
    const source = (body?.source ?? '').trim();
    try {
      if (mode === 'json') {
        // Reject a bad paste up front rather than creating a job that is guaranteed to fail.
        parseTrackJson(source);
      } else {
        fromForm(mode, source);
      }
    } catch (err) {
      return reply.code(400).type('text/plain').send(err instanceof Error ? err.message : String(err));
    }
    const id = await startJob(store, mode, source);
    return reply.code(303).header('location', `/job/${id}`).send();
  });

  app.get('/jobs', async (_req, reply) => {
    return reply.view('jobs.ejs', { jobs: await store.listJobs() });
  });

  app.get('/job/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await store.getJob(id);
    if (!job) return reply.code(404).type('text/plain').send('job not found');
    const items = await store.jobItems(id);
    const query = req.query as Record<string, string>;

    if (query.format === 'json') {
      let summary: unknown = null;
      if (job.summary_json) {
        try {
          summary = JSON.parse(job.summary_json);
        } catch {
          summary = [];
        }
      }
      return reply.send({ job, items, summary });
    }

    if (query.format === 'links') {
      const links = items
        .filter((i) => i.yt_video_id && (i.status === 'matched' || i.status === 'uncertain'))
        .map((i) => `https://music.youtube.com/watch?v=${i.yt_video_id}`);
      return reply.type('text/plain').send(links.join('\n'));
    }

    let summary: Record<string, unknown>[] | null = null;
    if (job.summary_json) {
      try {
        summary = JSON.parse(job.summary_json);
      } catch {
        summary = [];
      }
    }
    return reply.view('job.ejs', { job, items, summary });
  });

  app.get('/healthz', async () => ({
    ok: true,
    yandex_configured: Boolean(settings.yandexToken),
    ytm_reachable_note: 'search is anonymous; set YTM_PROXY if YouTube is blocked here',
  }));

  return app;
}

// The library shares the plst DB (same DB_* env, same schema file) but gets its own pool: Store's
// pool is private, and a second 10-connection pool to one database is well under MySQL's default
// max_connections. initLibrary runs on the SAME pool the store will query, so the schema is
// guaranteed to exist before the first request rather than being raced by two pools.
// A dead database used to surface as a bare `connect ETIMEDOUT` stack from the bottom of whichever
// call got there first (openStore's CREATE TABLE or initLibrary) — no hint WHICH layer failed or
// what to do. initDatabase therefore holds EVERY boot step that opens a MySQL connection, so the
// classified failure below always names the real first contact; and the catch FLUSHES before
// rethrowing: the process is about to die, and an unflushed line never reaches the file that gets
// read next time (the AGENTS.md SIGTERM lesson, applied to boot). Non-DB work (buildApp, listen)
// stays OUTSIDE — a bug there must not be reported as "database unreachable".
const { store, library } = await initDatabase().catch(async (err: unknown) => {
  const verdict = classifyDbError(err, settings.dbHost ?? undefined);
  logger.error(`database unreachable at boot — ${verdict.headline}`, err instanceof Error ? err : new Error(String(err)), 'onBoot');
  for (const action of verdict.actions) {
    logger.log('database: what to do', { action: action.text, code: action.code ?? null }, 'onBoot');
  }
  logger.log('database: or run the full diagnosis', { command: 'cd back && npm run db:check' }, 'onBoot');
  await logger.flush();
  throw err;
});
describeProvider(NULL_GENRE_PROVIDER);
const app = buildApp(store, library);

/** Every boot step that talks to MySQL, in dependency order. Throws with the raw cause. */
async function initDatabase(): Promise<{ store: Store; library: LibraryStore }> {
  const store = await openStore();
  const libraryPool = buildPool();
  const library = new LibraryStore(libraryPool);
  await initLibrary(libraryPool);
  // Column additions CREATE TABLE IF NOT EXISTS cannot express on a live database.
  await migrateLibrarySongs(libraryPool);
  // Renames existing rows first, so seedUsers cannot insert a fresh row beside an old one.
  await migrateLibraryUsers(libraryPool);
  await library.seedUsers(SEED_USERS);
  return { store, library };
}

const host = settings.host;
const port = Number(process.env.PORT ?? 8000);

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js') || (process.env.PLST_RUN === '1' || process.env.MUSH_RUN === '1')) {
  // Registered here, not inside buildApp, so importing the app in tests cannot leak signal
  // listeners. A timer backs this up because the counters are also worth seeing while running.
  const skipTimer = setInterval(() => void app.reportSkipCounters('periodic'), 5 * 60_000);
  skipTimer.unref?.();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // Force-exit guard: a hung connection must not make Ctrl-C look like a freeze.
      const bail = setTimeout(() => process.exit(0), 3000);
      bail.unref?.();
      // The report is flushed BEFORE close/exit, so the count is in the log file and not just on
      // this terminal — see reportSkipCounters.
      void app
        .reportSkipCounters(`shutdown (${signal})`)
        .catch(() => {})
        .then(() => app.close())
        .finally(() => process.exit(0));
    });
  }
  app.listen({ host, port }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
