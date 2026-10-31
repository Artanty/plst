import type { TrackMeta } from './model.js';

export interface ParsedJson {
  tracks: TrackMeta[];
  skipped: number;
}

function toArtists(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((a) => (typeof a === 'string' ? a.trim() : String(a?.name ?? '').trim())).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function toDuration(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function parseTrackJson(raw: string): ParsedJson {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { tracks?: unknown })?.tracks)
      ? (data as { tracks: unknown[] }).tracks
      : null;
  if (!rows) {
    throw new Error('expected a JSON array of tracks, or an object with a "tracks" array');
  }

  const tracks: TrackMeta[] = [];
  let skipped = 0;
  for (const row of rows) {
    const title = String((row as { title?: unknown })?.title ?? '').trim();
    if (!title) {
      skipped += 1;
      continue;
    }
    const artists = toArtists((row as { artists?: unknown })?.artists);
    const album = String((row as { album?: unknown })?.album ?? '').trim();
    tracks.push({
      title,
      artists: artists.length ? artists : ['Unknown'],
      album: album || null,
      duration: toDuration((row as { durationS?: unknown })?.durationS),
      sourceId: null,
    });
  }

  if (!tracks.length) {
    throw new Error(`no usable rows: ${rows.length} input row(s), all missing a title`);
  }
  return { tracks, skipped };
}
