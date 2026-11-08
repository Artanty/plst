import { settings } from './config.js';
import { checkDatabase, classifyDbError, probeTcp, publicIp } from './lib/dbDiag.js';

/**
 * `npm run db:check` — the "it happened again, what do I do" command.
 *
 * Runs the diagnosis ladder in the order the failures actually stack (network → firewall →
 * grants → data) and prints, at every failed step, the verdict plus the ready-to-run next step.
 * Written after the 2026-10-13/20 outages, where the real cause took a manual session of ping,
 * nc, whois, SHOW GRANTS and ifconfig.me to pin down; this script is exactly that session,
 * automated, so the next one takes seconds.
 */
async function main(): Promise<void> {
  const host = settings.dbHost ?? '127.0.0.1';
  const port = settings.dbPort;

  console.log('plst database check');
  console.log('===================');
  console.log(`target:   ${host}:${port}  db=${settings.dbName ?? '(default)'}  user=${settings.dbUser ?? '(default)'}`);
  console.log(`ytmProxy: ${settings.ytmProxy ?? '(none)'}   yandexProxy: ${settings.yandexProxy ?? '(none)'}`);

  // 1. What does the VPS see as our address? Both the firewall rule and the grant key off this.
  const ip = await publicIp();
  console.log(`\n[1/4] this machine's public IP: ${ip ?? 'unknown (ifconfig.me unreachable — itself a network hint)'}`);

  // 2. Raw TCP — firewall layer, before MySQL has any opinion.
  console.log(`\n[2/4] TCP ${host}:${port} …`);
  const tcp = await probeTcp(host, port);
  if (tcp.ok) {
    console.log(`  open — handshake in ${tcp.latencyMs}ms. Firewall lets this IP through.`);
  } else {
    const verdict = classifyDbError(tcp.error, host);
    console.log(`  FAILED: ${verdict.headline}`);
    for (const a of verdict.actions) {
      console.log(`  → ${a.text}`);
      if (a.code) console.log(a.code.replace(/^/gm, '      '));
    }
    // No point logging in when TCP is dead — but say so rather than looking hung.
    console.log('\nStopping here: MySQL cannot be reached at the TCP layer, so a login would only time out too.');
    process.exitCode = 1;
    return;
  }

  // 3. Login + identity + grants — the grant layer.
  console.log(`\n[3/4] MySQL login as ${settings.dbUser ?? '(default)'} …`);
  const probe = await checkDatabase({
    host,
    port,
    user: settings.dbUser ?? undefined,
    password: settings.dbPassword ?? undefined,
    database: settings.dbName ?? undefined,
  });
  if (probe.verdict.kind === 'ok') {
    console.log(`  ok — ${probe.verdict.headline}, round-trip ${probe.latencyMs}ms`);
    if (probe.grants?.length) {
      console.log('  grants:');
      for (const g of probe.grants) console.log(`    ${g}`);
    }
  } else {
    console.log(`  FAILED: ${probe.verdict.headline}`);
    for (const a of probe.verdict.actions) {
      console.log(`  → ${a.text}`);
      if (a.code) console.log(a.code.replace(/^/gm, '      '));
    }
    process.exitCode = 1;
  }

  // 4. Is it the RIGHT database, with the data in it? Only meaningful once logged in — after a
  // login failure "no songs table" would be a red herring on top of the real error.
  console.log('\n[4/4] data sanity:');
  if (probe.verdict.kind !== 'ok') {
    console.log('  skipped — the login step above failed, so there is no data to inspect yet.');
  } else if (probe.songCount !== null && probe.songCount !== undefined) {
    console.log(`  songs table: ${probe.songCount} rows`);
    if (probe.songCount === 0) {
      console.log('  ⚠ empty — DB_HOST may point at a different MySQL than your library lives in.');
    }
  } else {
    console.log('  no songs table reachable (fresh install, or no rights on this schema).');
  }

  if (probe.verdict.kind !== 'ok') {
    console.log('\nVerdict: the DATABASE LAYER is the problem — fix it before touching app code.');
  } else {
    console.log('\nVerdict: database is reachable and correctly logged into. If the app still fails,');
    console.log('the failing call is elsewhere — check back/logs/error.log for the exact route.');
  }
}

main().catch((err) => {
  console.error('db:check itself failed:', err);
  process.exitCode = 1;
});
