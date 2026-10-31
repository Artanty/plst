#!/usr/bin/env node
/**
 * Tail the backend log files as compact, readable lines.
 *
 *   npm run logs                 # follow app.log + error.log, last 40 lines first
 *   npm run logs -- --last 200   # how much history to show before following
 *   npm run logs -- --errors     # only error.log ("the errors on their own")
 *   npm run logs -- --no-follow  # dump the tail and exit (scriptable)
 *   npm run logs -- --raw        # print the raw JSON lines instead of formatted ones
 *
 * The files are written by src/lib/logger.ts as one JSON object per line, which is great for
 * machines and awful for reading. This prints the same compact shape the logger mirrors to the
 * console, so `npm run logs` and a terminal running the server look alike.
 *
 * No dependencies, on purpose: it must keep working when the app itself is broken.
 *
 * Note: an error entry is written ONLY to error.log (never to app.log), so following both files
 * does not duplicate anything.
 */
import { open, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const valueOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

if (has('--help') || has('-h')) {
  console.log(
    [
      'Usage: npm run logs -- [options]',
      '',
      '  --last N       lines of history to print before following (default 40, 0 to skip)',
      '  --errors       follow only error.log',
      '  --ext          follow ext.log — the extension log shipped from the popup',
      '  --no-follow    print the tail and exit',
      '  --raw          print raw JSON lines',
      '  --dir PATH     log directory (default: $LOG_DIR or ./logs)',
      '',
      'While the server is running, the same buffer is available over HTTP:',
      '  curl -s "http://127.0.0.1:8000/api/library/logs?last=60"',
      '  curl -s "http://127.0.0.1:8000/api/library/logs?last=60&type=error"',
    ].join('\n')
  );
  process.exit(0);
}

const dir = valueOf('--dir', process.env.LOG_DIR || join(process.cwd(), 'logs'));
const last = Number(valueOf('--last', 40)) || 0;
const follow = !has('--no-follow');
const raw = has('--raw');
const EXT_FILE = 'ext.log';
const files = has('--ext') ? [EXT_FILE] : has('--errors') ? ['error.log'] : ['app.log', 'error.log'];

const OFFSETS = new Map();

function print(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    console.log(line); // malformed line: show it as-is rather than swallow it
    return;
  }
  if (raw) {
    console.log(line);
    return;
  }
  const time = String(entry.ts ?? '').slice(11, 23);
  const level = String(entry.level ?? 'log').toUpperCase().padEnd(5);
  let out = `${time} ${level} ${entry.msg ?? ''}`;
  if (entry.fn && entry.fn !== 'unknown') out += `  (${entry.fn})`;
  if (entry.data !== undefined) {
    try {
      out += ` ${JSON.stringify(entry.data)}`;
    } catch {
      out += ' [unserializable data]';
    }
  }
  console.log(out);
  if (entry.stack) console.log(entry.stack);
}

const printLines = (text) => {
  for (const line of text.split('\n')) if (line.trim()) print(line);
};

/** The entry's own timestamp, or '' for a malformed line (sorted last). */
const tsOf = (line) => {
  try {
    return String(JSON.parse(line).ts ?? '');
  } catch {
    return '';
  }
};

/**
 * Read the last `n` lines of one file, remember where to continue from, and RETURN them rather
 * than printing — the caller merges the files by timestamp first.
 */
async function prime(file, n) {
  if (!existsSync(file)) {
    OFFSETS.set(file, 0);
    return [];
  }
  const size = (await stat(file)).size;
  OFFSETS.set(file, size);
  if (n <= 0) return [];
  // Everything, not a per-file slice: --last is applied after the merge, so it means "the newest N
  // overall" instead of "N from each file" (which would print 2N and could surface an older error
  // below a newer one).
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => [tsOf(line), line]);
}

/** Read whatever was appended since the last check, line-aligned. */
async function drain(file) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    return;
  }
  let from = OFFSETS.get(file) ?? 0;
  if (from > size) from = 0; // truncated or rotated out from under us: start over
  if (from === size) {
    OFFSETS.set(file, size);
    return;
  }
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return;
  try {
    const buf = Buffer.alloc(size - from);
    await handle.read(buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const nl = text.lastIndexOf('\n');
    if (nl === -1) {
      // a partial line, still being written: leave the offset before it
      return;
    }
    OFFSETS.set(file, size - Buffer.byteLength(text.slice(nl + 1), 'utf8'));
    printLines(text.slice(0, nl));
  } finally {
    await handle.close();
  }
}

const missing = files.filter((f) => !existsSync(join(dir, f)));
if (missing.length === files.length) {
  // The point of this tool is to explain silence, so say which file is absent and why — a missing
  // error.log means "no errors yet", which is good news, not a missing log.
  if (has('--errors')) {
    console.log(`no errors logged yet: ${join(dir, 'error.log')} is created on the first error entry.`);
  } else if (has('--ext')) {
    // The usual reason this file is missing: the popup has not been opened since the endpoint
    // shipped, or shipping failed. Say so, rather than leaving it looking like a broken install.
    console.log(`no extension logs yet: ${join(dir, EXT_FILE)} is created when the popup first uploads.`);
    console.log('  open the popup, or press "Upload logs to server" in its diagnostics panel.');
  } else {
    console.log(`no log files in ${dir} yet — the server creates them on its first entry.`);
    console.log(`  LOG_DIR=${dir}  (start the server: npm start)`);
  }
  if (!follow) process.exit(0);
} else {
  console.log(`tailing ${files.map((f) => join(dir, f)).join(' + ')} — Ctrl-C to stop\n`);
}

// Merged by timestamp, not printed file by file. app.log and error.log are separate files, so a
// file-by-file dump put an error from last night AFTER today's lines — which reads as scrambled
// output rather than as history, and makes a quiet start look like it is hiding a failure.
const primed = [];
for (const f of files) primed.push(...(await prime(join(dir, f), last)));
primed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
for (const [, line] of last > 0 ? primed.slice(-last) : primed) print(line);

if (follow) {
  // Polling rather than fs.watch: it survives rotation and truncation without a re-attach dance,
  // and 250ms is far below anything a human reading a terminal will notice.
  const timer = setInterval(() => {
    for (const f of files) void drain(join(dir, f));
  }, 250);

  const stop = () => {
    clearInterval(timer);
    console.log('');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
