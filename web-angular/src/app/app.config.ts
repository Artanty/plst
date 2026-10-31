import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { userHeader } from './core/interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // withComponentInputBinding() is what lets PlaylistDetailPage declare `id = input.required<number>()`
    // and receive the :id route segment directly, instead of reading the snapshot in the constructor.
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([userHeader])),
  ],
};
