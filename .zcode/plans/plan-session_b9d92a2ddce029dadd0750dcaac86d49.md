Add `FEAT_BACK_URL` to plst@web and use it for pre-backend (bootstrap) features, so the wake-up feature can load before the sleeping snapdeploy backend answers `/api/features` (chicken-and-egg).

All edits in `plst/web/`:

1. **`.env` + `.env.example`** — add `FEAT_BACK_URL=https://feat.twc1.net` (commented local-dev alternative `http://127.0.0.1:5000`).
2. **`vite.config.ts`** — define `import.meta.env.FEAT_BACK_URL` in both define branches (same mechanism as `BACK_URL`); under vitest, empty it before dotenv runs (same guard as `BACK_URL`) so specs never depend on the developer's env.
3. **`src/config.ts`** — `featBaseUrl()`: build-time value from `import.meta.env.FEAT_BACK_URL`, trailing slashes stripped.
4. **`src/core/features.ts`** — `bootstrapFeatures(featUrl)` builder returning the app-init row (`wake-up` v1 `js-web`, element `wake-server`) when a feat URL exists; exported `BOOTSTRAP_FEATURES = bootstrapFeatures(featBaseUrl())`. Semantics: slots listed here are guaranteed without the backend.
5. **`src/layout/FeatureSlot.tsx`** — slot resolution checks `BOOTSTRAP_FEATURES` **first**, then the backend config; a bootstrap hit skips the "config still loading" gate entirely (init slot must not wait for `/api/features`). Backend-driven slots (app-version) unchanged.
6. **`src/layout/Shell.tsx`** — mount `<FeatureSlot slot="app-init" attrs={{ target: apiBase() || window.location.origin, project: 'plst' }} />` in the header next to the app-version slot (target = the backend URL baked from `BACK_URL`, same-origin fallback for local dev).
7. **`FeatureSlot.spec.tsx`** — specs for the bootstrap builder and bootstrap-first resolution (bootstrap row mounts even while the config fetch is pending).

Verification: `npm test` (vitest) green + `npm run build` passes; plan/result logged in plst DECISIONS.md; nothing committed.