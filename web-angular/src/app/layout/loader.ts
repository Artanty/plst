import { Component, input } from '@angular/core';

/**
 * The explicit "something is loading" element: a CSS spinner plus a label, announced politely via
 * role="status". The Angular twin of web/'s Loader — used by the shell's users gate and every
 * page's first-load branch, so there is one look instead of a bare "loading…" text line.
 */
@Component({
  selector: 'app-loader',
  template: `
    <p class="loader" role="status">
      <span class="spinner" aria-hidden="true"></span>
      {{ label() }}
    </p>
  `,
  styles: [
    `
      .loader {
        display: flex;
        align-items: center;
        gap: 9px;
        margin: 18px 0;
        color: #8b909b;
        font-size: 13px;
      }

      .spinner {
        width: 14px;
        height: 14px;
        flex: none;
        border: 2px solid #d3d7de;
        border-top-color: #ffce00;
        border-radius: 50%;
        animation: loader-spin 0.7s linear infinite;
      }

      @keyframes loader-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: none;
        }
      }
    `,
  ],
})
export class Loader {
  readonly label = input('loading…');
}
