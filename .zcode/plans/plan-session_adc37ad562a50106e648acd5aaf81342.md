Feature-slot architecture: config API (mock) + generic remote web-element wrapper.

1. **plst back — mock config API** (`server.ts`):
   `GET ${apiPrefix}/features` →
   ```json
   { "features": [ { "id": "version-display", "element": "deploy-info",
       "namespace": "js-web", "version": "v3", "slot": "app-version",
       "baseUrl": "https://feat.twc1.net" } ] }
   ```
   Static const for now (mock), typed shape documented in one place and mirrored in the web types. One entry per feature; `slot` matches the mount point name in the app; adding/moving features later = editing this data (future GUI), no app rebuild.

2. **plst web — `src/core/features.ts`**: types (`FeatureConfig`) + `useFeaturesConfig()` hook — fetches `/api/features` once, caches the promise module-level so N slots = 1 request.

3. **plst web — `src/layout/FeatureSlot.tsx`** (the wrapper):
   - Props: `{ slot: string; attrs?: Record<string,string>; fallback?: ReactNode }`.
   - Looks up its feature in the config; injects `<script src={baseUrl}/{id}/{version}/{namespace}/>` (module-level Map<url, Promise> so a script is injected once no matter how many slots/renders); once loaded, renders `React.createElement(element, attrs)` in place.
   - Renders nothing while loading; `fallback` (default nothing) on config/script failure — badge-critical features stay silent, page never breaks.
   - No manifest, no polling, no `src` data endpoint — feat's v3 shell works fine without them (direct attrs win, polling never starts).

4. **plst web — Shell.tsx**: replace `<VersionDisplay />` with
   `<FeatureSlot slot="app-version" attrs={{ version: TAG_VERSION, project: 'plst', namespace: 'web' }} />`
   — data values are build-time (config.ts TAG_VERSION, sed-injected in deploy), per your earlier point. Delete `VersionDisplay.tsx` + its spec; new `FeatureSlot.spec.tsx` (mock fetch: right script URL injected, element created with attrs, failure → silent).

5. **feat**: no changes (v3 already supports everything needed; it stays deployed as is).

6. Docs: DECISIONS.md plan + result; know/entries/feat.md consumer section rewritten around the slot pattern (config API → wrapper → attrs).

Verify: web tsc + vitest + build; back tests + lint; live-ish check with back running that /api/features answers and the page renders the badge (feat v3 still not deployed → script fails → slot silently empty, which is the designed behavior).