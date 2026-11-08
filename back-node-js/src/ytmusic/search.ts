import { applyYtmProxy, settings } from '../config.js';
import { logger } from '../lib/logger.js';
import type { Candidate } from '../model.js';

type Ytmusic = import('ytmusic-api').default;

let instance: Ytmusic | null = null;
let initPromise: Promise<Ytmusic> | null = null;

async function build(): Promise<Ytmusic> {
  applyYtmProxy();
  const axios = (await import('axios')).default;
  // ytmusic-api creates its client from a plain axios.create(), which inherits these defaults
  // and has NO timeout of its own — a blocked YouTube would hang forever instead of failing.
  // This is why axios is a declared dependency rather than an undeclared ytmusic-api transitive.
  axios.defaults.timeout = settings.ytmTimeout;
  const mod = await import('ytmusic-api');
  const YTMusic = mod.default;
  const ytmusic = new YTMusic();
  await ytmusic.initialize({ HL: 'en', GL: 'US' });
  return ytmusic;
}

export async function getYtmusic(): Promise<Ytmusic> {
  if (instance) return instance;
  if (!initPromise) {
    initPromise = build().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.error(`ytmusic: attempt ${i + 1}/${attempts} failed`, err instanceof Error ? err : new Error(String(err)), 'withRetry');
      const msg = String(err);
      if (/429|rate|fetch failed|timeout|ENOTFOUND|ECONNREFUSED|socket/i.test(msg) || i < attempts - 1) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** i, 8000)));
      }
    }
  }
  throw lastErr;
}

export async function searchSongs(query: string): Promise<Candidate[]> {
  const ytmusic = await getYtmusic();
  const queryTime = Date.now();
  const songs = await withRetry(() => ytmusic.searchSongs(query));
  // YT Music search intermittently yields rows with no videoId (mix rows, headers). They can never
  // produce a link, so they must not be able to win the scoring and blank out a result.
  const usable = songs.filter((s) => typeof s.videoId === 'string' && s.videoId.length > 0);
  logger.log('ytmusic: search ok', { query, resultCount: usable.length, dropped: songs.length - usable.length, elapsedMs: Date.now() - queryTime });
  return usable.map((s) => ({
    videoId: s.videoId,
    title: s.name,
    artists: s.artist?.name ?? '',
    duration: s.duration ?? null,
  }));
}
