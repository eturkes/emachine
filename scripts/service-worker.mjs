import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../web/dist/', import.meta.url);
async function files(dir = '') {
  const result = [];
  for (const item of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const path = dir + item.name;
    if (item.isDirectory()) result.push(...await files(path + '/'));
    else if (item.isFile() && path !== 'sw.js' && path !== 'bootstrap.json') result.push(path);
  }
  return result.sort();
}
const assets = await files();
const hash = createHash('sha256');
for (const asset of assets) hash.update(asset).update(await readFile(new URL(asset, root)));
const version = hash.digest('hex').slice(0, 16);
await writeFile(new URL('sw.js', root), `const CACHE='emachine-shell-${version}';
const FILES=${JSON.stringify(assets)};
const URLS=new Set(FILES.map(p=>new URL(p,self.registration.scope).href));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll([...URLS]))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('emachine-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  const start=new URL('./',self.registration.scope).href;
  if(request.mode==='navigate'&&(url.href===start||url.href===new URL('index.html',start).href)){
    event.respondWith(fetch(request).catch(()=>caches.open(CACHE).then(cache=>cache.match(new URL('index.html',start).href,{ignoreVary:true}))));
  }else if(URLS.has(url.href)){
    // These allowlisted shell bytes are origin-independent; the machine's CORS headers vary by Origin.
    event.respondWith(caches.open(CACHE).then(cache=>cache.match(request,{ignoreVary:true})).then(hit=>hit||fetch(request)));
  }
});
`);
console.log(`Shell ${version}: ${assets.length} static files. No project or API data cached.`);
