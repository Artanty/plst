import crypto from 'node:crypto';
import PQueue from 'p-queue';
import { settings } from './config.js';
import type { Store } from './db.js';
import { buildQueries, matchTrack } from './matcher.js';
import { matchUsable, artistStr, type Candidate, type Collection, type MatchResult, type TrackMeta } from './model.js';
import { parseTrackJson } from './pasteJson.js';
import { fromForm, type YandexTarget } from './url.js';
import { fetchCollections as fetchCollectionsReal, YandexClient } from './yandex/client.js';
import { searchSongs as searchSongsReal } from './ytmusic/search.js';
import { logger } from './lib/logger.js';

export interface PipelineDeps {
  fetchCollections: (target: YandexTarget) => Promise<Collection[]>;
  searchSongs: (query: string) => Promise<Candidate[]>;
}

const defaultClient = new YandexClient();

export const defaultDeps: PipelineDeps = {
  fetchCollections: (target) => fetchCollectionsReal(target, defaultClient),
  searchSongs: searchSongsReal,
};

// Bump this whenever scoring changes. match_cache stores the verdict AND the score, so without a
// version in the key a scoring fix silently never reaches already-cached tracks.
const SCORE_VERSION = 2;

export function cacheKey(track: TrackMeta): string {
  return crypto.createHash('sha1').update(`v${SCORE_VERSION}|${track.title}|${artistStr(track)}|${track.duration}`).digest('hex');
}

export async function matchWithSearch(
  store: Store,
  track: TrackMeta,
  deps: PipelineDeps,
  queue: PQueue,
): Promise<MatchResult> {
  const key = cacheKey(track);
  logger.log('pipeline: match start', { title: track.title, artists: track.artists, duration: track.duration });
  const cached = await store.cacheGet(key);
  if (cached?.video_id) {
    logger.log('pipeline: cache hit', { key, videoId: cached.video_id, score: cached.score });
    return {
      status: cached.score >= settings.matchAccept ? 'matched' : 'uncertain',
      score: cached.score ?? 0,
      videoId: cached.video_id,
      ytTitle: cached.yt_title,
      ytArtist: cached.yt_artist,
      ytDuration: cached.yt_duration,
    };
  }

  let best: MatchResult | null = null;
  for (const query of buildQueries(track)) {
    let candidates: Candidate[] = [];
    try {
      candidates = await queue.add(() => deps.searchSongs(query)) as Candidate[];
    } catch (err) {
      logger.error(`search failed for "${query}"`, err, 'pipeline.matchWithSearch');
    }
    const result = matchTrack(track, candidates);
    if (best === null || result.score > best.score) {
      best = result;
    }
    if (result.status === 'matched') {
      best = result;
      break;
    }
  }

  if (!best) best = { status: 'not_found', score: 0 };
  logger.log('pipeline: match done', { status: best.status, score: best.score, videoId: best.videoId ?? null });
  // Cache ONLY confident matches. An 'uncertain' result is a guess we already doubt: caching it
  // froze a wrong low-confidence link forever and the track could never be re-searched, so a re-run
  // could not improve it. Re-searching the few failures per run is cheap and lets them recover.
  if (best.videoId && best.status === 'matched') {
    await store.cachePut(key, best.videoId, best.ytTitle ?? '', best.ytArtist ?? '', best.ytDuration ?? null, best.score);
  }
  return best;
}

interface ResultRow {
  position: number;
  track: TrackMeta;
  res: MatchResult;
}

export async function runCollection(
  store: Store,
  jobId: string,
  idx: number,
  coll: Collection,
  deps: PipelineDeps,
  queue: PQueue,
): Promise<Record<string, unknown>> {
  const tracks = coll.tracks;
  await store.addTotal(jobId, tracks.length);

  const seen = new Set<string>();
  const results: ResultRow[] = [];
  for (let position = 0; position < tracks.length; position++) {
    const track = tracks[position];
    const key = `${track.title}|${artistStr(track)}|${track.duration}`;
    if (seen.has(key)) {
      results.push({ position, track, res: { status: 'skipped_dup', score: 0 } });
      continue;
    }
    seen.add(key);
    const res = await matchWithSearch(store, track, deps, queue);
    results.push({ position, track, res });
    await store.incProcessed(jobId);
  }

  const rows = results.map(({ position, track, res }) => ({
    job_id: jobId,
    collection_idx: idx,
    position,
    src_title: track.title,
    src_artist: artistStr(track),
    src_duration: track.duration,
    status: res.status,
    score: res.score,
    yt_video_id: res.videoId ?? null,
    yt_title: res.ytTitle ?? null,
    yt_artist: res.ytArtist ?? null,
    yt_duration: res.ytDuration ?? null,
    collection_title: coll.title,
  }));
  await store.addItems(rows);

  const usable = new Set(
    results
      .filter((r) => matchUsable(r.res))
      .map((r) => `${r.track.title}|${artistStr(r.track)}|${r.track.duration}`),
  );

  return {
    title: coll.title,
    matched: results.filter((r) => r.res.status === 'matched').length,
    uncertain: results.filter((r) => r.res.status === 'uncertain').length,
    not_found: results.filter((r) => r.res.status === 'not_found').length,
    skipped_dup: results.filter((r) => r.res.status === 'skipped_dup').length,
    links: usable.size,
  };
}

export async function runJob(store: Store, jobId: string, mode: string, source: string, deps: PipelineDeps = defaultDeps): Promise<void> {
  try {
    await store.setJob(jobId, { status: 'running' });
    const target = fromForm(mode, source);
    // Pasted extension JSON: no Yandex request at all. That is the whole point of this mode — the
    // Yandex API is unreachable from here, and the tracks are already in hand.
    const collections: Collection[] = target.mode === 'json'
      ? [{ title: 'Pasted track JSON', tracks: parseTrackJson(source).tracks }]
      : await deps.fetchCollections(target);
    const queue = new PQueue({ concurrency: settings.searchConcurrency });
    const summaries: Record<string, unknown>[] = [];
    let idx = 0;
    for (const coll of collections) {
      if (!coll.tracks.length) continue;
      summaries.push(await runCollection(store, jobId, idx++, coll, deps, queue));
    }
    logger.log('pipeline: job done', { jobId, collections: summaries.length });
    await store.setJob(jobId, { status: 'done', summary_json: JSON.stringify(summaries) });
  } catch (err) {
    logger.error(`job ${jobId} failed`, err, 'pipeline.runJob');
    await store.setJob(jobId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

export async function startJob(store: Store, mode: string, source: string, deps: PipelineDeps = defaultDeps): Promise<string> {
  // jobs.source is printed verbatim on the job page, so store a short label instead of the whole
  // pasted blob. runJob still gets the full text by argument.
  const stored = mode === 'json' ? `pasted JSON, ${parseTrackJson(source).tracks.length} tracks` : source;
  const id = await store.createJob(mode, stored);
  void runJob(store, id, mode, source, deps);
  return id;
}
