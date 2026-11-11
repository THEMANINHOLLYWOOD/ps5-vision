// A self-signed certificate so the page can also be served over HTTPS.
// Safari only exposes game controllers to pages on a secure connection, and
// a LAN address can't get a publicly trusted certificate, so the headset
// shows a one-time warning that you accept.

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function localAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// The Mac's Bonjour name, e.g. "Someones-MacBook-Pro.local".
export function bonjourName() {
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
    if (name) return `${name}.local`;
  } catch {
    // not macOS, or no name set
  }
  return null;
}

// Browsers refuse an expired certificate outright, so renew ahead of time.
function validForAnotherMonth(certFile) {
  try {
    const expires = new Date(new X509Certificate(fs.readFileSync(certFile)).validTo).getTime();
    return expires - Date.now() > 30 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// Returns { key, cert } (PEM), creating or renewing files in dir as needed.
// Returns null if openssl isn't available; the caller then serves HTTP only.
export function ensureCertificate(dir, { names = [], addresses = [] } = {}) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const sanFile = path.join(dir, 'san.txt');
  const san = [
    'DNS:localhost',
    ...names.map((name) => `DNS:${name}`),
    'IP:127.0.0.1',
    ...addresses.map((address) => `IP:${address}`),
  ].join(',');

  const current = fs.existsSync(keyFile) && fs.existsSync(certFile)
    && fs.existsSync(sanFile) && fs.readFileSync(sanFile, 'utf8') === san
    && validForAnotherMonth(certFile);
  if (!current) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // openssl creates the key file readable by everyone and it is only
    // tightened afterwards; make the file first so it is never exposed.
    fs.rmSync(keyFile, { force: true });
    fs.writeFileSync(keyFile, '', { mode: 0o600 });
    const confFile = path.join(dir, 'openssl.cnf');
    fs.writeFileSync(confFile, [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      'CN = PS5 Vision bridge',
      '[ext]',
      `subjectAltName = ${san}`,
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      '',
    ].join('\n'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
        '-keyout', keyFile, '-out', certFile, '-config', confFile,
      ], { stdio: 'pipe' });
    } catch {
      return null;
    }
    fs.chmodSync(keyFile, 0o600);
    fs.writeFileSync(sanFile, san);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}
