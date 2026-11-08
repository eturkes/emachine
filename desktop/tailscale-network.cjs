'use strict';
const { execFileSync } = require('node:child_process');
const { isIPv4 } = require('node:net');

const explicitRouting = ['host-resolver-rules', 'host-rules', 'proxy-server', 'proxy-pac-url', 'proxy-bypass-list', 'proxy-auto-detect'];
const peerName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/i;

function readLocalStatus() {
  return execFileSync('tailscale', ['status', '--json'], {
    encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function resolverRules(status) {
  if (status?.BackendState !== 'Running' ||
      (status.Peer != null && (typeof status.Peer !== 'object' || Array.isArray(status.Peer)))) return '';
  const addresses = new Map();
  for (const peer of [status.Self, ...Object.values(status.Peer ?? {})]) {
    if (typeof peer?.DNSName !== 'string' || !Array.isArray(peer.TailscaleIPs)) continue;
    const name = peer.DNSName.replace(/\.$/, '');
    if (name.length > 253 || !peerName.test(name)) continue;
    const host = name.toLowerCase();
    for (const ip of peer.TailscaleIPs) {
      if (!isIPv4(ip)) continue;
      const [first, second] = ip.split('.').map(Number);
      if (first !== 100 || second < 64 || second > 127) continue;
      // A duplicate name with conflicting addresses must use the normal resolver.
      if (!addresses.has(host)) addresses.set(host, ip);
      else if (addresses.get(host) !== ip) addresses.set(host, null);
    }
  }
  const rules = [];
  for (const [host, ip] of addresses) if (ip !== null) rules.push(`MAP ${host} ${ip}`);
  return rules.join(',');
}

function configureTailscaleNetwork(commandLine, { readStatus = readLocalStatus } = {}) {
  if (explicitRouting.some(flag => commandLine.hasSwitch(flag))) return false;
  let rules;
  try { rules = resolverRules(JSON.parse(readStatus())); }
  catch { return false; }
  // Chromium forwards this switch to subprocesses. Leave room under Linux's per-argument limit.
  if (!rules || rules.length > 64 * 1024) return false;
  commandLine.appendSwitch('host-resolver-rules', rules);
  if (!commandLine.hasSwitch('no-proxy-server')) commandLine.appendSwitch('no-proxy-server');
  return true;
}

module.exports = { configureTailscaleNetwork };
