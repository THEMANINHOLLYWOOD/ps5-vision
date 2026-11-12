// PlayStation device discovery and wake-up over UDP (the same tiny text
// protocol the official Remote Play app uses on the local network).

import dgram from 'node:dgram';
import os from 'node:os';

const PORT_PS5 = 9302;
const PORT_PS4 = 987;
const PROTOCOL_PS5 = '00030010';
const PROTOCOL_PS4 = '00020020';

// Parses a discovery reply. Returns null if it isn't one.
export function parseDiscoveryResponse(text, address) {
  const lines = text.split(/\r?\n/);
  const match = /^HTTP\/1\.1\s+(\d+)/.exec(lines[0] ?? '');
  if (!match) return null;
  const code = Number(match[1]);
  const fields = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    address,
    state: code === 200 ? 'ready' : code === 620 ? 'standby' : 'unknown',
    code,
    name: fields['host-name'] ?? '',
    type: fields['host-type'] ?? '',
    id: fields['host-id'] ?? '',
    systemVersion: fields['system-version'] ?? '',
    runningApp: fields['running-app-name'] ?? '',
  };
}

// The wake-up credential is the registration key (ASCII hex, NUL padded,
// stored by us as hex-of-bytes) read as one hexadecimal number.
export function wakeCredential(registKeyHex) {
  const ascii = Buffer.from(registKeyHex, 'hex').toString('latin1').replace(/\0+$/, '');
  if (!/^[0-9a-fA-F]+$/.test(ascii)) throw new Error('registration key is not hexadecimal text');
  return BigInt(`0x${ascii}`).toString(10);
}

// Broadcast address of every active IPv4 interface, e.g. 192.168.7.255.
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address.split('.').map(Number);
      const mask = iface.netmask.split('.').map(Number);
      out.add(ip.map((octet, i) => (octet | (~mask[i] & 0xff)) & 0xff).join('.'));
    }
  }
  return [...out];
}

// Asks the network (or one host) who is there. Resolves with every console
// that answered within timeoutMs.
export function discover({ host, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map();
    let timer;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* never bound */ }
      resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      const parsed = parseDiscoveryResponse(msg.toString('utf8'), rinfo.address);
      if (parsed) found.set(rinfo.address, parsed);
      if (parsed && host) finish();
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const targets = host ? [host] : [...broadcastAddresses(), '255.255.255.255'];
      const send = () => {
        for (const target of targets) {
          for (const [port, version] of [[PORT_PS5, PROTOCOL_PS5], [PORT_PS4, PROTOCOL_PS4]]) {
            const packet = Buffer.from(`SRCH * HTTP/1.1\ndevice-discovery-protocol-version:${version}\n\0`);
            socket.send(packet, port, target, () => {});
          }
        }
      };
      send();
      // UDP is lossy; ask a second time partway through.
      setTimeout(() => { try { send(); } catch { /* socket already closed */ } }, Math.min(400, timeoutMs / 2)).unref();
      timer = setTimeout(finish, timeoutMs);
    });
  });
}

// Picks the linked console out of discovery replies. The PS5 reports its
// network hardware address as host-id, which, unlike its IP address, never
// changes. Consoles linked before the address was saved fall back to the name,
// but only if exactly one console has it.
export function findLinkedConsole(replies, linked) {
  const clean = (id) => String(id ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const id = clean(linked.mac);
  if (id) return replies.find((reply) => clean(reply.id) === id) ?? null;
  const named = replies.filter((reply) => reply.name && reply.name === linked.name);
  return named.length === 1 ? named[0] : null;
}

// Finds the linked console: first at its saved address, then, if that is
// silent or answered by a different device (the router gave the PS5 a new
// address), anywhere on the network. Resolves with the console's reply, or
// null, and whether it was found somewhere new. `ask` is for tests.
export async function locateConsole(linked, { ask = discover } = {}) {
  const atSaved = (await ask({ host: linked.host, timeoutMs: 1500 }))[0] ?? null;
  if (atSaved && (!linked.mac || findLinkedConsole([atSaved], linked))) return { reply: atSaved, moved: false };
  const elsewhere = findLinkedConsole(await ask({ timeoutMs: 2000 }), linked);
  if (elsewhere) return { reply: elsewhere, moved: elsewhere.address !== linked.host };
  return { reply: null, moved: false, otherDevice: Boolean(atSaved) };
}

// Wakes a console from rest mode. It only works if the console is plugged in,
// in rest mode, and has "Enable turning on PS5 from network" switched on.
export function wakeup(host, registKeyHex, { ps5 = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.from(
      'WAKEUP * HTTP/1.1\n' +
      'client-type:vr\n' +
      'auth-type:R\n' +
      'model:w\n' +
      'app-type:r\n' +
      `user-credential:${wakeCredential(registKeyHex)}\n` +
      `device-discovery-protocol-version:${ps5 ? PROTOCOL_PS5 : PROTOCOL_PS4}\n\0`,
    );
    socket.on('error', (err) => { socket.close(); reject(err); });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.send(packet, ps5 ? PORT_PS5 : PORT_PS4, host, (err) => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}
