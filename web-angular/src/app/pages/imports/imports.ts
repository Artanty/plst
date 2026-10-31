import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { httpResource } from '@angular/common/http';
import { Router } from '@angular/router';
import { LibraryApi } from '../../core/library-api';
import { Session } from '../../core/session';
import { errorText } from '../../core/interceptor';
import { artistCredit, durationText, plural, timeAgo } from '../../core/format';
import type { Song } from '../../core/models';
import { Loader } from '../../layout/loader';

@Component({
  selector: 'app-imports-page',
  imports: [FormsModule, Loader],
  templateUrl: './imports.html',
  styleUrl: './imports.scss',
})
export class ImportsPage {
  protected readonly api = inject(LibraryApi);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly session = inject(Session);

  protected readonly artistCredit = artistCredit;
  protected readonly durationText = durationText;
  protected readonly timeAgo = timeAgo;
  protected readonly plural = plural;

  protected readonly imports = this.api.pendingImports;
  protected readonly openId = signal<number | null>(null);
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  /** Excludes songs already chosen — the default is "every NEW song", but it is editable. */
  protected readonly excluded = signal<Set<number>>(new Set());

  protected readonly detail = httpResource<{
    import: { id: number; source_label: string | null; page_url: string | null; track_count: number; new_song_count: number; created_at: number };
    tracks: (Song & { isNew: boolean })[];
  }>(() => {
    // Both are read on purpose: the tick makes a created playlist refresh this view.
    this.api.reloadTick();
    const id = this.openId();
    return id === null ? undefined : `/api/library/imports/${id}`;
  });

  protected readonly selectedCount = computed(() => {
    const tracks = this.detail.value()?.tracks ?? [];
    return tracks.filter((t) => !this.excluded().has(t.id)).length;
  });

  protected readonly suggestedName = computed(() => {
    const imp = this.detail.value()?.import;
    if (!imp) return '';
    const label = imp.source_label ?? 'Scanned playlist';
    return `${label} (${this.selectedCount()} tracks)`;
  });

  protected toggle(id: number): void {
    const next = new Set(this.excluded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.excluded.set(next);
  }

  protected isExcluded(id: number): boolean {
    return this.excluded().has(id);
  }

  protected open(id: number, label: string | null, count: number): void {
    this.openId.set(id);
    this.excluded.set(new Set());
    this.name.set(label ? `${label} (${count} tracks)` : '');
    this.message.set(null);
  }

  protected close(): void {
    this.openId.set(null);
  }

  /**
   * The step that clears the banner. songIds is sent only when the user deselected something —
   * otherwise the backend uses its own "all new songs" default, so an untouched form cannot be
   * wrong because of a stale client-side list.
   */
  protected build(): void {
    const id = this.openId();
    if (id === null || this.busy()) return;
    const tracks = this.detail.value()?.tracks ?? [];
    const excluded = this.excluded();
    const songIds = excluded.size ? tracks.filter((t) => !excluded.has(t.id)).map((t) => t.id) : undefined;
    const chosen = songIds ?? tracks.filter((t) => t.isNew).map((t) => t.id);
    if (!chosen.length) {
      this.message.set('Nothing selected — deselect nothing, or pick at least one track.');
      return;
    }

    this.busy.set(true);
    this.message.set(null);
    this.api
      .createPlaylistFromImport(id, this.name().trim() || this.suggestedName(), songIds)
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.api.refresh();
          void this.router.navigate(['/playlists', res.playlistId]);
        },
        error: (err) => {
          this.busy.set(false);
          this.message.set(errorText(err));
        },
      });
  }

  protected markAllRead(): void {
    this.http.post('/api/library/notifications/read', {}).subscribe(() => this.api.refresh());
  }

  protected readonly sessionUser = computed(() => this.session.userId());
}
