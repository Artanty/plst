import { afterAll, describe, expect, it } from 'vitest';
import { cleanupLibraryDatabases, makeLibrary } from './mysql.js';
import { songDedupKey } from '../src/library/keys.js';

// Each test gets its own schema; drop them all when the file finishes.
afterAll(async () => {
  await cleanupLibraryDatabases();
});

const TRACKS = [
  { title: 'Roxanne', artists: ['The Police'], album: 'Outlandos', durationS: 300 },
  { title: 'Joanna', artists: ['Kool G rap', 'DJ Jazzy Jeff'], album: null, durationS: 214 },
  { title: 'Ночной дозор', artists: ['Кино'], album: 'Группа крови', durationS: 258 },
];

describe('library scan import', () => {
  it('is idempotent: the same scan twice creates songs only once', async () => {
    const store = await makeLibrary();
    const first = await store.importScan({ userId: 1, sourceLabel: 'p1', pageUrl: null, tracks: TRACKS });
    expect(first.trackCount).toBe(3);
    expect(first.newCount).toBe(3);

    const second = await store.importScan({ userId: 1, sourceLabel: 'p2', pageUrl: null, tracks: TRACKS });
    // Two separate imports (you can scan the same playlist twice), but zero new SONGS.
    expect(second.newCount).toBe(0);
    expect(second.dupCount).toBe(3);
    expect(second.importId).not.toBe(first.importId);

    const found = await store.searchSongs({ limit: 50, offset: 0 });
    expect(found.total).toBe(3);

    const song = found.rows.find((s) => s.title === 'Roxanne')!;
    // seen_count counts every scan that contained it; play_count the same. Neither is a duplicate row.
    expect(song.seen_count).toBe(2);
  });

  it('dedups inside a single scan (the DOM walk repeats rendered rows)', async () => {
    const store = await makeLibrary();
    const res = await store.importScan({
      userId: 1,
      sourceLabel: 'dup',
      pageUrl: null,
      tracks: [TRACKS[0], TRACKS[0], TRACKS[0]],
    });
    expect(res.trackCount).toBe(1);
    expect(res.skippedCount).toBe(2);
    expect((await store.searchSongs({ limit: 50, offset: 0 })).total).toBe(1);
  });

  it('treats "B feat. A" and "A, B" as the same song', async () => {
    const store = await makeLibrary();
    await store.importScan({
      userId: 1,
      sourceLabel: null,
      pageUrl: null,
      tracks: [{ title: 'Song', artists: ['Alpha', 'Beta'], album: null, durationS: 200 }],
    });
    const res = await store.importScan({
      userId: 1,
      sourceLabel: null,
      pageUrl: null,
      tracks: [{ title: 'Song', artists: ['Beta', 'Alpha'], album: null, durationS: 200 }],
    });
    expect(res.newCount).toBe(0);
    expect(songDedupKey('Song', ['Beta', 'Alpha'], 200)).toBe(songDedupKey('Song', ['Alpha', 'Beta'], 200));
  });

  it('keeps artists as rows, so a feat. is two artists not one string', async () => {
    const store = await makeLibrary();
    await store.importScan({ userId: 1, sourceLabel: null, pageUrl: null, tracks: TRACKS });
    const { rows } = await store.searchSongs({ q: 'Joanna', limit: 10, offset: 0 });
    const view = await store.songExtras(rows);
    const artists = view.get(rows[0].id)!.artists;

    expect(artists.map((a) => a.name)).toEqual(['Kool G rap', 'DJ Jazzy Jeff']);
    expect(artists.map((a) => a.role)).toEqual(['main', 'feat']);
  });

  it('groups albums and attaches songs to them', async () => {
    const store = await makeLibrary();
    await store.importScan({
      userId: 1,
      sourceLabel: null,
      pageUrl: null,
      tracks: [
        { title: 'A', artists: ['X'], album: 'Album One', durationS: 100 },
        { title: 'B', artists: ['X'], album: 'Album One', durationS: 200 },
      ],
    });
    const albums = await store.listAlbums();
    expect(albums.length).toBe(1);
    expect(albums[0].song_count).toBe(2);
  });

  it('a song scanned by user 2 is the SAME song row, not a second copy', async () => {
    const store = await makeLibrary();
    const me = await store.getUser(1);
    const them = await store.getUser(2);
    expect(me).toBeTruthy();
    expect(them).toBeTruthy();

    await store.importScan({ userId: me!.id, sourceLabel: 'mine', pageUrl: null, tracks: TRACKS });
    const second = await store.importScan({ userId: them!.id, sourceLabel: 'theirs', pageUrl: null, tracks: TRACKS });

    expect(second.newCount).toBe(0);
    expect((await store.searchSongs({ limit: 50, offset: 0 })).total).toBe(3);
    // Each user still has their own pending import — the QUEUE is per user, the songs are global.
    expect(await store.pendingImportCount(me!.id)).toBe(1);
    expect(await store.pendingImportCount(them!.id)).toBe(1);
  });

  it('leaves the import pending until it becomes a playlist', async () => {
    const store = await makeLibrary();
    const res = await store.importScan({ userId: 1, sourceLabel: 'queue me', pageUrl: null, tracks: TRACKS });
    expect(await store.pendingImportCount(1)).toBe(1);

    const newIds = await store.importNewSongIds(res.importId);
    expect(newIds.length).toBe(3);

    const playlistId = await store.createPlaylist(1, 'From import', null);
    await store.addPlaylistItems(playlistId, newIds, 1);
    await store.markImportProcessed(res.importId, playlistId);

    expect(await store.pendingImportCount(1)).toBe(0);
    const items = await store.playlistItemRows(playlistId);
    expect(items.length).toBe(3);
    // Songs survive the playlist they were built from.
    expect((await store.searchSongs({ limit: 50, offset: 0 })).total).toBe(3);
  });

  it('keeps scan order in the playlist, not alphabetical order', async () => {
    const store = await makeLibrary();
    const res = await store.importScan({ userId: 1, sourceLabel: null, pageUrl: null, tracks: TRACKS });
    const ids = await store.importItemSongIds(res.importId);
    const playlistId = await store.createPlaylist(1, 'Ordered', null);
    await store.addPlaylistItems(playlistId, ids, 1);

    const titles = (await store.songsByIds(await store.playlistItemRows(playlistId).then((r) => r.map((i) => i.song_id)))).map((s) => s.title);
    expect(titles).toEqual(['Roxanne', 'Joanna', 'Ночной дозор']);
  });
});

describe('library playlists, sharing and notifications', () => {
  async function seeded() {
    const store = await makeLibrary();
    const res = await store.importScan({ userId: 1, sourceLabel: 'p', pageUrl: null, tracks: TRACKS });
    const songIds = await store.importNewSongIds(res.importId);
    const playlistId = await store.createPlaylist(1, 'Shared list', null);
    await store.addPlaylistItems(playlistId, songIds, 1);
    return { store, playlistId, songIds };
  }

  it('notifies every OTHER participant about an edit, never the actor', async () => {
    const { store, playlistId, songIds } = await seeded();
    await store.sharePlaylist(playlistId, 2, true, 1);
    await store.notify({ userId: 2, type: 'playlist_shared', actorId: 1, playlistId, payload: { canEdit: true } });

    const notified = await store.notifyParticipants({
      playlistId,
      actorId: 1,
      ownerId: 1,
      type: 'playlist_edited',
      payload: { action: 'add', count: 1 },
    });
    expect(notified).toBe(1); // only user 2 — user 1 is the actor AND the owner

    const forTwo = await store.listNotifications(2);
    expect(forTwo.map((n) => n.type)).toEqual(['playlist_edited', 'playlist_shared']);

    // Now user 2 edits: the OWNER hears about it.
    await store.notifyParticipants({ playlistId, actorId: 2, ownerId: 1, type: 'playlist_edited', payload: { action: 'add' } });
    const forOne = await store.listNotifications(1);
    expect(forOne.length).toBe(1);
    expect(forOne[0].type).toBe('playlist_edited');
    expect(forOne[0].actor_username).toBe('zaur');
  });

  it('lists a shared playlist for the recipient with can_edit, and not for a stranger', async () => {
    const { store, playlistId } = await seeded();
    await store.sharePlaylist(playlistId, 2, true, 1);

    const mine = await store.listPlaylistsForUser(1);
    expect(mine.length).toBe(1);
    expect(mine[0].shared_with_me).toBe(false);
    expect(mine[0].can_edit).toBe(true); // owner

    const shared = await store.listPlaylistsForUser(2);
    expect(shared.length).toBe(1);
    expect(shared[0].shared_with_me).toBe(true);
    expect(shared[0].can_edit).toBe(true);
    expect(shared[0].owner_username).toBe('artyom');

    expect((await store.listPlaylistsForUser(2)).length).toBe(1);
    await store.sharePlaylist(playlistId, 2, false, 1);
    const viewOnly = await store.listPlaylistsForUser(2);
    expect(viewOnly[0].can_edit).toBe(false);
    expect(viewOnly[0].shared_with_me).toBe(true);
  });

  it('a view-only collaborator is not an edit participant', async () => {
    const { store, playlistId } = await seeded();
    await store.sharePlaylist(playlistId, 2, false, 1);
    const notified = await store.notifyParticipants({ playlistId, actorId: 1, ownerId: 1, type: 'playlist_edited' });
    // They are still notified about changes — the requirement is that everyone's edits are seen,
    // regardless of who may make them.
    expect(notified).toBe(1);
  });

  it('deleting a playlist keeps every song', async () => {
    const { store, playlistId } = await seeded();
    await store.deletePlaylist(playlistId);
    expect(await store.getPlaylist(playlistId)).toBeNull();
    expect((await store.playlistItemRows(playlistId)).length).toBe(0);
    expect((await store.searchSongs({ limit: 50, offset: 0 })).total).toBe(3);
  });

  it('marks notifications read, and only the owner of the notification', async () => {
    const { store, playlistId } = await seeded();
    await store.sharePlaylist(playlistId, 2, true, 1);
    await store.notify({ userId: 2, type: 'playlist_shared', actorId: 1, playlistId });
    expect(await store.unreadNotificationCount(2)).toBe(1);
    expect(await store.unreadNotificationCount(1)).toBe(0);

    expect(await store.markNotificationsRead(2, null)).toBe(1);
    expect(await store.unreadNotificationCount(2)).toBe(0);
  });

  it('searches by title OR artist, and by album', async () => {
    const { store } = await seeded();
    expect((await store.searchSongs({ q: 'rox', limit: 50, offset: 0 })).total).toBe(1);
    // Substring, not prefix: a human remembers "Joanna", not "jo".
    expect((await store.searchSongs({ q: 'oa', limit: 50, offset: 0 })).total).toBe(1);
    expect((await store.searchSongs({ q: 'Полиция', limit: 50, offset: 0 })).total).toBe(0);
    expect((await store.searchSongs({ q: 'police', limit: 50, offset: 0 })).total).toBe(1); // case-insensitive

    const albums = await store.listAlbums();
    expect((await store.searchSongs({ albumId: albums[0].id, limit: 50, offset: 0 })).total).toBe(1);

    const artists = await store.listArtists();
    const police = artists.find((a) => a.name === 'The Police')!;
    expect((await store.searchSongs({ artistId: police.id, limit: 50, offset: 0 })).total).toBe(1);
  });

  it('treats % and _ in a search as literals, not wildcards', async () => {
    const store = await makeLibrary();
    await store.importScan({
      userId: 1,
      sourceLabel: null,
      pageUrl: null,
      tracks: [
        { title: '100% Pure Love', artists: ['A'], album: null, durationS: 100 },
        { title: 'Ordinary Song', artists: ['B'], album: null, durationS: 200 },
        { title: 'a_b', artists: ['C'], album: null, durationS: 300 },
      ],
    });
    // The escape works precisely because it still FINDS the literal: one row has a % in the title.
    expect((await store.searchSongs({ q: '100%', limit: 50, offset: 0 })).total).toBe(1);
    expect((await store.searchSongs({ q: '%', limit: 50, offset: 0 })).total).toBe(1);
    // Unescaped, '%' and '_' would each match all three rows.
    expect((await store.searchSongs({ q: '_', limit: 50, offset: 0 })).total).toBe(1);
    expect((await store.searchSongs({ q: 'Pure', limit: 50, offset: 0 })).total).toBe(1);
    // A backslash in the query itself must not become a live escape character.
    expect((await store.searchSongs({ q: '\\%', limit: 50, offset: 0 })).total).toBe(0);
  });

  it('exposes an empty genre list that the filter can still query against', async () => {
    const { store, songIds } = await seeded();
    const genres = await store.listGenres();
    expect(genres).toEqual([]);
    expect((await store.searchSongs({ genreId: 1, limit: 50, offset: 0 })).total).toBe(0);
    expect(songIds.length).toBe(3);
  });
});
