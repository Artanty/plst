#!/usr/bin/env node
/**
 * Vendor the js-node builds of the shared server features from the feat project.
 *
 * feat (/Users/artyomantoshkin/server/feat) is the CANONICAL home: the specs live in
 * feat/back/spec/, the implementations in feat/back/features/<feature>/v1/js-node/, and the
 * contract tests in feat/back/test/. Never edit the vendored copies in place — edit feat,
 * then re-run `npm run features:sync` here.
 *
 * Each feature maps specific files (skipping index.js — that is feat's router entry, not part
 * of the vendored set) to their destination filenames in src/lib/. The destination names match
 * the existing imports, so vendoring never touches call sites.
 *
 * Set FEAT_DIR to point at a different feat checkout.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const featDir = process.env.FEAT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../feat');
const featuresDir = join(featDir, 'back', 'features');
const destDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib');

// feature name → [source file, destination filename]
const VENDOR = {
  logging: [
    ['logger.js', 'logger.js'],
    ['logger.d.ts', 'logger.d.ts'],
    ['ext-log.js', 'ext-log.js'],
    ['ext-log.d.ts', 'ext-log.d.ts'],
  ],
  'db-diag': [
    ['dbDiag.js', 'dbDiag.js'],
    ['dbDiag.d.ts', 'dbDiag.d.ts'],
  ],
};

mkdirSync(destDir, { recursive: true });
for (const [feature, files] of Object.entries(VENDOR)) {
  const src = join(featuresDir, feature, 'v1', 'js-node');
  for (const [from, to] of files) {
    copyFileSync(join(src, from), join(destDir, to));
    console.log(`vendored ${feature}/${from} -> src/lib/${to}`);
  }
}
console.log('done — run the backend suite to verify');
