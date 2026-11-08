#!/usr/bin/env node
// One-time Yandex Music token fetch via OAuth Device Flow.
//   node scripts/get_yandex_token.mjs
// Put the printed access_token into .env as YANDEX_TOKEN.
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';
const OAUTH_BASE = 'https://oauth.yandex.ru';


function randomDeviceId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function postForm(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const code = await postForm(`${OAUTH_BASE}/device/code`, {
    client_id: CLIENT_ID,
    device_id: randomDeviceId(),
    device_name: 'plst',
  });
  console.log(`\nOpen ${code.verification_url ?? 'https://oauth.yandex.ru/authorize'} and enter the code: ${code.user_code}\n`);

  const interval = (code.interval ?? 5) * 1000;
  for (let waited = 0; waited < (code.expires_in ?? 600) * 1000; waited += interval) {
    await sleep(interval);
    try {
      const token = await postForm(`${OAUTH_BASE}/token`, {
        grant_type: 'device_code',
        code: code.device_code ?? code.code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
      console.log('access_token: ', token.access_token);
      console.log('refresh_token:', token.refresh_token);
      console.log('expires_in:   ', token.expires_in);
      return;
    } catch (err) {
      if (String(err).includes('authorization_pending')) continue;
      throw err;
    }
  }
  throw new Error('device code expired without confirmation');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
