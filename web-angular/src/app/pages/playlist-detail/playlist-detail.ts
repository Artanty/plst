import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { LibraryApi } from '../../core/library-api';
import { Session } from '../../core/session';
import { errorText } from '../../core/interceptor';
import { artistCredit, durationText, timeAgo } from '../../core/format';
import type { Collaborator, PlaylistDetail, Song, YoutubeExport } from '../../core/models';
import { Loader } from '../../layout/loader';

@Component({
  selector: 'app-playlist-detail',
  imports: [FormsModule, RouterLink, Loader],
  templateUrl: './playlist-detail.html',
  styleUrl: './playlist-detail.scss',
})
export class PlaylistDetailPage {
  protected readonly api = inject(LibraryApi);
  protected readonly session = inject(Session);
  private readonly router = inject(Router);

  protected readonly artistCredit = artistCredit;
  protected readonly durationText = durationText;
  protected readonly timeAgo = timeAgo;

  /** Bound by withComponentInputBinding() from the :id route segment — no snapshot needed. */
  protected readonly id = input.required<number>();

  protected readonly data = httpResource<{ playlist: PlaylistDetail; collaborators: Collaborator[] }>(() => {
    this.api.reloadTick();
    return `/api/library/playlists/${this.id()}`;
  });

  protected readonly playlist = computed(() => this.data.value()?.playlist ?? null);
  protected readonly items = computed(() => this.playlist()?.items ?? []);
  protected readonly collaborators = computed(() => this.data.value()?.collaborators ?? []);

  protected readonly editingName = signal(false);
  protected readonly draftName = signal('');
  protected readonly shareOpen = signal(false);
  protected readonly shareUserId = signal<number | null>(null);
  protected readonly shareCanEdit = signal(true);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  protected readonly pickerQuery = signal('');
  protected readonly picked = signal<Set<number>>(new Set());
  protected readonly candidates = httpResource<{ songs: Song[] }>(() => {
    const q = this.pickerQuery().trim();
    // An empty query is deliberately NOT sent: it would dump the whole library into the picker.
    if (!q) return undefined;
    return `/api/library/songs?q=${encodeURIComponent(q)}&limit=20`;
  });

  /**
   * Latches this resource's error. httpResource clears `error` the instant a refetch starts, so the
   * template cannot tell "first load, nothing yet" from "the refetch is retrying a playlist that
   * 404s" — and the second one re-renders through the empty branch and back inside a single
   * change-detection pass, which Angular reports as NG0100 (and the user sees as a flicker).
   * A later success wins: playlist() is checked first in the template, so this only shows while
   * there is genuinely nothing to show.
   */
  private readonly latchedError = signal<unknown>(null);

  /** True only for a first load; stays false once this resource has failed. */
  protected readonly showLoading = computed(() => this.data.isLoading() && this.latchedError() === null);

  protected readonly loadError = computed(() => this.latchedError() as { message?: string } | null);

  constructor() {
    effect(() => {
      const name = this.playlist()?.name;
      if (name && !this.editingName()) this.draftName.set(name);
    });

    effect(() => {
      const err = this.data.error();
      if (err) this.latchedError.set(err);
    });
  }

  protected readonly meId = computed(() => this.session.userId());
  protected readonly isOwner = computed(() => this.playlist()?.owner_id === this.session.userId());

  protected startRename(): void {
    this.draftName.set(this.playlist()?.name ?? '');
    this.editingName.set(true);
  }

  protected cancelRename(): void {
    this.editingName.set(false);
  }

  protected commitRename(): void {
    const name = this.draftName().trim();
    const id = this.id();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.renamePlaylist(id, name).subscribe({
      next: () => {
        this.busy.set(false);
        this.editingName.set(false);
        this.api.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected remove(itemId: number): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.removeTrack(this.id(), itemId).subscribe({
      next: () => {
        this.busy.set(false);
        this.api.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected confirmDelete(): void {
    if (this.busy()) return;
    if (!confirm('Delete this playlist? The songs stay in your library.')) return;
    this.busy.set(true);
    this.api.deletePlaylist(this.id()).subscribe({
      next: () => {
        this.busy.set(false);
        this.api.refresh();
        void this.router.navigate(['/playlists']);
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected togglePick(id: number): void {
    const next = new Set(this.picked());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.picked.set(next);
  }

  protected isPicked(id: number): boolean {
    return this.picked().has(id);
  }

  protected addPicked(): void {
    const ids = [...this.picked()];
    if (!ids.length || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.addTracks(this.id(), ids).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.picked.set(new Set());
        this.pickerQuery.set('');
        this.message.set(`Added ${res.added} track(s). ${res.notifiedUsers} collaborator(s) notified.`);
        this.api.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected share(): void {
    const userId = this.shareUserId();
    if (userId === null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.share(this.id(), userId, this.shareCanEdit()).subscribe({
      next: () => {
        this.busy.set(false);
        this.shareOpen.set(false);
        this.message.set('Shared — they get a notification next time they load the app.');
        this.api.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected unshare(userId: number): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.unshare(this.id(), userId).subscribe({
      next: () => {
        this.busy.set(false);
        this.api.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  // ------------------------------------------------------- youtube links

  protected readonly export = signal<YoutubeExport | null>(null);
  protected readonly matchingAll = signal(false);

  protected readonly matchedCount = computed(() => this.items().filter((i) => i.song.yt_video_id).length);

  protected matchOne(songId: number): void {
    if (this.busy() || this.matchingAll()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.matchSong(songId).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.api.refresh();
        this.message.set(
          res.status === 'search_failed'
            ? `⚠ YouTube Music was unreachable — “${res.title ?? 'this song'}” was never searched. ${res.reason ?? ''}`
            : res.status === 'not_found'
              ? `No YouTube Music match for “${res.title ?? 'this song'}”.`
              : `✓ matched (${Math.round(res.score * 100)}%)`,
        );
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected matchAll(): void {
    if (this.busy() || this.matchingAll()) return;
    this.matchingAll.set(true);
    this.busy.set(true);
    this.message.set('matching… this is one YouTube search per song, so it takes a moment');
    this.api.matchPlaylist(this.id()).subscribe({
      next: (res) => {
        this.matchingAll.set(false);
        this.busy.set(false);
        this.api.refresh();
        // The distinction that decides the next action: if EVERY failure is search_failed, no song
        // was ever asked about — say "YouTube unreachable, fix the network and retry", not "0 of N
        // matched" (which reads as "these songs don't exist there" and stops the reader cold).
        this.message.set(
          res.searchFailed === res.total && res.total > 0
            ? `⚠ YouTube Music was unreachable — none of the ${res.total} songs were searched. Start your proxy and press match all again.`
            : res.searchFailed > 0
              ? `✓ ${res.matched} of ${res.total} songs matched — ${res.searchFailed} could not be searched (YouTube Music unreachable), match again after fixing the connection`
              : `✓ ${res.matched} of ${res.total} songs matched`,
        );
      },
      error: (err) => {
        this.matchingAll.set(false);
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }

  protected exportLinks(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.exportYoutube({ playlistId: this.id() }).subscribe({
      next: (report) => {
        this.busy.set(false);
        this.export.set(report);
      },
      error: (err) => {
        this.busy.set(false);
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
      this.message.set(`✓ copied ${report.matched} link(s)`);
    } catch (err) {
      this.message.set(`could not use the clipboard (${(err as Error)?.name ?? 'unknown'}) — select the text instead`);
    }
  }
}
