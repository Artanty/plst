import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { LibraryApi } from '../../core/library-api';
import { errorText } from '../../core/interceptor';
import { artistCredit, durationText, plural, timeAgo } from '../../core/format';
import type { YoutubeExport } from '../../core/models';
import { Loader } from '../../layout/loader';

@Component({
  selector: 'app-library-page',
  imports: [FormsModule, Loader],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class LibraryPage {
  protected readonly api = inject(LibraryApi);
  protected readonly artistCredit = artistCredit;
  protected readonly durationText = durationText;
  protected readonly timeAgo = timeAgo;
  protected readonly plural = plural;

  protected readonly page = LibraryApi.PAGE;
  protected readonly songs = this.api.songs;
  protected readonly genres = this.api.genres;
  protected readonly artists = this.api.artists;
  protected readonly albums = this.api.albums;

  protected readonly total = computed(() => this.songs.value()?.total ?? 0);
  protected readonly from = computed(() => (this.total() === 0 ? 0 : this.api.offset() + 1));
  protected readonly to = computed(() => Math.min(this.api.offset() + this.page, this.total()));

  protected readonly hasFilters = computed(
    () => !!this.api.query().trim() || !!this.api.albumFilter() || !!this.api.artistFilter() || !!this.api.genreFilter(),
  );

  protected get search(): string {
    return this.api.query();
  }
  protected set search(v: string) {
    this.api.query.set(v);
    this.api.offset.set(0);
  }

  protected filterAlbum(id: number | null): void {
    this.api.albumFilter.set(this.api.albumFilter() === id ? null : id);
    this.api.offset.set(0);
  }

  protected filterArtist(id: number | null): void {
    this.api.artistFilter.set(this.api.artistFilter() === id ? null : id);
    this.api.offset.set(0);
  }

  protected filterGenre(id: number | null): void {
    this.api.genreFilter.set(this.api.genreFilter() === id ? null : id);
    this.api.offset.set(0);
  }

  protected clear(): void {
    this.api.query.set('');
    this.api.albumFilter.set(null);
    this.api.artistFilter.set(null);
    this.api.genreFilter.set(null);
    this.api.offset.set(0);
  }

  protected next(): void {
    if (this.to() < this.total()) this.api.offset.update((o) => o + this.page);
  }

  protected prev(): void {
    this.api.offset.update((o) => Math.max(0, o - this.page));
  }

  // -------------------------------------------------- selection -> playlist

  protected readonly pageIds = computed(() => (this.songs.value()?.songs ?? []).map((s) => s.id));
  protected readonly allOnPageSelected = computed(() => {
    const ids = this.pageIds();
    return ids.length > 0 && ids.every((id) => this.api.isSelected(id));
  });

  protected readonly playlistName = signal('');
  protected readonly targetPlaylist = signal<number | ''>('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  protected togglePage(): void {
    this.api.selectPage(this.pageIds(), !this.allOnPageSelected());
  }

  private run(action: () => void): void {
    this.busy.set(true);
    this.message.set(null);
    action();
  }

  private finish(ok: string): void {
    this.busy.set(false);
    this.api.clearSelection();
    this.message.set(ok);
  }

  protected createPlaylist(): void {
    const name = this.playlistName().trim();
    const songIds = this.api.selectedList();
    if (!name || !songIds.length || this.busy()) return;
    this.run(() =>
      this.api.createPlaylistFromSelection(name, songIds).subscribe({
        next: (res) => {
          this.playlistName.set('');
          this.finish(`✓ “${name}” — ${plural(res.added, 'song')} added`);
        },
        error: (err) => {
          this.busy.set(false);
          this.message.set(errorText(err));
        },
      }),
    );
  }

  protected addToPlaylist(): void {
    const id = this.targetPlaylist();
    const songIds = this.api.selectedList();
    if (typeof id !== 'number' || !songIds.length || this.busy()) return;
    this.run(() =>
      this.api.addTracks(id, songIds).subscribe({
        next: (res) => {
          this.targetPlaylist.set('');
          this.finish(`✓ ${plural(res.added, 'song')} added to the playlist`);
        },
        error: (err) => {
          this.busy.set(false);
          this.message.set(errorText(err));
        },
      }),
    );
  }

  /** Playlists that can be written to: yours, plus shared ones you may edit. */
  protected readonly editablePlaylists = computed(() => {
    const lists = this.api.playlists.value();
    if (!lists) return [];
    return [
      ...lists.mine.map((p) => ({ id: p.id, name: p.name, shared: false })),
      ...lists.shared.filter((p) => p.can_edit).map((p) => ({ id: p.id, name: p.name, shared: true })),
    ];
  });

  // ------------------------------------------------------- youtube links

  protected readonly matching = signal<number | null>(null);
  protected readonly exporting = signal(false);
  protected readonly export = signal<YoutubeExport | null>(null);

  protected matchOne(songId: number): void {
    if (this.busy()) return;
    this.matching.set(songId);
    this.message.set(null);
    this.api.matchSong(songId).subscribe({
      next: (res) => {
        this.matching.set(null);
        this.api.refresh();
        this.message.set(
          res.status === 'search_failed'
            ? `⚠ YouTube Music was unreachable — “${this.songTitle(songId)}” was never searched. ${res.reason ?? ''} — fix the connection and match again.`
            : res.status === 'not_found'
              ? `no YouTube Music match for “${res.ytTitle ?? this.songTitle(songId)}” — nothing was stored`
              : `✓ matched (${Math.round(res.score * 100)}%)`,
        );
      },
      error: (err) => {
        this.matching.set(null);
        this.message.set(errorText(err));
      },
    });
  }

  private songTitle(songId: number): string {
    return this.songs.value()?.songs.find((s) => s.id === songId)?.title ?? `#${songId}`;
  }

  protected matchSelected(): void {
    const ids = this.api.selectedList();
    if (!ids.length || this.busy()) return;
    this.exporting.set(true);
    this.message.set(`matching ${plural(ids.length, 'song')}…`);
    // Sequential on purpose: each match can fan out into several YouTube searches, and firing 50 at
    // once from a browser is exactly the kind of thing that gets rate-limited into uselessness.
    ids.reduce<Observable<unknown>>((acc, id) => acc.pipe(switchMap(() => this.api.matchSong(id))), of(null)).subscribe({
      next: () => {
        this.exporting.set(false);
        this.api.refresh();
        this.message.set(`✓ matched ${plural(ids.length, 'song')}`);
      },
      error: (err) => {
        this.exporting.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected exportSelected(): void {
    const ids = this.api.selectedList();
    if (!ids.length || this.exporting()) return;
    this.exporting.set(true);
    this.message.set(null);
    this.api.exportYoutube({ songIds: ids }).subscribe({
      next: (report) => {
        this.exporting.set(false);
        this.export.set(report);
      },
      error: (err) => {
        this.exporting.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected dismissExport(): void {
    this.export.set(null);
  }

  protected async copyExport(report: YoutubeExport): Promise<void> {
    try {
      await navigator.clipboard.writeText(report.text);
      this.message.set(`✓ copied ${plural(report.matched, 'link')}`);
    } catch (err) {
      // Non-secure contexts have no navigator.clipboard. Say so instead of leaving the user
      // clicking a button that appears broken — the textarea above is selectable either way.
      this.message.set(`could not use the clipboard (${(err as Error)?.name ?? 'unknown'}) — select the text above instead`);
    }
  }
}
