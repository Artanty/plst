// npm run logs is what AGENTS.md tells you to run first when a bug is reported, so its output has to
// be honest. Two things were wrong and both looked like the log itself lying:
//
//   - app.log and error.log were printed file by file, so an error from last night appeared AFTER
//     today's lines — scrambled history rather than a timeline
//   - a missing file was reported as "the server writes them on its first entry" even when the
//     server has been up for hours, which is indistinguishable from a broken install
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/logs.mjs', import.meta.url));

const entry = (ts: string, level: string, msg: string) =>
  JSON.stringify({ ts, level, fn: 'test', msg, data: { n: msg.length } });

describe('npm run logs', () => {
  let dir: string;

  // Fixtures live in beforeAll, not in the first test's body: otherwise running any single test with
  // -t finds an empty directory and the assertions fail for a reason that has nothing to do with
  // the code under test.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plst-tail-'));
    // Deliberately interleaved, and error.log holds BOTH the oldest and the newest entry — which is
    // what made file-by-file printing look scrambled.
    await writeFile(
      join(dir, 'app.log'),
      [
        entry('2026-10-01T09:00:02.000Z', 'log', 'app-two'),
        entry('2026-10-01T09:00:04.000Z', 'log', 'app-four'),
      ].join('\n') + '\n'
    );
    await writeFile(
      join(dir, 'error.log'),
      [
        entry('2026-10-01T09:00:01.000Z', 'error', 'err-one'),
        entry('2026-10-01T09:00:03.000Z', 'error', 'err-three'),
        entry('2026-10-01T09:00:05.000Z', 'error', 'err-five'),
      ].join('\n') + '\n'
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges app.log and error.log by timestamp, oldest first', async () => {
    const { stdout } = await run('node', [SCRIPT, '--dir', dir, '--no-follow']);
    const order = stdout
      .split('\n')
      .map((l) => l.match(/app-two|app-four|err-one|err-three|err-five/)?.[0])
      .filter(Boolean);
    expect(order).toEqual(['err-one', 'app-two', 'err-three', 'app-four', 'err-five']);
  });

  it('prints the time, level, message, fn and JSON data', async () => {
    const { stdout } = await run('node', [SCRIPT, '--dir', dir, '--no-follow']);
    const line = stdout.split('\n').find((l) => l.includes('app-two'))!;
    expect(line).toMatch(/^09:00:02\.000\s+LOG\s+app-two/);
    expect(line).toContain('(test)');
    expect(line).toContain('{"n":7}');
    expect(stdout.split('\n').find((l) => l.includes('err-one'))).toMatch(/ERROR\s+err-one/);
  });

  it('honours --last across files', async () => {
    const { stdout } = await run('node', [SCRIPT, '--dir', dir, '--last', '2', '--no-follow']);
    const shown = stdout
      .split('\n')
      .map((l) => l.match(/app-two|app-four|err-one|err-three|err-five/)?.[0])
      .filter(Boolean);
    // Two overall, not two per file: --last is the newest N of the merged timeline, so the two
    // newest entries are app-four (09:00:04) and err-five (09:00:05) — one from each file.
    expect(shown).toEqual(expect.arrayContaining(['app-four', 'err-five']));
    expect(shown).toHaveLength(2);
    expect(stdout).not.toContain('app-two');
    expect(stdout).not.toContain('err-three');
  });

  it('--ext explains that extension logs appear when the popup uploads', async () => {
    const extDir = await mkdtemp(join(tmpdir(), 'plst-tail-ext-'));
    try {
      const { stdout } = await run('node', [SCRIPT, '--dir', extDir, '--ext', '--no-follow']);
      expect(stdout).toMatch(/no extension logs yet/);
      // Actionable, not just an absence.
      expect(stdout).toMatch(/Upload logs to server/);
    } finally {
      await rm(extDir, { recursive: true, force: true });
    }
  });

  it('--ext reads ext.log only', async () => {
    const extDir = await mkdtemp(join(tmpdir(), 'plst-tail-ext2-'));
    try {
      await writeFile(
        join(extDir, 'ext.log'),
        entry('2026-10-01T10:00:00.000Z', 'log', 'from-the-extension') + '\n'
      );
      await writeFile(join(extDir, 'app.log'), entry('2026-10-01T09:00:00.000Z', 'log', 'from-server') + '\n');
      const { stdout } = await run('node', [SCRIPT, '--dir', extDir, '--ext', '--no-follow']);
      expect(stdout).toContain('from-the-extension');
      expect(stdout).not.toContain('from-server');
    } finally {
      await rm(extDir, { recursive: true, force: true });
    }
  });

  it('tells a missing app.log apart from a server that never logged', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'plst-tail-empty-'));
    try {
      const { stdout } = await run('node', [SCRIPT, '--dir', emptyDir, '--no-follow']);
      expect(stdout).toMatch(/no log files in/);
      expect(stdout).toMatch(/npm start/);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('--raw prints the JSON lines unchanged', async () => {
    const { stdout } = await run('node', [SCRIPT, '--dir', dir, '--raw', '--no-follow']);
    expect(stdout).toContain('"msg":"app-two"');
    expect(stdout).not.toContain('(test)');
  });
});