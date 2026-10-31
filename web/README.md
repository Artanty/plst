# plst web (React)

The plst library front end: a Vite + React + TypeScript single-page app in front of the
`/api/library` endpoints served by `back/`.

- `npm start` — dev server with HMR, proxying `/api` to `PLST_API` (default `http://127.0.0.1:8000`)
- `npm test` — vitest (jsdom)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — production build into `dist/` (`dist/200.html` is copied from `index.html` for
  the Surge SPA fallback by the deploy workflow)

The Angular implementation this replaced lives in `web-angular/`.
