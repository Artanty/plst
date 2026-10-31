import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryApi } from './library-api';

describe('LibraryApi song selection', () => {
  let api: LibraryApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(LibraryApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
    localStorage.clear();
  });

  it('toggles a song on and off', () => {
    api.toggleSelected(7);
    expect(api.isSelected(7)).toBe(true);
    expect(api.selectedCount()).toBe(1);
    api.toggleSelected(7);
    expect(api.isSelected(7)).toBe(false);
    expect(api.selectedCount()).toBe(0);
  });

  it('keeps the selection when the page changes', () => {
    // The regression this guards: the songs resource is paged, so a selection held by the page
    // component would be rebuilt from the visible rows and page 1's ticks would vanish on "next".
    api.toggleSelected(1);
    api.toggleSelected(2);
    api.offset.set(50);
    expect(api.selectedList().sort()).toEqual([1, 2]);
    api.offset.set(0);
    expect(api.selectedList().sort()).toEqual([1, 2]);
  });

  it('survives a filter change too', () => {
    api.toggleSelected(3);
    api.query.set('roxanne');
    expect(api.selectedList()).toEqual([3]);
  });

  it('selectPage only touches the ids it is given', () => {
    api.toggleSelected(99);
    api.selectPage([1, 2], true);
    expect(api.selectedList().sort((a, b) => a - b)).toEqual([1, 2, 99]);
    api.selectPage([1], false);
    expect(api.selectedList().sort((a, b) => a - b)).toEqual([2, 99]);
  });

  it('clear empties everything', () => {
    api.toggleSelected(1);
    api.toggleSelected(2);
    api.clearSelection();
    expect(api.selectedCount()).toBe(0);
  });
});

describe('LibraryApi youtube endpoints', () => {
  let api: LibraryApi;
  let backend: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(LibraryApi);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
    localStorage.clear();
  });

  it('asks for the JSON export so the UI can report what did not match', () => {
    api.exportYoutube({ playlistId: 3 }).subscribe();
    const req = backend.expectOne('/api/library/export/youtube?playlistId=3');
    req.flush({ links: [], matched: 0, unmatched: [], total: 0, text: '' });
  });

  it('serialises a multi-song export as songIds', () => {
    api.exportYoutube({ songIds: [4, 5, 6] }).subscribe();
    const req = backend.expectOne('/api/library/export/youtube?songIds=4,5,6');
    req.flush({ links: [], matched: 0, unmatched: [], total: 0, text: '' });
  });

  it('posts to the playlist match endpoint', () => {
    api.matchPlaylist(2).subscribe();
    const req = backend.expectOne('/api/library/playlists/2/match');
    expect(req.request.method).toBe('POST');
    req.flush({ playlistId: 2, total: 0, matched: 0 });
  });
});
