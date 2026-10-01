// Almacén local (IndexedDB). Sin servidor: los datos viven en el dispositivo.
const DB_NAME = 'obras-db';
const DB_VER = 1;
let _dbp = null;

export function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('obras')) d.createObjectStore('obras', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries')) {
        const s = d.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('obraId', 'obraId');
      }
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}

// Aviso de escritura: permite a la app programar una sincronización al cambiar datos.
let _onWrite = null;
let _pausado = 0;
export function onWrite(cb) { _onWrite = cb; }
// Pausa los avisos mientras el motor de sincronización escribe sus propios datos.
export function pausarAvisos(on) { _pausado += on ? 1 : -1; if (_pausado < 0) _pausado = 0; }
function avisarEscritura() {
  if (_pausado > 0) return;
  if (_onWrite) { try { _onWrite(); } catch (_) { /* no romper la escritura */ } }
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function getAll(store) {
  const d = await openDB();
  return reqP(d.transaction(store, 'readonly').objectStore(store).getAll());
}
export async function get(store, key) {
  const d = await openDB();
  return reqP(d.transaction(store, 'readonly').objectStore(store).get(key));
}
export async function put(store, value) {
  const d = await openDB();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).put(value);
  await txDone(t);
  avisarEscritura();
}
export async function del(store, key) {
  const d = await openDB();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  await txDone(t);
  avisarEscritura();
}
export async function clear(store) {
  const d = await openDB();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).clear();
  await txDone(t);
  avisarEscritura();
}
