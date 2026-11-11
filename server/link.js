#!/usr/bin/env node
// Links this Mac to a PS5 for Remote Play. Needs to be done once.
//
//   node server/link.js [--host 192.168.x.x] [--account-id BASE64] [--pin 12345678]
//
// Anything not given on the command line is asked for.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { CONSOLE_FILE, HELPER_PATH, saveConsole } from './config.js';
import { discover } from './discovery.js';

// Sony's sign-in for the official Remote Play app. Signing in there is the
// only way to learn the numeric ID of a PSN account, which the console
// insists on during linking. These values are the app's public identifiers.
const CLIENT_ID = 'ba495a24-818c-472b-b12d-ff231c1b5745';
const CLIENT_SECRET = 'mvaiZkRsAsI1IBkY';
const REDIRECT_URI = 'https://remoteplay.dl.playstation.net/remoteplay/redirect';
const TOKEN_URL = 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token';
const LOGIN_URL = 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize'
  + '?service_entity=urn:service-entity:psn&response_type=code'
  + `&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}`
  + '&scope=psn:clientapp&request_locale=en_US&ui=pr&service_logo=ps&layout_type=popup'
  + '&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!['--host', '--account-id', '--pin'].includes(name)) throw new Error(`unknown option: ${name}`);
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    args[name.slice(2)] = argv[++i];
  }
  return args;
}

// The account ID is 8 bytes, written as base64 by every Remote Play tool.
export function accountIdToHex(base64) {
  const bytes = Buffer.from(base64.trim(), 'base64');
  if (bytes.length !== 8) throw new Error('That is not a PSN account ID (expected 8 bytes of base64, like "AbCdEfGhIjk=").');
  return bytes.toString('hex');
}

export function userIdToAccountId(userId) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(userId));
  return bytes.toString('base64');
}

async function lookUpAccountId(rl) {
  console.log('\nSign in to PlayStation Network in your browser to look up your account ID:\n');
  console.log(`  ${LOGIN_URL}\n`);
  console.log('After signing in, the page just says "redirect". Copy that page\'s full');
  console.log('address from the address bar and paste it here.\n');
  const pasted = (await rl.question('Redirect address: ')).trim();
  let code;
  try {
    code = new URL(pasted).searchParams.get('code');
  } catch {
    code = null;
  }
  if (!code) throw new Error('That address has no sign-in code in it. Copy the whole address of the "redirect" page.');

  const auth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${REDIRECT_URI}&`,
  });
  if (!tokenResponse.ok) throw new Error(`PlayStation Network refused the sign-in code (${tokenResponse.status}). Codes expire quickly; sign in again.`);
  const { access_token: token } = await tokenResponse.json();
  if (!token) throw new Error('PlayStation Network did not return a token.');

  const infoResponse = await fetch(`${TOKEN_URL}/${encodeURIComponent(token)}`, { headers: { authorization: auth } });
  if (!infoResponse.ok) throw new Error(`Could not read the account details (${infoResponse.status}).`);
  const info = await infoResponse.json();
  if (!info.user_id) throw new Error('The account details did not include a user ID.');
  return userIdToAccountId(info.user_id);
}

// env: secrets for the helper, kept off its command line (see helper/main.c).
function runHelper(args, env) {
  return new Promise((resolve) => {
    execFile(HELPER_PATH, args, { timeout: 60_000, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let result = null;
      try {
        result = line ? JSON.parse(line) : null;
      } catch {
        result = null;
      }
      resolve({ result, stderr, error });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(HELPER_PATH)) throw new Error('The PS5 helper is not built yet. Run: npm run setup');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 1. Find the console.
    let host = args.host;
    let name = 'PS5';
    if (!host) {
      console.log('Looking for a PlayStation on this network…');
      const found = await discover({ timeoutMs: 2500 });
      if (found.length === 1) {
        [{ address: host, name }] = found;
        console.log(`Found ${name || found[0].type} at ${host} (${found[0].state}).`);
      } else if (found.length > 1) {
        found.forEach((item, i) => console.log(`  ${i + 1}. ${item.name || item.type} at ${item.address} (${item.state})`));
        const pick = Number(await rl.question('Which one? ')) - 1;
        if (!found[pick]) throw new Error('No such console.');
        ({ address: host, name } = found[pick]);
      } else {
        console.log('None answered. The PS5 must be switched on (not in rest mode) and on the same network.');
        console.log('If macOS asked whether this app may find devices on your local network, allow it.');
        console.log('Its address is under Settings > Network > Connection Status > View Connection Status.');
        host = (await rl.question('PS5 IP address: ')).trim();
        if (!host) throw new Error('No address given.');
      }
    } else {
      const found = await discover({ host, timeoutMs: 1500 });
      if (found[0]?.name) name = found[0].name;
    }

    // 2. PSN account ID.
    const accountId = args['account-id'] ?? await lookUpAccountId(rl);
    const accountHex = accountIdToHex(accountId);

    // 3. Linking PIN from the console.
    let pin = args.pin;
    if (!pin) {
      console.log('\nOn the PS5 go to Settings > System > Remote Play > Pair Device.');
      console.log('It shows an 8-digit number for a few minutes.\n');
      pin = (await rl.question('Number shown on the PS5: ')).replace(/\s+/g, '');
    }
    if (!/^\d{8}$/.test(pin)) throw new Error('The number from the PS5 is 8 digits.');

    // The PS5 sometimes drops the first attempt; the same number keeps working
    // for as long as the Pair Device screen shows it, so try a few times.
    let result = null;
    let stderr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(attempt === 1 ? '\nLinking…' : `Trying again (${attempt} of 3)…`);
      ({ result, stderr } = await runHelper(['register', '--host', host], { PS5_ACCOUNT_ID: accountHex, PS5_PIN: pin }));
      if (result?.ok) break;
      if (/refused the registration search/.test(stderr)) {
        throw new Error('The PS5 is not showing the Pair Device screen any more. Press OK on any error, open Settings > System > Remote Play > Pair Device again, leave it on screen, and use the new number.');
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!result?.ok) {
      const detail = stderr.trim().split('\n').slice(-4).join('\n');
      throw new Error(`The PS5 did not accept the link. Check the number (it expires) and that the account ID belongs to a user on this PS5.\n${detail}`);
    }

    saveConsole({
      host,
      name: result.nickname || name,
      mac: result.mac,
      ps5: result.ps5,
      registKey: result.regist_key,
      morning: result.morning,
    });
    console.log(`\nLinked to ${result.nickname || name}. Saved to ${CONSOLE_FILE}`);
    console.log('Start the bridge with: npm start');
  } finally {
    rl.close();
  }
}

// Only run when invoked directly, so the helpers above can be imported by tests.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
