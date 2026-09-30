// Sincronización con Google Drive usando el modelo de token de
// Google Identity Services. Solo pide el permiso `drive.file`, es decir,
// la app únicamente ve los ficheros que ella misma crea.
import * as db from './db.js';
import { CLIENT_ID, CARPETA_DRIVE, SUBIDA_PARALELA } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FICHERO_DATOS = 'datos.json';
const SUBDIR_ARCHIVOS = 'archivos';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let token = null;
let expira = 0;
let cliente = null;
let carpetaId = null;
let archivosId = null;

export const configurado = () => !!CLIENT_ID;

/* ------------------------------- token ------------------------------- */
function cargarGIS() {
  return new Promise((res, rej) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error('No se pudo cargar Google Identity Services. ¿Hay conexión?'));
    document.head.appendChild(s);
  });
}

async function pedirToken(interactivo) {
  if (!CLIENT_ID) throw new Error('Falta el Client ID en js/config.js');
  if (token && Date.now() < expira - 60000) return token;
  await cargarGIS();
  if (!cliente) {
    cliente = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {},
    });
  }
  return new Promise((res, rej) => {
    cliente.callback = (r) => {
      if (r.error) return rej(new Error('Google: ' + r.error));
      token = r.access_token;
      expira = Date.now() + (Number(r.expires_in || 3600) * 1000);
      res(token);
    };
    try {
      cliente.requestAccessToken(interactivo ? {} : { prompt: '' });
    } catch (e) {
      rej(e);
    }
  });
}

export async function conectar() {
  await pedirToken(true);
  await asegurarCarpeta();
  return true;
}

export function desconectar() {
  token = null;
  expira = 0;
  carpetaId = null;
  archivosId = null;
}

/* ------------------------------- API ------------------------------- */
async function api(url, opts = {}, reintento = true) {
  const t = await pedirToken(false);
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
  if (r.status === 401 && reintento) {
    token = null;
    return api(url, opts, false);
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Drive ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r;
}

async function listar(q) {
  const out = [];
  let pageToken = '';
  do {
    const u = `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const j = await (await api(u)).json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function crearCarpeta(nombre, padre) {
  const r = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: [padre] }),
  });
  return (await r.json()).id;
}

async function buscarOCrearCarpeta(nombre, padre) {
  const q = `name='${nombre.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${padre}' in parents`;
  const f = await listar(q);
  return f.length ? f[0].id : crearCarpeta(nombre, padre);
}

async function asegurarCarpeta() {
  if (carpetaId) return carpetaId;
  const raiz = await listar(`name='${CARPETA_DRIVE}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  carpetaId = raiz.length ? raiz[0].id : await crearCarpeta(CARPETA_DRIVE, 'root');
  archivosId = await buscarOCrearCarpeta(SUBDIR_ARCHIVOS, carpetaId);
  return carpetaId;
}

async function subirNuevo(nombre, blob, padre) {
  const boundary = 'obras' + Math.random().toString(36).slice(2);
  const cuerpo = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: nombre, parents: [padre] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const r = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: cuerpo,
  });
  return (await r.json()).id;
}

async function reemplazar(fileId, blob) {
  await api(`${UPLOAD}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
}

async function descargar(fileId) {
  const r = await api(`${API}/files/${fileId}?alt=media`);
  return r.blob();
}

async function borrarRemoto(fileId) {
  try { await api(`${API}/files/${fileId}`, { method: 'DELETE' }); } catch (_) { /* ya no existe */ }
}

async function escribirDatos(texto) {
  const q = `name='${FICHERO_DATOS}' and trashed=false and '${carpetaId}' in parents`;
  const f = await listar(q);
  const blob = new Blob([texto], { type: 'application/json' });
  if (f.length) return reemplazar(f[0].id, blob);
  return subirNuevo(FICHERO_DATOS, blob, carpetaId);
}

async function leerDatos() {
  const q = `name='${FICHERO_DATOS}' and trashed=false and '${carpetaId}' in parents`;
  const f = await listar(q);
  if (!f.length) return null;
  try {
    const txt = await (await descargar(f[0].id)).text();
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

/* ------------------------------- mezcla ------------------------------- */
const tiempo = (x) => Date.parse(x && (x.actualizado || x.creado)) || 0;

function unir(local, remoto) {
  const m = new Map();
  for (const r of (remoto || [])) m.set(r.id, r);
  for (const r of (local || [])) {
    const prev = m.get(r.id);
    if (!prev || tiempo(r) >= tiempo(prev)) m.set(r.id, r);
  }
  return m;
}

async function anotarBorrado(id, tipo) {
  const m = (await db.get('meta', 'borrados')) || { k: 'borrados', lista: [] };
  m.lista = (m.lista || []).filter((x) => x.id !== id);
  m.lista.push({ id, tipo, actualizado: new Date().toISOString() });
  await db.put('meta', m);
  return m.lista;
}

async function aplicarBorrados(lista) {
  for (const b of lista) {
    if (b.tipo === 'obra') await db.del('obras', b.id);
    else if (b.tipo === 'entry') await db.del('entries', b.id);
  }
}

function enParalelo(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  return Promise.all(workers);
}

/* ------------------------------- sincronizar ------------------------------- */
export async function sincronizar(onProgreso = () => {}) {
  if (!CLIENT_ID) throw new Error('Falta el Client ID en js/config.js');
  await pedirToken(true);
  await asegurarCarpeta();

  onProgreso('Leyendo estado remoto…');
  const remoto = await leerDatos();

  const [obrasL, entriesL, blobsL, metaBorrados] = await Promise.all([
    db.getAll('obras'),
    db.getAll('entries'),
    db.getAll('blobs'),
    db.get('meta', 'borrados'),
  ]);
  const borradosL = (metaBorrados && metaBorrados.lista) || [];

  // --- mezclar metadatos ---
  const obrasM = unir(obrasL, remoto && remoto.obras);
  const entriesM = unir(entriesL, remoto && remoto.entries);

  // --- mezclar borrados (unión) ---
  const bMap = new Map();
  for (const b of (remoto && remoto.borrados) || []) bMap.set(b.id, b);
  for (const b of borradosL) {
    const prev = bMap.get(b.id);
    if (!prev || tiempo(b) >= tiempo(prev)) bMap.set(b.id, b);
  }
  const borradosM = [...bMap.values()];

  // --- quitar de la mezcla lo que esté borrado ---
  for (const b of borradosM) {
    const o = obrasM.get(b.id);
    if (o && tiempo(b) > tiempo(o)) obrasM.delete(b.id);
    const e = entriesM.get(b.id);
    if (e && tiempo(b) > tiempo(e)) entriesM.delete(b.id);
  }

  // --- aplicar a local ---
  onProgreso('Guardando cambios locales…');
  for (const o of obrasM.values()) await db.put('obras', o);
  for (const e of entriesM.values()) await db.put('entries', e);
  for (const b of borradosM) {
    if (b.tipo === 'obra' && !obrasM.has(b.id)) await db.del('obras', b.id);
    if (b.tipo === 'entry' && !entriesM.has(b.id)) await db.del('entries', b.id);
  }
  await db.put('meta', { k: 'borrados', lista: borradosM });

  // --- archivos (blobs) ---
  onProgreso('Revisando archivos…');
  const remotos = await listar(`'${archivosId}' in parents and trashed=false`);
  const remotoPorNombre = new Map(remotos.map((f) => [f.name, f.id]));
  const locales = new Map(blobsL.map((b) => [b.id, b]));

  const necesitaSubir = [];
  const necesitaBajar = [];
  for (const e of entriesM.values()) {
    if (!e.blobId) continue;
    if (!locales.has(e.blobId) && remotoPorNombre.has(e.blobId)) necesitaBajar.push(e.blobId);
  }
  for (const b of locales.values()) {
    if (!remotoPorNombre.has(b.id)) necesitaSubir.push(b.id);
  }

  let hechos = 0;
  const total = necesitaSubir.length + necesitaBajar.length;
  await enParalelo(necesitaSubir, SUBIDA_PARALELA, async (id) => {
    const b = locales.get(id);
    if (!b || !b.blob) return;
    try { await subirNuevo(id, b.blob, archivosId); } catch (_) { /* se reintentará */ }
    hechos++; onProgreso(`Subiendo archivos… ${hechos}/${total}`);
  });
  await enParalelo(necesitaBajar, SUBIDA_PARALELA, async (id) => {
    try {
      const blob = await descargar(remotoPorNombre.get(id));
      const ref = [...entriesM.values()].find((e) => e.blobId === id);
      await db.put('blobs', { id, blob, nombre: (ref && ref.nombre) || id, tipo: blob.type || (ref && ref.tipo) || '' });
    } catch (_) { /* se reintentará */ }
    hechos++; onProgreso(`Bajando archivos… ${hechos}/${total}`);
  });

  // --- escribir datos.json ---
  onProgreso('Guardando índice en Drive…');
  const blobsMeta = [...entriesM.values()].filter((e) => e.blobId).map((e) => ({ id: e.blobId, nombre: e.nombre || '', tipo: '' }));
  const salida = {
    app: 'obras',
    version: 1,
    generado: new Date().toISOString(),
    obras: [...obrasM.values()],
    entries: [...entriesM.values()],
    blobs: blobsMeta,
    borrados: borradosM,
  };
  await escribirDatos(JSON.stringify(salida));

  const sello = new Date().toISOString();
  await db.put('meta', { k: 'drive_ultima', valor: sello });
  return { sello, obras: obrasM.size, entries: entriesM.size, subidos: necesitaSubir.length, bajados: necesitaBajar.length };
}

export async function ultimaSync() {
  const m = await db.get('meta', 'drive_ultima');
  return m && m.valor;
}
