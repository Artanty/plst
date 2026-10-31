import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LibraryApi } from '../../core/library-api';
import { errorText } from '../../core/interceptor';
import { plural, timeAgo } from '../../core/format';
import { Loader } from '../../layout/loader';

@Component({
  selector: 'app-playlists-page',
  imports: [FormsModule, RouterLink, Loader],
  templateUrl: './playlists.html',
  styleUrl: './playlists.scss',
})
export class PlaylistsPage {
  protected readonly api = inject(LibraryApi);
  protected readonly plural = plural;
  protected readonly timeAgo = timeAgo;

  protected readonly playlists = this.api.playlists;
  protected readonly newName = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  protected readonly mine = computed(() => this.playlists.value()?.mine ?? []);
  protected readonly shared = computed(() => this.playlists.value()?.shared ?? []);

  protected create(): void {
    const name = this.newName().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.api.createPlaylist(name, null).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.newName.set('');
        this.api.refresh();
        void res;
      },
      error: (err) => {
        this.busy.set(false);
        this.message.set(errorText(err));
      },
    });
  }
}
