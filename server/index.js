#!/usr/bin/env node
// PS5 -> Vision Pro bridge. Run it on a Mac that is on the same network as the
// console, then open the printed address in Safari on the headset.
//
//   node server/index.js            stream the linked PS5
//   node server/index.js --demo     stream a test pattern (no console needed)
//   node server/index.js --local    only this Mac can open the page (for
//                                   watching on the Mac, or mirroring the Mac
//                                   into the headset with Mac Virtual Display)
//
// Options: --port N (default 8080), --https-port N (default 8443),
//          --no-https, --open (open the page in the default browser), --verbose,
//          --no-code (don't ask other devices for the access code)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Bridge } from './bridge.js';
import { AttemptLimiter, codesMatch, hostAllowed, isLoopback, loadOrCreateAccessCode } from './access.js';
import { ROOT, CONFIG_DIR, HELPER_PATH, loadConsole, saveConsole } from './config.js';
import { bonjourName, ensureCertificate, localAddresses } from './tls.js';

const WEB_DIR = path.join(ROOT, 'web');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/controller.js': ['controller.js', 'text/javascript; charset=utf-8'],
  '/keyboard.js': ['keyboard.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/capture.html': ['capture.html', 'text/html; charset=utf-8'],
  '/capture.js': ['capture.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 256 * 1024;

function parseArgs(argv) {
  const args = { demo: false, port: 8080, httpsPort: 8443, https: true, verbose: false, local: false, open: false, code: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--demo') args.demo = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--local') args.local = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--no-https') args.https = false;
    else if (arg === '--no-code') args.code = false;
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--https-port') args.httpsPort = Number(argv[++i]);
    else throw new Error(`unknown option: ${arg}`);
  }
  for (const key of ['port', 'httpsPort']) {
    if (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > 65535) throw new Error(`--${key === 'port' ? 'port' : 'https-port'} needs a port number`);
  }
  return args;
}

function log(message) {
  console.log(`${new Date().toLocaleTimeString()}  ${message}`);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(Object.assign(new Error('The request body must be a JSON object.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Only the page we serve may call the API. Stops some other website open in
// a browser on this network from poking at the console through us.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// 'ok', or why not: 'missing', 'wrong', 'blocked'. Requests from this machine
// itself never need the code.
function checkCode(req, info) {
  if (!info.accessCode || isLoopback(req.socket.remoteAddress)) return 'ok';
  const given = req.headers['x-access-code'];
  if (given === undefined) return 'missing';
  const from = req.socket.remoteAddress ?? '';
  if (info.limiter.blocked(from)) return 'blocked';
  if (codesMatch(given, info.accessCode)) return 'ok';
  info.limiter.fail(from);
  return 'wrong';
}

function createHandler(bridge, info, log) {
  return async (req, res) => {
    try {
      // Refuse names this machine doesn't go by (see access.js).
      if (!hostAllowed(req.headers.host, info.allowedHosts())) {
        sendJson(res, 403, { error: 'Open the bridge by one of the addresses it printed when it started.' });
        return;
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        sendJson(res, 400, { error: 'bad request' });
        return;
      }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        const data = await fs.promises.readFile(path.join(WEB_DIR, file));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(data);
        return;
      }
      if (url.pathname.startsWith('/api/') && !sameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are not allowed' });
        return;
      }
      const code = url.pathname.startsWith('/api/') ? checkCode(req, info) : 'ok';
      if (code === 'blocked') {
        sendJson(res, 429, { error: 'Too many wrong access codes. Wait a minute and try again.', needsCode: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        // Without the code, say only that one is needed (and whether the one
        // offered was wrong), nothing about the console.
        if (code !== 'ok') sendJson(res, 200, { needsCode: true, wrongCode: code === 'wrong' });
        else sendJson(res, 200, { ...bridge.status(), helperBuilt: info.helperBuilt(), secureUrl: info.secureUrl });
        return;
      }
      if (code !== 'ok') {
        sendJson(res, 401, { error: 'Enter the access code shown by the bridge on the Mac.', needsCode: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/connect') {
        if (!bridge.demo && !info.helperBuilt()) {
          sendJson(res, 409, { error: 'The PS5 helper has not been built yet. On the Mac, run: npm run setup' });
          return;
        }
        const body = await readJson(req);
        sendJson(res, 200, await bridge.connect(body));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = await readJson(req);
        if (typeof body.sdp !== 'string' || !Number.isInteger(body.id)) {
          sendJson(res, 400, { error: 'expected { id, sdp }' });
          return;
        }
        bridge.answer(body.id, body.sdp);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      // Errors with a status were written for the person at the browser.
      // Anything else is a bug or a system failure: log it, don't describe it.
      if (err.status) {
        sendJson(res, err.status, { error: err.message });
      } else {
        log(`request failed: ${err.stack ?? err.message}`);
        sendJson(res, 500, { error: 'The bridge hit an unexpected error. Its window on the Mac has the details.' });
      }
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.demo ? null : loadConsole();
  const bridge = new Bridge({
    demo: args.demo, console: target, helperPath: HELPER_PATH, verbose: args.verbose, log,
    onConsoleMoved: (moved) => saveConsole(moved), // so the next start looks in the right place first
  });

  // Local mode listens on the loopback address only: nothing else on the
  // network can open the page or control the console. localhost also counts
  // as a secure page, so controllers work without a certificate.
  const bindHost = args.local ? '127.0.0.1' : '0.0.0.0';
  const hostName = args.local ? null : bonjourName();
  const addresses = args.local ? [] : localAddresses();
  const hosts = [...(hostName ? [hostName] : []), ...addresses];
  const tls = args.https && !args.local
    ? ensureCertificate(path.join(CONFIG_DIR, 'tls'), { names: hostName ? [hostName] : [], addresses })
    : null;
  const info = {
    helperBuilt: () => fs.existsSync(HELPER_PATH),
    secureUrl: tls && hosts.length ? `https://${hosts[0]}:${args.httpsPort}/` : null,
    // Looked up per request: the Mac's address can change while this runs.
    allowedHosts: () => ['localhost', '127.0.0.1', '[::1]', ...(args.local ? [] : [...(hostName ? [hostName] : []), ...localAddresses()])],
    // Local mode only listens to this machine, which never needs the code.
    accessCode: args.code && !args.local ? loadOrCreateAccessCode(path.join(CONFIG_DIR, 'access-code')) : null,
    limiter: new AttemptLimiter(),
  };

  const handler = createHandler(bridge, info, log);
  const servers = [http.createServer(handler)];
  await listen(servers[0], args.port, bindHost);
  if (tls) {
    servers.push(https.createServer(tls, handler));
    await listen(servers[1], args.httpsPort, bindHost);
  }

  console.log('');
  console.log(args.demo ? '  PS5 Vision bridge: DEMO (test pattern, no console)' : '  PS5 Vision bridge');
  console.log('');
  if (!args.demo && !target) console.log('  No PS5 linked yet. Run: npm run link\n');
  else if (!args.demo && !info.helperBuilt()) console.log('  PS5 helper not built yet. Run: npm run setup\n');
  else if (target) console.log(`  Console: ${target.name} (${target.host})\n`);
  const localUrl = `http://localhost:${args.port}/`;
  if (args.local) {
    console.log('  Private mode: only this Mac can open the page.');
    console.log(`    ${localUrl}`);
    console.log('  To play in the Vision Pro, look at the Mac and tap Connect (Mac Virtual Display).');
  } else {
    console.log('  Open one of these in a browser on the device you want to play on:');
    for (const host of hosts) {
      if (tls) console.log(`    https://${host}:${args.httpsPort}/   (controller support; accept the certificate warning once)`);
      console.log(`    http://${host}:${args.port}/`);
    }
    if (!hosts.length) console.log(`    ${localUrl}   (no network interface found)`);
    console.log('');
    if (info.accessCode) console.log(`  Access code: ${info.accessCode}   (each device is asked for it once)`);
    else console.log('  No access code: anyone on this network can open the page and control the console.');
  }
  console.log('');
  if (args.open) execFile('open', [localUrl], () => {});

  const shutdown = () => {
    bridge.shutdown();
    for (const server of servers) server.close();
    // Give the helper a moment to say goodbye to the console.
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// One bad request or a helper that won't start must not take the bridge down
// mid-game.
process.on('unhandledRejection', (err) => log(`unexpected error: ${err?.stack ?? err}`));

main().catch((err) => {
  console.error(`ps5-vision: ${err.message}`);
  process.exit(1);
});
