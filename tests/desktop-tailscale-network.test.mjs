import assert from 'node:assert/strict';
import test from 'node:test';
import { configureTailscaleNetwork } from '../desktop/tailscale-network.cjs';

const peer = (DNSName, ...TailscaleIPs) => ({ DNSName, TailscaleIPs });
const running = (...peers) => ({ BackendState: 'Running',
  Peer: Object.fromEntries(peers.map((p, i) => [i, p])) });
const configure = (status, preset = {}) => {
  const switches = { ...preset };
  const commandLine = {
    hasSwitch: name => Object.hasOwn(switches, name),
    appendSwitch: (name, value = '') => { switches[name] = value; },
  };
  const applied = configureTailscaleNetwork(commandLine, {
    readStatus: typeof status === 'function' ? status : () => JSON.stringify(status),
  });
  return { switches, applied };
};

test('direct mode maps current daemon-owned peer and self names to their overlay IPv4 addresses', () => {
  const status = running(peer('Remote.Shared.TS.NET.', 'fd7a:115c:a1e0::1', '100.127.255.255'));
  status.Self = peer('self.example.ts.net.', '100.64.0.0');
  const { applied, switches } = configure(status);
  assert.equal(applied, true); assert.equal(switches['no-proxy-server'], '');
  assert.deepEqual(switches['host-resolver-rules'].split(',').map(rule => rule.trim()).sort(),
    ['MAP remote.shared.ts.net 100.127.255.255', 'MAP self.example.ts.net 100.64.0.0']);
  status.Self.TailscaleIPs = ['100.64.1.2'];
  assert.match(configure(status).switches['host-resolver-rules'], /MAP self\.example\.ts\.net 100\.64\.1\.2/);
});

test('resolver rules exclude non-TS destinations, DNS grammar injections and non-overlay addresses', () => {
  const names = ['*', '*.x.ts.net', 'x.ts.net,MAP * 127.0.0.1', 'x ..ts.net', 'x\n.y.ts.net',
    'x..y.ts.net', 'x.-bad.ts.net', 'x.bad-.ts.net', 'x.ts.net..', 'x.ts.net:443', 'x.ts.net.invalid',
    'localhost', 'a'.repeat(64) + '.x.ts.net', ('a'.repeat(63) + '.').repeat(4) + 'ts.net'];
  const ips = ['100.63.255.255', '100.128.0.0', '100.64.0.256', '100.064.0.1', '127.0.0.1',
    '2001:db8::1', '100.64.0.1, EXCLUDE *', '10.1.2.3'];
  const status = running(...names.map(name => peer(name, '100.64.0.1')),
    ...ips.map(ip => peer('bad.example.ts.net', ip)), peer('ok.example.ts.net', '100.64.0.1'),
    { DNSName: 'wan.example.ts.net', Addrs: ['100.64.1.1:41641'] });
  assert.equal(configure(status).switches['host-resolver-rules'], 'MAP ok.example.ts.net 100.64.0.1');
});

test('distinct assignments to the same normalized name are skipped regardless of peer order', () => {
  const a = peer('X.example.ts.net.', '100.64.1.1'), b = peer('x.example.ts.net', '100.64.1.2');
  const good = peer('ok.example.ts.net', '100.64.1.1');
  for (const peers of [[a, b, a], [b, a, a], [peer(a.DNSName, ...a.TailscaleIPs, ...b.TailscaleIPs)]]) {
    const status = running(...peers, good, good);
    assert.equal(configure(status).switches['host-resolver-rules'], 'MAP ok.example.ts.net 100.64.1.1');
  }
});

test('missing CLI, stopped daemon, invalid status or an unusable map leaves ordinary networking intact', () => {
  const stopped = { ...running(peer('x.example.ts.net', '100.64.1.1')), BackendState: 'Stopped' };
  for (const status of [() => { throw new Error('missing CLI'); }, () => 'invalid json', null, stopped, running(),
    running(null, {}, peer('v6.example.ts.net', 'fd7a:115c:a1e0::1'))]) {
    assert.deepEqual(configure(status), { switches: {}, applied: false });
  }
});

test('explicit Chromium proxy or resolver switches take precedence without inspecting peer status', () => {
  for (const flag of ['host-resolver-rules', 'host-rules', 'proxy-server', 'proxy-bypass-list', 'proxy-pac-url', 'proxy-auto-detect']) {
    const switches = { [flag]: 'user-value' }; let reads = 0;
    assert.deepEqual(configure(() => { reads++; return '{}'; }, switches), { switches, applied: false });
    assert.equal(reads, 0);
  }
  const direct = configure(running(peer('x.example.ts.net', '100.64.0.1')), { 'no-proxy-server': '' });
  assert.equal(direct.applied, true);
  assert.equal(direct.switches['host-resolver-rules'], 'MAP x.example.ts.net 100.64.0.1');
});

test('an excessively large resolver map leaves both routing switches unset', () => {
  const peers = Array.from({ length: 5000 }, (_, i) => peer('node-' + i + '.example.ts.net', '100.64.0.1'));
  assert.deepEqual(configure(running(...peers)), { switches: {}, applied: false });
});
