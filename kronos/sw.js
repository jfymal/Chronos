// Recibe las fotos que se comparten a Kronos desde WhatsApp, Fotos, capturas…
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'POST' || !u.pathname.endsWith('/compartir')) return;
  e.respondWith((async () => {
    try {
      const fd = await e.request.formData();
      const fotos = fd.getAll('fotos').filter((f) => f && f.size);
      const cache = await caches.open('kronos-compartir');
      const items = [];
      for (let i = 0; i < fotos.length; i++) {
        const f = fotos[i];
        const id = 'c' + Date.now() + '-' + i;
        await cache.put('/__compartida__/' + id, new Response(f, {
          headers: { 'Content-Type': f.type || 'image/jpeg' },
        }));
        items.push({ id, nombre: f.name || ('foto' + (i + 1) + '.jpg') });
      }
      const destino = self.registration.scope + 'index.html?compartir=' + encodeURIComponent(JSON.stringify(items));
      return Response.redirect(destino, 303);
    } catch (err) {
      return Response.redirect(self.registration.scope + 'index.html?compartir=error', 303);
    }
  })());
});
