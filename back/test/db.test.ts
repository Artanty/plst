import { describe, expect, it } from 'vitest';
import { makeStore } from './mysql.js';

describe('Store lifecycle', () => {
  it('creates jobs, items, cache entries', async () => {
    const store = await makeStore();
    const jobId = await store.createJob('playlist', 'some url');
    await store.setJob(jobId, { status: 'running' });
    await store.addTotal(jobId, 2);
    await store.addItems([
      {
        job_id: jobId, collection_idx: 0, position: 0, src_title: 'Title', src_artist: 'Artist',
        src_duration: 100, status: 'matched', score: 0.9, yt_video_id: 'vid', yt_title: 'YT Title',
        yt_artist: 'YT Artist', yt_duration: 100, collection_title: 'P',
      },
      {
        job_id: jobId, collection_idx: 0, position: 1, src_title: 'T2', src_artist: 'A2',
        src_duration: 200, status: 'not_found', score: null, yt_video_id: null, yt_title: null,
        yt_artist: null, yt_duration: null, collection_title: 'P',
      },
    ]);
    await store.incProcessed(jobId);
    await store.incProcessed(jobId);
    await store.setJob(jobId, { status: 'done' });

    const job = await store.getJob(jobId);
    expect(job!.status).toBe('done');
    expect(job!.processed).toBe(2);
    expect(job!.total).toBe(2);

    const items = await store.jobItems(jobId);
    expect(items.length).toBe(2);
    expect(items[0].yt_video_id).toBe('vid');

    await store.cachePut('k', 'vid', 'YT Title', 'YT Artist', 100, 0.9);
    expect((await store.cacheGet('k'))!.video_id).toBe('vid');

    expect(await store.getJob('missing')).toBeNull();
    expect((await store.listJobs())[0].id).toBe(jobId);
  });
});