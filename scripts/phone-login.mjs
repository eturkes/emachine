import { createHash } from 'node:crypto';

export const phoneSessionPath = '/_emachine/phone/session';

const style = `
:root{color-scheme:light dark;font-family:"Atkinson Hyperlegible Next",system-ui,sans-serif;background:#f4f4f4;color:#171717}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:min(100%,380px);padding:32px 28px;background:#fff;border:1px solid #d4d4d4;border-radius:12px}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 12px;letter-spacing:-.03em}
p{line-height:1.5;margin:0 0 24px;color:#525252}
label{display:block;margin:18px 0 6px;font-weight:600}
input,button{width:100%;min-height:48px;border-radius:6px;font:inherit;font-size:16px}
input{padding:10px 12px;border:1px solid #737373;background:transparent;color:inherit}
input[readonly]{color:#525252}
button{margin-top:24px;border:1px solid #171717;background:#171717;color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.65;cursor:wait}
:focus-visible{outline:2px solid currentColor;outline-offset:3px}
[role=status]{min-height:3em;margin:16px 0 0;font-size:.9rem}
@media(prefers-color-scheme:dark){:root{background:#141414;color:#eee}main{background:#202020;border-color:#444}p,input[readonly]{color:#bbb}button{background:#eee;color:#171717;border-color:#eee}}
`;
const script = `
const form = document.querySelector('form');
const password = document.querySelector('#password');
const button = document.querySelector('button');
const status = document.querySelector('[role=status]');
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = 'Signing in...';
  try {
    const bytes = new TextEncoder().encode('emachine:' + password.value);
    password.value = '';
    const response = await fetch('${phoneSessionPath}', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Authorization: 'Basic ' + btoa(String.fromCharCode(...bytes)) },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 204) { location.reload(); return; }
    status.textContent = response.status === 401 ? 'The password is incorrect. Try again.' : 'Sign-in is unavailable. Try again.';
  } catch {
    status.textContent = 'Cannot reach emachine. Check your connection and try again.';
  } finally {
    button.disabled = false;
  }
});
`;
const hash = text => "'sha256-" + createHash('sha256').update(text).digest('base64') + "'";

// This document contains no app bytes or identity. It remains usable through an old shell service worker.
export const phoneLoginResponse = {
  handler: 'static_response', status_code: 401,
  headers: {
    'Content-Type': ['text/html; charset=utf-8'],
    'Cache-Control': ['no-store'],
    'Content-Security-Policy': [`default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`],
    'X-Frame-Options': ['DENY'],
  },
  body: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to emachine</title><style>${style}</style></head>
<body><main><h1>Sign in to emachine</h1><p>Enter your phone password to open the app or renew your session.</p>
<form method="post"><label for="username">Username</label><input id="username" name="username" value="emachine" autocomplete="username" readonly>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>
<button type="submit">Sign in</button><p role="status" aria-live="polite"></p></form>
<noscript><p>Enable JavaScript to sign in.</p></noscript></main><script>${script}</script></body></html>`,
};
