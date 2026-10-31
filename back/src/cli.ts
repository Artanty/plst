#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { applyYtmProxy } from './config.js';
import { buildQueries, matchTrack } from './matcher.js';
import type { Candidate, TrackMeta } from './model.js';
import { artistStr } from './model.js';
import { parseTrackJson } from './pasteJson.js';
import { parseUrl } from './url.js';
import { fetchCollections, YandexClient } from './yandex/client.js';
import { searchSongs } from './ytmusic/search.js';

const PERFECT = 0.9995;

async function matchOne(track: TrackMeta): Promise<ReturnType<typeof matchTrack>> {
  let best: ReturnType<typeof matchTrack> | null = null;
  for (const query of buildQueries(track)) {
    let candidates: Candidate[] = [];
    try {
      candidates = await searchSongs(query);
    } catch (err) {
      console.error(`  search error: ${err instanceof Error ? err.message : err}`);
    }
    const res = matchTrack(track, candidates);
    if (best === null || res.score > best.score) best = res;
    if (res.status === 'matched') break;
  }
  return best ?? matchTrack(track, []);
}

function report(track: TrackMeta, res: ReturnType<typeof matchTrack>): void {
  // Anything short of an exact normalized match gets flagged: a low artist score can still
  // clear MATCH_ACCEPT on a title-only hit and hand back the wrong artist entirely.
  const review = res.score > 0 && res.score < PERFECT;
  const flag = review ? '⚠ review' : '         ';
  const url = res.videoId ? `  https://music.youtube.com/watch?v=${res.videoId}` : '';
  console.log(
    `[${res.status.padEnd(9)}] ${res.score.toFixed(2)} ${flag}  ${artistStr(track)} — ${track.title} ` +
      `(${track.duration}s)  ->  ${res.ytArtist ?? ''} — ${res.ytTitle ?? ''}${url}`,
  );
}

function printLinks(tracks: TrackMeta[], results: (ReturnType<typeof matchTrack>)[]): void {
  const links: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const res = results[i]!;
    if (!res.videoId) continue;
    if (res.status !== 'matched' && res.status !== 'uncertain') continue;
    const t = tracks[i]!;
    const review = res.score > 0 && res.score < PERFECT;
    links.push(`https://music.youtube.com/watch?v=${res.videoId}${review ? '  # review' : ''}`);
  }
  if (links.length) {
    console.log('\n--- links ---');
    for (const l of links) console.log(l);
  }
}

async function run(tracks: TrackMeta[]): Promise<ReturnType<typeof matchTrack>[]> {
  const results: ReturnType<typeof matchTrack>[] = [];
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]!;
    const res = await matchOne(track);
    results.push(res);
    report(track, res);
    process.stderr.write(`\r[${i + 1}/${tracks.length}] ${track.title.slice(0, 48)}`.padEnd(70));
  }
  process.stderr.write('\n');
  return results;
}

async function cmdMatch(url: string): Promise<void> {
  const target = parseUrl(url);
  const client = new YandexClient();
  const collections = await fetchCollections(target, client);
  for (const coll of collections) {
    console.log(`\n=== ${coll.title} (${coll.tracks.length} tracks) ===`);
    const results = await run(coll.tracks);
    printLinks(coll.tracks, results);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdJson(source: string): Promise<void> {
  const raw = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  const { tracks, skipped } = parseTrackJson(raw);
  console.log(`=== pasted JSON (${tracks.length} tracks${skipped ? `, ${skipped} skipped: no title` : ''}) ===`);
  const results = await run(tracks);
  printLinks(tracks, results);
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const flagged = results.filter((r) => r.score > 0 && r.score < PERFECT).length;
  console.log(`\nsummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')} | flagged for review=${flagged}`);
}

function usage(): never {
  console.error('usage: tsx src/cli.ts match <yandex-url>');
  console.error('       tsx src/cli.ts json <file.json|->   (track JSON from the browser extension)');
  process.exit(2);
}

async function main(): Promise<void> {
  const [, , cmd, arg] = process.argv;
  if (!arg) usage();
  applyYtmProxy();
  if (cmd === 'match') await cmdMatch(arg);
  else if (cmd === 'json') await cmdJson(arg);
  else usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
