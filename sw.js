// Service worker: funciona sin conexión y recibe lo que compartes desde otras apps.
const CACHE = 'obras-v3';
const ASSETS = ['./', './index.html', './styles.css', './js/app.js', './js/db.js', './js/drive.js', './js/config.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const DB_NAME = 'obras-db';
const DB_VER = 1;
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('obras')) d.createObjectStore('obras', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('media').filter((f) => typeof f !== 'string');
    const text = form.get('text') || '';
    const url = form.get('url') || '';
    const title = form.get('title') || '';
    const d = await idb();
    const t = d.transaction(['inbox', 'blobs'], 'readwrite');
    const inb = t.objectStore('inbox');
    const blobs = t.objectStore('blobs');
    const creado = new Date().toISOString();
    for (const f of files) {
      const blobId = crypto.randomUUID();
      blobs.put({ id: blobId, blob: f, nombre: f.name || 'compartido', tipo: f.type });
      let tipo = 'archivo';
      if (String(f.type).startsWith('image')) tipo = 'image';
      else if (f.type === 'application/pdf') tipo = 'pdf';
      inb.put({ id: crypto.randomUUID(), tipo, blobId, nombre: f.name || 'compartido', texto: text || title || '', url, creado });
    }
    if (!files.length && (text || url)) {
      inb.put({ id: crypto.randomUUID(), tipo: 'texto', texto: text || title || '', url, creado });
    }
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch (_) { /* nunca bloquear el compartir */ }
  return Response.redirect(new URL('index.html#/inbox', self.registration.scope), 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  // Red primero (para recibir cambios), caché como respaldo sin conexión.
  e.respondWith((async () => {
    try {
      const resp = await fetch(e.request);
      if (resp && resp.ok) { const c = await caches.open(CACHE); c.put(e.request, resp.clone()); }
      return resp;
    } catch (_) {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      const fallback = await caches.match('./index.html');
      return fallback || new Response('Sin conexión', { status: 503 });
    }
  })());
});
