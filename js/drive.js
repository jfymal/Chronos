// Sincronización con Google Drive usando el modelo de token de
// Google Identity Services. Solo pide el permiso `drive.file`, es decir,
// la app únicamente ve los ficheros que ella misma crea.
//
// Estructura en Drive:
//   ObrasApp/
//     datos.json              índice de obras, entradas y borrados
//     <Nombre de obra>/       una carpeta por obra
//        Informe.pdf          documentos en la raíz de la obra
//        Fotos/
//           260408_080313.jpg fotos, con nombre legible
import * as db from './db.js';
import { CLIENT_ID, CARPETA_DRIVE, SUBIDA_PARALELA } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FICHERO_DATOS = 'datos.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MIME_CARPETA = 'application/vnd.google-apps.folder';

let token = null;
let expira = 0;
let cliente = null;
let carpetaId = null;                 // ObrasApp
const carpetasObra = new Map();       // nombre de obra -> id de carpeta

export const configurado = () => !!CLIENT_ID;

/* ------------------------------- nombres ------------------------------- */
const SIN_VALIDOS = /[\\/:*?"<>|]/g;

function limpiarNombre(s) {
  return String(s || '').replace(SIN_VALIDOS, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'sin-nombre';
}

const EXT_POR_TIPO = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf',
};

function extensionDe(tipo, nombre) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(nombre || '');
  if (m) return '.' + m[1].toLowerCase();
  return EXT_POR_TIPO[tipo] || '';
}

// "260408_080313.Foto.060440.jpg" -> "260408_080313.jpg"
function nombreLegible(entry, blob) {
  const original = entry.nombre || (blob && blob.nombre) || 'archivo';
  const ext = extensionDe((blob && blob.tipo) || '', original);
  let base = original.replace(/\.[^.]+$/, '');
  base = base.replace(/\.(foto|imagen_zona|archivo|notas)\.\d{6}$/i, '');
  return limpiarNombre(base) + ext;
}

/* ------------------------------- token ------------------------------- */
const listo = () => !!(window.google && window.google.accounts && window.google.accounts.oauth2);

async function cargarGIS() {
  if (listo()) return;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await new Promise((res, rej) => {
        const previo = document.getElementById('gis-script');
        if (previo) previo.remove();
        const s = document.createElement('script');
        s.id = 'gis-script';
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.onload = () => res();
        s.onerror = () => rej(new Error('descarga'));
        document.head.appendChild(s);
      });
      if (listo()) return;
      throw new Error('carga');
    } catch (e) {
      if (intento === 2) {
        let pista = ' Comprueba la conexión.';
        if (!navigator.onLine) pista = ' El dispositivo está SIN CONEXIÓN.';
        else pista += ' Si usas un bloqueador de anuncios o Brave, prueba a permitir accounts.google.com.';
        throw new Error('No se pudo cargar Google Identity Services.' + pista);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
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
  carpetasObra.clear();
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
    const u = `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
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
    body: JSON.stringify({ name: nombre, mimeType: MIME_CARPETA, parents: [padre] }),
  });
  return (await r.json()).id;
}

async function asegurarCarpeta() {
  if (carpetaId) return carpetaId;
  const q = `name='${CARPETA_DRIVE}' and mimeType='${MIME_CARPETA}' and trashed=false and 'root' in parents`;
  const raiz = await listar(q);
  carpetaId = raiz.length ? raiz[0].id : await crearCarpeta(CARPETA_DRIVE, 'root');
  return carpetaId;
}

// Carpeta de una obra (se crea si no existe). `sub` = subcarpeta opcional ("Fotos").
async function carpetaDeObra(nombre, sub) {
  const nombreSeguro = limpiarNombre(nombre) || 'Sin obra';
  const clave = nombreSeguro + '|' + (sub || '');
  if (carpetasObra.has(clave)) return carpetasObra.get(clave);
  await asegurarCarpeta();

  let baseId;
  const claveBase = nombreSeguro + '|';
  if (carpetasObra.has(claveBase)) {
    baseId = carpetasObra.get(claveBase);
  } else {
    const q = `name='${nombreSeguro.replace(/'/g, "\\'")}' and mimeType='${MIME_CARPETA}' and trashed=false and '${carpetaId}' in parents`;
    const f = await listar(q);
    baseId = f.length ? f[0].id : await crearCarpeta(nombreSeguro, carpetaId);
    carpetasObra.set(claveBase, baseId);
  }
  if (!sub) return baseId;

  const subSeguro = limpiarNombre(sub);
  const q2 = `name='${subSeguro}' and mimeType='${MIME_CARPETA}' and trashed=false and '${baseId}' in parents`;
  const f2 = await listar(q2);
  const subId = f2.length ? f2[0].id : await crearCarpeta(subSeguro, baseId);
  carpetasObra.set(clave, subId);
  return subId;
}

// Todos los ficheros bajo ObrasApp (un nivel de subcarpetas dentro de cada obra).
async function listarArbol() {
  const out = [];
  const nivel1 = await listar(`'${carpetaId}' in parents and mimeType='${MIME_CARPETA}' and trashed=false`);
  for (const c1 of nivel1) {
    const nivel2 = await listar(`'${c1.id}' in parents and mimeType='${MIME_CARPETA}' and trashed=false`);
    const dirs = [{ id: c1.id, ruta: c1.name }];
    for (const c2 of nivel2) dirs.push({ id: c2.id, ruta: c1.name + '/' + c2.name });
    for (const d of dirs) {
      const fs = await listar(`'${d.id}' in parents and mimeType!='${MIME_CARPETA}' and trashed=false`);
      for (const f of fs) out.push({ id: f.id, name: f.name, carpetaId: d.id, carpeta: d.ruta });
    }
  }
  return out;
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

// Renombra y/o mueve un fichero sin volver a subirlo.
async function renombrarMover(fileId, nombre, destinoId, origenId) {
  const params = new URLSearchParams();
  if (destinoId && origenId && destinoId !== origenId) {
    params.set('addParents', destinoId);
    params.set('removeParents', origenId);
  }
  params.set('fields', 'id');
  await api(`${API}/files/${fileId}?${params.toString()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nombre }),
  });
}

// Manda a la papelera de Drive (recuperable 30 días). No borra definitivamente.
async function aPapelera(fileId) {
  try {
    await api(`${API}/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    return true;
  } catch (_) {
    return false;   // se reintentará en la próxima sincronización
  }
}

async function descargar(fileId) {
  const r = await api(`${API}/files/${fileId}?alt=media`);
  return r.blob();
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

function enParalelo(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length || 1)) }, async () => {
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

  const bMap = new Map();
  for (const b of (remoto && remoto.borrados) || []) bMap.set(b.id, b);
  for (const b of borradosL) {
    const prev = bMap.get(b.id);
    if (!prev || tiempo(b) >= tiempo(prev)) bMap.set(b.id, b);
  }
  const borradosM = [...bMap.values()];

  for (const b of borradosM) {
    const o = obrasM.get(b.id);
    if (o && tiempo(b) > tiempo(o)) obrasM.delete(b.id);
    const e = entriesM.get(b.id);
    if (e && tiempo(b) > tiempo(e)) entriesM.delete(b.id);
  }

  onProgreso('Guardando cambios locales…');
  for (const o of obrasM.values()) await db.put('obras', o);
  for (const e of entriesM.values()) await db.put('entries', e);
  for (const b of borradosM) {
    if (b.tipo === 'obra' && !obrasM.has(b.id)) await db.del('obras', b.id);
    if (b.tipo === 'entry' && !entriesM.has(b.id)) {
      const local = await db.get('entries', b.id);
      if (local && local.blobId) await db.del('blobs', local.blobId);
      await db.del('entries', b.id);
    }
  }
  // --- archivos ---
  onProgreso('Revisando archivos…');
  const arbol = await listarArbol();
  const porNombre = new Map(arbol.map((f) => [f.name, f]));           // esquema antiguo: nombre == blobId
  const porId = new Map(arbol.map((f) => [f.id, f]));
  const porCarpetaYNombre = new Map(arbol.map((f) => [f.carpetaId + '|' + f.name, f]));
  const metaRemota = new Map((((remoto && remoto.blobs) || [])).map((b) => [b.id, b]));

  const locales = new Map(blobsL.map((b) => [b.id, b]));
  const ocupados = new Map();   // carpetaId -> Set(nombres en uso)

  // una entrada por blob
  const porBlob = new Map();
  for (const e of entriesM.values()) {
    if (e.blobId && !porBlob.has(e.blobId)) porBlob.set(e.blobId, e);
  }

  // obras archivadas: sus archivos no se suben ni se bajan (se guardan fuera de Drive)
  const archivadas = new Set([...obrasM.values()].filter((o) => o.archivada).map((o) => o.id));

  const subir = [];      // {blobId, nombre, carpetaId, blob}
  const bajar = [];      // {blobId, fileId, nombre, entry}
  const mover = [];      // {fileId, nombre, destinoId, origenId}
  const metaSalida = new Map(); // blobId -> {id, nombre, tipo, file}

  let revisados = 0;
  for (const [blobId, entry] of porBlob) {
    revisados++;
    if (revisados % 25 === 0) onProgreso(`Ordenando archivos… ${revisados}/${porBlob.size}`);

    // obra archivada: se deja como está, no se toca Drive
    if (archivadas.has(entry.obraId)) {
      const previo = metaRemota.get(blobId);
      if (previo) metaSalida.set(blobId, previo);
      continue;
    }

    const obra = obrasM.get(entry.obraId);
    // las fotos van a una subcarpeta "Fotos"; el resto (PDF, etc.) a la raíz de la obra
    const sub = entry.tipo === 'foto' ? 'Fotos' : null;
    const carpetaDestino = await carpetaDeObra((obra && obra.nombre) || 'Sin obra', sub);
    if (!ocupados.has(carpetaDestino)) ocupados.set(carpetaDestino, new Set());
    const nombresCarpeta = ocupados.get(carpetaDestino);

    // nombre deseado, resolviendo colisiones dentro de la carpeta
    const blob = locales.get(blobId);
    let nombre = nombreLegible(entry, blob);
    if (nombresCarpeta.has(nombre)) {
      const ext = extensionDe((blob && blob.tipo) || '', nombre);
      const base = nombre.slice(0, nombre.length - ext.length);
      let i = 2;
      while (nombresCarpeta.has(`${base} (${i})${ext}`)) i++;
      nombre = `${base} (${i})${ext}`;
    }
    nombresCarpeta.add(nombre);

    // ¿existe ya en Drive?
    let ficha = null;
    const mr = metaRemota.get(blobId);
    if (mr && mr.file && porId.has(mr.file)) ficha = porId.get(mr.file);
    if (!ficha && porNombre.has(blobId)) ficha = porNombre.get(blobId);   // esquema antiguo
    if (!ficha) {
      const candidato = porCarpetaYNombre.get(carpetaDestino + '|' + nombre);
      if (candidato) ficha = candidato;
    }

    if (blob && blob.blob) {
      if (ficha) {
        if (ficha.name !== nombre || ficha.carpetaId !== carpetaDestino) {
          mover.push({ fileId: ficha.id, nombre, destinoId: carpetaDestino, origenId: ficha.carpetaId });
        }
        metaSalida.set(blobId, { id: blobId, nombre, tipo: blob.tipo || '', file: ficha.id });
      } else {
        subir.push({ blobId, nombre, carpetaId: carpetaDestino, blob: blob.blob, tipo: blob.tipo || '' });
      }
    } else if (ficha) {
      bajar.push({ blobId, fileId: ficha.id, nombre, entry });
      metaSalida.set(blobId, { id: blobId, nombre, tipo: '', file: ficha.id });
    } else {
      metaSalida.set(blobId, { id: blobId, nombre, tipo: '', file: null });
    }
  }

  const total = subir.length + bajar.length + mover.length;
  let hechos = 0;
  const avanza = (etiqueta) => { hechos++; onProgreso(`${etiqueta} ${hechos}/${total}`); };

  if (mover.length) {
    await enParalelo(mover, SUBIDA_PARALELA, async (m) => {
      try { await renombrarMover(m.fileId, m.nombre, m.destinoId, m.origenId); } catch (_) { /* se reintentará */ }
      avanza('Reorganizando archivos…');
    });
  }
  if (subir.length) {
    await enParalelo(subir, SUBIDA_PARALELA, async (s) => {
      try {
        const id = await subirNuevo(s.nombre, s.blob, s.carpetaId);
        const m = metaSalida.get(s.blobId);
        if (m) { m.file = id; m.tipo = s.tipo; m.nombre = s.nombre; }
      } catch (_) { /* se reintentará */ }
      avanza('Subiendo archivos…');
    });
  }
  if (bajar.length) {
    await enParalelo(bajar, SUBIDA_PARALELA, async (b) => {
      try {
        const blob = await descargar(b.fileId);
        await db.put('blobs', { id: b.blobId, blob, nombre: b.nombre, tipo: blob.type || '' });
      } catch (_) { /* se reintentará */ }
      avanza('Bajando archivos…');
    });
  }

  // ficheros sueltos antiguos (en 'archivos' o con nombre = blobId) que ya no tengan blob
  for (const f of arbol) {
    if (porBlob.has(f.name)) continue;
    if (f.carpeta === 'archivos' && f.name.startsWith('b:')) {
      const entryId = f.name.slice(2);
      const entry = entriesM.get(entryId);
      if (entry) {
        const obra = obrasM.get(entry.obraId);
        const sub = entry.tipo === 'foto' ? 'Fotos' : null;
        const destino = await carpetaDeObra((obra && obra.nombre) || 'Sin obra', sub);
        const nombre = nombreLegible(entry, null);
        try { await renombrarMover(f.id, nombre, destino, f.carpetaId); } catch (_) { /* opcional */ }
      }
    }
  }

  // --- lo borrado en la app se manda a la papelera de Drive ---
  const remotoEntries = new Map(((remoto && remoto.entries) || []).map((e) => [e.id, e]));
  const remotoObras = new Map(((remoto && remoto.obras) || []).map((o) => [o.id, o]));
  const remotoBlobsMeta = new Map(((remoto && remoto.blobs) || []).map((b) => [b.id, b]));

  const pendientes = [];
  for (const b of borradosM) {
    if (b.drive) continue;                       // ya limpiado
    const ids = [];
    if (b.tipo === 'entry') {
      const e = remotoEntries.get(b.id);
      const m = e && e.blobId ? remotoBlobsMeta.get(e.blobId) : null;
      if (m && m.file) ids.push(m.file);
    } else if (b.tipo === 'obra') {
      const o = remotoObras.get(b.id);
      if (o) {
        const q = `name='${limpiarNombre(o.nombre).replace(/'/g, "\\'")}' and mimeType='${MIME_CARPETA}' and trashed=false and '${carpetaId}' in parents`;
        const fs = await listar(q);
        for (const f of fs) ids.push(f.id);      // la carpeta arrastra su contenido
      }
      for (const e of ((remoto && remoto.entries) || [])) {
        if (e.obraId === b.id && e.blobId) {
          const m = remotoBlobsMeta.get(e.blobId);
          if (m && m.file) ids.push(m.file);
        }
      }
    }
    if (ids.length) pendientes.push({ b, ids: [...new Set(ids)] });
  }

  let aPapeleraN = 0;
  if (pendientes.length) {
    const total = pendientes.reduce((n, x) => n + x.ids.length, 0);
    let hechosP = 0;
    await enParalelo(pendientes, SUBIDA_PARALELA, async (x) => {
      let ok = true;
      for (const id of x.ids) {
        if (!(await aPapelera(id))) ok = false;
        hechosP++;
        onProgreso(`Limpiando Drive… ${hechosP}/${total}`);
      }
      if (ok) { x.b.drive = true; aPapeleraN += x.ids.length; }
    });
  }

  await db.put('meta', { k: 'borrados', lista: borradosM });

  onProgreso('Guardando índice en Drive…');
  const salida = {
    app: 'obras',
    version: 2,
    generado: new Date().toISOString(),
    obras: [...obrasM.values()],
    entries: [...entriesM.values()],
    blobs: [...metaSalida.values()],
    borrados: borradosM,
  };
  await escribirDatos(JSON.stringify(salida));

  const sello = new Date().toISOString();
  await db.put('meta', { k: 'drive_ultima', valor: sello });
  return {
    sello,
    obras: obrasM.size,
    entries: entriesM.size,
    subidos: subir.length,
    bajados: bajar.length,
    movidos: mover.length,
    papelera: aPapeleraN,
  };
}

export async function ultimaSync() {
  const m = await db.get('meta', 'drive_ultima');
  return m && m.valor;
}
