import type { TrackMeta } from '../model.js';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
}

export interface SongRow {
  id: number;
  dedup_key: string;
  title: string;
  duration_s: number;
  album_id: number | null;
  yt_video_id: string | null;
  match_score: number | null;
  /** The verdict itself: 'search_failed' rows were never actually asked about (see model.ts). */
  match_status: string | null;
  matched_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
  seen_count: number;
  play_count: number;
}

export interface AlbumRow {
  id: number;
  title: string;
  artist_id: number | null;
  year: number | null;
}

export interface ArtistRow {
  id: number;
  name: string;
}

/** A song as the API returns it: the row plus its denormalised artist/album text for display. */
export interface SongView extends SongRow {
  artists: { id: number; name: string; role: string }[];
  album_title: string | null;
  genres: { id: number; name: string; weight: number }[];
}

export interface ImportRow {
  id: number;
  user_id: number;
  source: string;
  source_label: string | null;
  page_url: string | null;
  track_count: number;
  new_song_count: number;
  raw_count: number;
  skipped_count: number;
  is_processed: number;
  playlist_id: number | null;
  created_at: number;
  processed_at: number | null;
}

export interface PlaylistRow {
  id: number;
  owner_id: number;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlaylistView extends PlaylistRow {
  owner_username: string;
  item_count: number;
  can_edit: boolean;
  shared_with_me: boolean;
}

export interface PlaylistItemView {
  id: number;
  position: number;
  added_by: number;
  added_by_username: string;
  added_at: number;
  song: SongView;
}

export interface CollaboratorView {
  user_id: number;
  username: string;
  display_name: string;
  can_edit: boolean;
  shared_at: number;
}

export type NotificationType =
  | 'import_ready'
  | 'playlist_shared'
  | 'playlist_edited'
  | 'collab_removed'
  | 'playlist_renamed';

export interface NotificationRow {
  id: number;
  user_id: number;
  type: NotificationType;
  actor_id: number | null;
  playlist_id: number | null;
  import_id: number | null;
  payload_json: string | null;
  is_read: number;
  created_at: number;
}

export interface NotificationView extends NotificationRow {
  actor_username: string | null;
  playlist_name: string | null;
}

/** What the API actually returns: is_read as a boolean and payload already parsed. */
export interface NotificationDTO {
  id: number;
  type: NotificationType;
  actor_id: number | null;
  actor_username: string | null;
  playlist_id: number | null;
  playlist_name: string | null;
  import_id: number | null;
  created_at: number;
  is_read: boolean;
  payload: unknown;
}

export interface ScanRequestBody {
  userId: number;
  pageUrl?: string;
  label?: string;
  tracks: TrackMeta[];
}

export interface ScanResponse {
  importId: number;
  trackCount: number;
  newCount: number;
  dupCount: number;
  skippedCount: number;
  pendingImports: number;
}
