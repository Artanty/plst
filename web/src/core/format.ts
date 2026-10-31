import type { AppNotification, NotificationType, Song } from './models';

export function artistsText(song: Song): string {
  return song.artists.map((a) => a.name).join(', ');
}

/** feat. is rendered explicitly, because "Kool G rap, DJ Jazzy Jeff" reads as two unrelated names. */
export function artistCredit(song: Song): string {
  const main = song.artists.filter((a) => a.role === 'main');
  // With no "main" at all, every artist IS the head — otherwise the fallback head and the
  // featured list are the same people and the credit prints them twice.
  if (!main.length) return artistsText(song);
  const feat = song.artists.filter((a) => a.role !== 'main');
  const head = main.map((a) => a.name).join(', ');
  return feat.length ? `${head} feat. ${feat.map((a) => a.name).join(', ')}` : head;
}

export function durationText(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '—';
  // Round the total FIRST: rounding the remainder alone turns 59.6s into "0:60".
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function timeAgo(unixSeconds: number): string {
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The notification sentence lives here, in one place, rather than in the template. The actor name
 * can be null (a system event) and the payload is `unknown`, so both are handled defensively here
 * instead of with template casts.
 */
export function notificationText(n: AppNotification): string {
  const who = n.actor_username ?? 'someone';
  const what = n.playlist_name ? `“${n.playlist_name}”` : 'a playlist';
  switch (n.type as NotificationType) {
    case 'playlist_shared':
      return `${who} shared ${what} with you`;
    case 'playlist_renamed':
      return `${who} renamed ${what} to “${payloadName(n)}”`;
    case 'playlist_edited':
      return `${who} edited ${what}`;
    case 'collab_removed':
      return `${who} removed your access to ${what}`;
    case 'import_ready':
      return 'a scan is waiting to be turned into a playlist';
    default:
      return `${who} did something in ${what}`;
  }
}

function payloadName(n: AppNotification): string {
  const p = n.payload as { name?: unknown } | null;
  return typeof p?.name === 'string' ? p.name : '(renamed)';
}
