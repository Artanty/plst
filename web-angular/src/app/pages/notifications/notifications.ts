import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryApi } from '../../core/library-api';
import { notificationText, timeAgo } from '../../core/format';
import { Loader } from '../../layout/loader';

@Component({
  selector: 'app-notifications-page',
  imports: [RouterLink, Loader],
  templateUrl: './notifications.html',
  styleUrl: './notifications.scss',
})
export class NotificationsPage {
  protected readonly api = inject(LibraryApi);
  protected readonly notificationText = notificationText;
  protected readonly timeAgo = timeAgo;

  protected readonly data = this.api.notifications;
  protected readonly items = computed(() => this.data.value()?.notifications ?? []);
  protected readonly unread = computed(() => this.data.value()?.unread ?? 0);

  protected markAllRead(): void {
    this.api.markRead().subscribe(() => this.api.refresh());
  }

  /** Where a notification wants to take you, or null when it is only a message. */
  protected link(n: { playlist_id: number | null; import_id: number | null; type: string }): (string | number)[] | null {
    if (n.import_id) return ['/imports'];
    if (n.playlist_id) return ['/playlists', n.playlist_id];
    return null;
  }
}
