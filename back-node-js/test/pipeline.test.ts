import { describe, expect, it } from 'vitest';
import { runJob, type PipelineDeps } from '../src/pipeline.js';
import type { Candidate, Collection } from '../src/model.js';
import { makeStore } from './mysql.js';

function makeCollections(): Collection[] {
  return [
    {
      title: 'Test Album',
      tracks: [
        { title: 'Song A', artists: ['Artist X'], album: 'Album', duration: 200, sourceId: '1:1' },
        { title: 'Song A', artists: ['Artist X'], album: 'Album', duration: 200, sourceId: '1:2' }, // exact dupe
        { title: 'Song B', artists: ['Artist Y'], album: 'Album', duration: 180, sourceId: '1:3' },
        { title: 'Missing Song', artists: ['Zed'], album: null, duration: 100, sourceId: '1:4' },
      ],
    },
  ];
}

const CANDS: Record<string, Candidate[]> = {
  'Song A Artist X': [{ videoId: 'vidA', title: 'Song A', artists: 'Artist X', duration: 201 }],
  // Clean studio-cut title. This suite is about orchestration (dedupe/summary/cache), not scoring:
  // qualifier-vs-studio-cut scoring is asserted in matcher.test.ts. A "(Live)" title here used to be
  // a confident 'matched' and no longer is, which is correct but is not what this test is measuring.
  'Song B Artist Y': [{ videoId: 'vidB', title: 'Song B', artists: 'Artist Y', duration: 180 }],
};

function fakeDeps(): PipelineDeps {
  return {
    fetchCollections: async () => makeCollections(),
    searchSongs: async (query) => {
      const key = query.replace(/\s+/g, ' ').trim();
      return CANDS[key] ?? [];
    },
  };
}

describe('pipeline full job (mocked)', () => {
  it('matches, dedupes, reports, and caches', async () => {
    const store = await makeStore();
    const deps = fakeDeps();

    const jobId = await store.createJob('album', 'https://music.yandex.ru/album/1');
    await runJob(store, jobId, 'album', 'https://music.yandex.ru/album/1', deps);

    const job = await store.getJob(jobId);
    expect(job!.status).toBe('done');
    expect(job!.error).toBeNull();

    const summary = JSON.parse(job!.summary_json!);
    expect(summary[0].matched).toBe(2);
    expect(summary[0].skipped_dup).toBe(1);
    expect(summary[0].not_found).toBe(1);
    expect(summary[0].links).toBe(2);

    const items = await store.jobItems(jobId);
    expect(items.map((i) => i.status)).toEqual(['matched', 'skipped_dup', 'matched', 'not_found']);

    // second run: A and B resolved from cache without new searches
    let searches = 0;
    const countingDeps: PipelineDeps = {
      fetchCollections: async () => makeCollections(),
      searchSongs: async (q) => {
        searches++;
        return deps.searchSongs(q);
      },
    };
    const job2 = await store.createJob('album', 'https://music.yandex.ru/album/1');
    await runJob(store, job2, 'album', 'https://music.yandex.ru/album/1', countingDeps);
    expect((await store.getJob(job2))!.status).toBe('done');
    // missing song has no cached match -> still searches; A/B must not be searched
    expect(searches).toBeLessThan(6);
    const items2 = await store.jobItems(job2);
    expect(items2.map((i) => i.status)).toEqual(['matched', 'skipped_dup', 'matched', 'not_found']);
  });
});
