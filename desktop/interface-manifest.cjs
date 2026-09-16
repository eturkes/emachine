'use strict';
const { createHash } = require('node:crypto');

const MANIFEST = 'ui-manifest.json';
const BRIDGE = 1;
const MAX_MANIFEST = 65536;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
function assetPath(path) {
  return typeof path === 'string' && path.length <= 240 && (
    ['index.html', 'manifest.webmanifest', 'sdk.js', 'sdk.css'].includes(path) ||
    /^(assets|icons)\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(js|css|woff2?|png|svg|ico|webp|jpg)$/.test(path));
}
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%]/.test(value) || /(^|\/)\.{1,2}(\/|$)/.test(value)) {
    throw failure('UI_SOURCE', 'Use an HTTPS address without credentials, queries, fragments, or encoded paths.');
  }
  let url;
  try { url = new URL(value); } catch { throw failure('UI_SOURCE', 'Enter the full HTTPS address of your trusted interface server.'); }
  const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(value);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || !url.hostname) {
    throw failure('UI_SOURCE', 'Use HTTPS, or HTTP on localhost. The address must not contain credentials, queries, or fragments.');
  }
  if (url.pathname.includes('//')) throw failure('UI_SOURCE', 'Use an address without repeated path separators.');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url;
}
function validateManifest(input) {
  const bad = () => { throw failure('UI_MANIFEST', 'The server returned invalid interface metadata. The current interface is unchanged.'); };
  if (!input || input.format !== 1 || !Number.isSafeInteger(input.bridge)) bad();
  if (input.bridge !== BRIDGE) throw failure('UI_BRIDGE', 'This interface needs a different desktop runtime. Install the required AppImage from GitHub Releases before refreshing.');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 256 || !isDigest(input.revision)) bad();
  let previous = ''; let total = 0;
  const files = input.files.map(file => {
    if (!file || !assetPath(file.path) || file.path <= previous || !isDigest(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE) bad();
    previous = file.path; total += file.bytes;
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (total > MAX_TOTAL || !files.some(file => file.path === 'index.html')) bad();
  const manifest = { format: 1, bridge: BRIDGE, files };
  if (digest(JSON.stringify(manifest)) !== input.revision) bad();
  return { ...manifest, revision: input.revision };
}
module.exports = { MANIFEST, BRIDGE, MAX_MANIFEST, MAX_FILE, MAX_TOTAL, digest, isDigest, assetPath, sourceUrl, validateManifest, failure };
