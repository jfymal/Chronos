import * as db from './db.js';
import * as drive from './drive.js';
import { VERSION } from './config.js';

/* ============================ DOM ============================ */
const view = document.getElementById('view');
const pageTitle = document.getElementById('pageTitle');
const backBtn = document.getElementById('backBtn');
const fab = document.getElementById('fab');
const modalRoot = document.getElementById('modalRoot');
const searchInput = document.getElementById('searchInput');
const searchBar = document.getElementById('searchBar');
const searchBtn = document.getElementById('searchBtn');
const syncBtn = document.getElementById('syncBtn');
const menuBtn = document.getElementById('menuBtn');

/* ============================ estado ============================ */
let obras = [];
let entries = [];
let inbox = [];
let filtro = '';
let visibles = 60;
let obraActual = null;
let seleccionInbox = new Set();
let blobsRemotos = {};   // blobId -> {file, nombre, tipo} en Drive (modo bajo demanda)
const urlCache = new Map();

const AJUSTES_DEFECTO = { comprimir: true, maxDim: 1920, calidad: 0.82, autoSync: true, soloWifi: true, horaRecordatorio: '08:00', bajoDemanda: false };
let ajustes = { ...AJUSTES_DEFECTO };
async function cargarAjustes() {
  const m = await db.get('meta', 'ajustes');
  ajustes = { ...AJUSTES_DEFECTO, ...((m && m.valor) || {}) };
  return ajustes;
}
async function guardarAjustes(cambios) {
  ajustes = { ...ajustes, ...cambios };
  await db.put('meta', { k: 'ajustes', valor: ajustes });
}

// Reduce tamaño y reescala una foto antes de guardarla.
async function prepararFoto(file) {
  if (!ajustes.comprimir) return file;
  if (!file.type || !file.type.startsWith('image/') || file.type === 'image/gif') return file;
  const esPng = file.type === 'image/png';
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { try { bmp = await createImageBitmap(file); } catch (e) { return file; } }
  const max = Math.max(bmp.width, bmp.height);
  const escala = Math.min(1, (ajustes.maxDim || 1920) / max);
  if (escala >= 1 && file.size <= 1.2 * 1024 * 1024) { if (bmp.close) bmp.close(); return file; }
  const w = Math.max(1, Math.round(bmp.width * escala));
  const h = Math.max(1, Math.round(bmp.height * escala));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const salida = await new Promise((res) => c.toBlob(res, esPng ? 'image/png' : 'image/jpeg', esPng ? undefined : (ajustes.calidad || 0.82)));
  if (!salida || salida.size >= file.size) return file;
  const base = (file.name || 'foto').replace(/\.[^.]+$/, '');
  return new File([salida], base + (esPng ? '.png' : '.jpg'), { type: esPng ? 'image/png' : 'image/jpeg' });
}

/* ============================ utilidades ============================ */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iconFor = (t) => (t === 'foto' ? '📷' : t === 'pdf' ? '📎' : t === 'enlace' ? '🔗' : '💬');
function fmt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Enlace a una obra. El id puede llevar espacios u otros caracteres, así que se codifica.
const obraHash = (id) => '#/obra/' + encodeURIComponent(id);

// Orden de los grupos en la pantalla inicial.
function rangoEstado(s) {
  const k = String(s || '').toLowerCase();
  if (k.includes('curso') || k.includes('iniciad') || k.includes('activ')) return 0;
  if (k.includes('pendient')) return 1;
  if (k.includes('garant')) return 2;
  if (k.includes('paus')) return 3;
  if (k.includes('finaliz') || k.includes('cerrad') || k.includes('termin')) return 9;
  return 5;
}
function entryLabel(e) {
  if (e.tipo === 'comentario') return e.texto || 'Comentario';
  if (e.tipo === 'enlace') return e.url || 'Enlace';
  return e.nombre || (e.tipo === 'foto' ? 'Foto' : 'Documento');
}

/* ============================ datos ============================ */
async function reload() {
  obras = (await db.getAll('obras')).sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
  entries = await db.getAll('entries');
  inbox = (await db.getAll('inbox')).sort((a, b) => String(b.creado || '').localeCompare(String(a.creado || '')));
  const mb = await db.get('meta', 'drive_blobs');
  blobsRemotos = (mb && mb.valor) || {};
}

// Borra los archivos de una obra solo de este dispositivo (siguen en Drive).
async function liberarEspacioObra(obraId) {
  let n = 0;
  for (const e of entriesOf(obraId)) {
    if (!e.blobId) continue;
    const b = await db.get('blobs', e.blobId);
    if (!b) continue;
    const u = urlCache.get(e.blobId);
    if (u) { URL.revokeObjectURL(u); urlCache.delete(e.blobId); }
    await db.del('blobs', e.blobId);
    n++;
  }
  return n;
}

async function blobUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const rec = await db.get('blobs', id);
  if (!rec || !rec.blob) return null;
  const u = URL.createObjectURL(rec.blob);
  urlCache.set(id, u);
  return u;
}

function entriesOf(obraId) {
  return entries.filter((e) => e.obraId === obraId).sort((a, b) => String(b.creado || '').localeCompare(String(a.creado || '')));
}

/* ============================ modales ============================ */
function openModal(html, onMount) {
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  const bd = modalRoot.firstElementChild;
  bd.addEventListener('click', (ev) => { if (ev.target === bd) closeModal(); });
  if (onMount) onMount(bd.querySelector('.modal'));
  return bd;
}
function closeModal() { modalRoot.innerHTML = ''; }

/* ============================ obras ============================ */
function obraDialog(existing) {
  const o = existing || {};
  openModal(`
    <h2>${existing ? 'Editar obra' : 'Nueva obra'}</h2>
    <label>Nombre / dirección *<input id="f_nombre" value="${esc(o.nombre || '')}" placeholder="Ej. Reina María Cristina 25"></label>
    <label>Cliente<input id="f_cliente" value="${esc(o.cliente || '')}" placeholder="Particular / promotor"></label>
    <label>Dirección<input id="f_direccion" value="${esc(o.direccion || '')}" placeholder="Calle, número, municipio"></label>
    <label>Estado
      <select id="f_estado">
        ${['En curso', 'Pendiente', 'Finalizada', 'Pausada'].map((s) => `<option ${o.estado === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </label>
    <label>Notas<textarea id="f_notas" placeholder="Detalles, teléfonos, observaciones…">${esc(o.notas || '')}</textarea></label>
    ${existing ? `<div class="archbox">
      <label class="checkline"><input type="checkbox" id="f_arch" ${o.archivada ? 'checked' : ''}> <span>Obra <b>archivada</b> — sus archivos no se sincronizan con Drive</span></label>
      <p class="hint">Úsalo cuando termines la obra y quieras guardar las fotos fuera de Drive para liberar espacio. <b>Guarda primero el cambio</b> y, al reabrir esta ventana, aparecerán los botones para liberar espacio. Al desmarcarlo y devolver la carpeta a Drive, todo vuelve a su sitio.</p>
      ${o.archivada ? `<button class="btn" id="f_liberar" type="button">Liberar espacio en este dispositivo</button>
        <button class="btn" id="f_drive" type="button">Enviar la carpeta de Drive a la papelera</button>` : ''}
    </div>` : ''}
    <div class="modalactions">
      ${existing ? '<button class="btn danger" id="f_del">Borrar obra</button>' : ''}
      <button class="btn" id="f_cancel">Cancelar</button>
      <button class="btn primary" id="f_save">Guardar</button>
    </div>`, (m) => {
    m.querySelector('#f_cancel').onclick = closeModal;
    m.querySelector('#f_save').onclick = async () => {
      const nombre = m.querySelector('#f_nombre').value.trim();
      if (!nombre) { alert('Pon un nombre a la obra.'); return; }
      const chk = m.querySelector('#f_arch');
      // Al desarchivar, forzamos un escaneo de Drive para reencontrar los archivos
      if (chk && existing && existing.archivada && !chk.checked) {
        await db.put('meta', { k: 'forzar_escaneo', valor: Date.now() });
      }
      const data = {
        nombre,
        cliente: m.querySelector('#f_cliente').value.trim(),
        direccion: m.querySelector('#f_direccion').value.trim(),
        estado: m.querySelector('#f_estado').value,
        notas: m.querySelector('#f_notas').value.trim(),
        archivada: chk ? chk.checked : false,
      };
      if (existing) {
        await db.put('obras', { ...existing, ...data, actualizado: new Date().toISOString() });
      } else {
        await db.put('obras', { id: uid(), ...data, creado: new Date().toISOString(), actualizado: new Date().toISOString() });
      }
      await reload(); closeModal(); route();
    };
    const lib = m.querySelector('#f_liberar');
    if (lib) lib.onclick = async () => {
      if (!confirm('Se borrarán las fotos y PDFs de esta obra SOLO de este dispositivo.\n\nAsegúrate de tenerlos guardados fuera de Drive antes de continuar.\n\n¿Continuar?')) return;
      const n = await liberarEspacioObra(existing.id);
      alert(`Liberados ${n} archivo(s) de este dispositivo.\n\nSiguen guardados en Drive y puedes volver a bajarlos cuando quieras.`);
    };
    const fuera = m.querySelector('#f_drive');
    if (fuera) fuera.onclick = async () => {
      if (!confirm('Se moverá la carpeta de esta obra en Drive a la PAPELERA de Drive.\n\nAntes asegúrate de haberla descargado si quieres conservarla.\n\nPodrás recuperarla desde Drive durante 30 días.\n\n¿Continuar?')) return;
      try {
        const n = await drive.mandarCarpetaAPapelera(existing.nombre);
        alert(n
          ? 'Hecho. La carpeta está en la papelera de Drive (recuperable 30 días).'
          : 'No encontré la carpeta en Drive. Puede que ya la hubieras quitado.');
      } catch (err) {
        alert('No se pudo mover:\n\n' + err.message);
      }
    };
    const del = m.querySelector('#f_del');
    if (del) del.onclick = async () => {
      if (!confirm('¿Borrar la obra y todo su contenido?')) return;
      for (const e of entriesOf(existing.id)) {
        if (e.blobId) await db.del('blobs', e.blobId);
        await db.del('entries', e.id);
        await marcarBorrado(e.id, 'entry');
      }
      await db.del('obras', existing.id);
      await marcarBorrado(existing.id, 'obra');
      await reload(); closeModal(); location.hash = '#/';
    };
  });
}

/* ============================ añadir entradas ============================ */
function pickFiles(accept, capture, cb) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = accept;
  if (capture) inp.capture = capture;
  inp.multiple = accept.startsWith('image');
  inp.onchange = () => { const fs = [...inp.files]; if (fs.length) cb(fs); };
  inp.click();
}

function entryMenu(obraId) {
  openModal(`
    <h2>Añadir a la obra</h2>
    <div class="menu-list">
      <button data-k="camara">📷 Hacer foto (cámara)</button>
      <button data-k="galeria">🖼️ Añadir fotos (galería / PC)</button>
      <button data-k="lienzo">✏️ Dibujar / anotar (stylus)</button>
      <button data-k="comentario">💬 Comentario</button>
      <button data-k="pdf">📎 Añadir PDF</button>
      <button data-k="enlace">🔗 Añadir enlace (URL)</button>
    </div>`, (m) => {
    m.querySelectorAll('.menu-list button').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.k;
        closeModal();
        if (k === 'camara') pickFiles('image/*', 'environment', (fs) => addFiles(obraId, fs, 'foto'));
        if (k === 'galeria') pickFiles('image/*', null, (fs) => addFiles(obraId, fs, 'foto'));
        if (k === 'lienzo') openEditor(obraId, null);
        if (k === 'pdf') pickFiles('application/pdf', null, (fs) => addFiles(obraId, fs, 'pdf'));
        if (k === 'comentario') commentDialog(obraId);
        if (k === 'enlace') linkDialog(obraId);
      };
    });
  });
}

async function addFiles(obraId, files, tipo) {
  for (const f0 of files) {
    const f = tipo === 'foto' ? await prepararFoto(f0) : f0;
    const blobId = uid();
    await db.put('blobs', { id: blobId, blob: f, nombre: f.name || (tipo === 'foto' ? 'foto.jpg' : 'documento.pdf'), tipo: f.type });
    await db.put('entries', {
      id: uid(), obraId, tipo, blobId,
      nombre: f.name || (tipo === 'foto' ? 'foto.jpg' : 'documento.pdf'),
      texto: '', creado: new Date().toISOString(),
      recordatorio: null, notificado: false, completado: false,
    });
  }
  await reload(); route();
}

function commentDialog(obraId) {
  openModal(`
    <h2>Nuevo comentario</h2>
    <label>Comentario<textarea id="c_texto" placeholder="¿Qué has visto en la obra?"></textarea></label>
    <label>Recordatorio (opcional)<input type="datetime-local" id="c_rem"></label>
    <div class="modalactions">
      <button class="btn" id="c_cancel">Cancelar</button>
      <button class="btn primary" id="c_save">Guardar</button>
    </div>`, (m) => {
    m.querySelector('#c_cancel').onclick = closeModal;
    m.querySelector('#c_save').onclick = async () => {
      const texto = m.querySelector('#c_texto').value.trim();
      if (!texto) { alert('Escribe un comentario.'); return; }
      const rem = m.querySelector('#c_rem').value;
      await db.put('entries', {
        id: uid(), obraId, tipo: 'comentario', texto, creado: new Date().toISOString(),
        recordatorio: rem ? new Date(rem).toISOString() : null, notificado: false, completado: false,
      });
      await reload(); closeModal(); route();
    };
  });
}

function linkDialog(obraId) {
  openModal(`
    <h2>Añadir enlace</h2>
    <label>URL<input id="l_url" type="url" placeholder="https://…"></label>
    <label>Descripción (opcional)<input id="l_txt" placeholder="Qué es este enlace"></label>
    <label>Recordatorio (opcional)<input type="datetime-local" id="l_rem"></label>
    <div class="modalactions">
      <button class="btn" id="l_cancel">Cancelar</button>
      <button class="btn primary" id="l_save">Guardar</button>
    </div>`, (m) => {
    m.querySelector('#l_cancel').onclick = closeModal;
    m.querySelector('#l_save').onclick = async () => {
      let url = m.querySelector('#l_url').value.trim();
      if (!url) { alert('Escribe una URL.'); return; }
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const rem = m.querySelector('#l_rem').value;
      await db.put('entries', {
        id: uid(), obraId, tipo: 'enlace', url, texto: m.querySelector('#l_txt').value.trim(),
        creado: new Date().toISOString(),
        recordatorio: rem ? new Date(rem).toISOString() : null, notificado: false, completado: false,
      });
      await reload(); closeModal(); route();
    };
  });
}

/* ---------------------- calendario ---------------------- */
const DIAS_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const HORA_DEFECTO = '08:00';

const claveDia = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function fechaDeClave(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function textoFecha(d) {
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// marcas: Map('YYYY-MM-DD' -> {n, overdue, hecho})  |  seleccion: Date
function htmlCalendario(mes, marcas, seleccion) {
  const y = mes.getFullYear();
  const mo = mes.getMonth();
  const offset = (new Date(y, mo, 1).getDay() + 6) % 7; // lunes = 0
  const dias = new Date(y, mo + 1, 0).getDate();
  const hoy = new Date();
  let h = `<div class="cal-top">
    <button class="iconbtn" type="button" data-mes="-1" aria-label="Mes anterior">&#8249;</button>
    <b>${MESES[mo]} ${y}</b>
    <button class="iconbtn" type="button" data-mes="1" aria-label="Mes siguiente">&#8250;</button>
  </div><div class="cal-grid">`;
  for (const d of DIAS_SEMANA) h += `<div class="cal-dow">${d}</div>`;
  for (let i = 0; i < offset; i++) h += '<div></div>';
  for (let d = 1; d <= dias; d++) {
    const f = new Date(y, mo, d);
    const k = claveDia(f);
    const m = marcas && marcas.get ? marcas.get(k) : null;
    const cls = ['cal-day'];
    if (seleccion && claveDia(seleccion) === k) cls.push('sel');
    if (claveDia(hoy) === k) cls.push('hoy');
    if (m) cls.push(m.overdue && !m.hecho ? 'con-over' : 'con');
    h += `<button type="button" class="${cls.join(' ')}" data-dia="${k}">${d}${m && m.n > 1 ? `<span class="cal-dot">${m.n}</span>` : (m ? '<span class="cal-dot">•</span>' : '')}</button>`;
  }
  h += '</div>';
  return h;
}

function reminderDialog(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  let sel = e.recordatorio ? new Date(e.recordatorio) : null;
  let hora = sel ? `${pad(sel.getHours())}:${pad(sel.getMinutes())}` : (ajustes.horaRecordatorio || HORA_DEFECTO);
  let mes = sel ? new Date(sel) : new Date();
  if (!sel) mes.setDate(mes.getDate() + 1); // por defecto, mañana

  openModal(`
    <h2>Recordatorio</h2>
    <p class="hint">${esc(String(entryLabel(e)).slice(0, 100))}</p>
    <div id="r_cal"></div>
    <div id="r_resumen" class="resumen"></div>
    <label>Hora <input type="time" id="r_hora" value="${hora}"></label>
    <div class="rowbtns">
      <button class="btn" type="button" data-quick="1">Mañana</button>
      <button class="btn" type="button" data-quick="3">En 3 días</button>
      <button class="btn" type="button" data-quick="7">En 1 semana</button>
    </div>
    <div class="modalactions">
      <button class="btn" id="r_clear">Quitar</button>
      <button class="btn" id="r_cancel">Cancelar</button>
      <button class="btn primary" id="r_save">Guardar</button>
    </div>`, (m) => {
    const cont = m.querySelector('#r_cal');
    const resumen = m.querySelector('#r_resumen');
    const horaInp = m.querySelector('#r_hora');
    const pintar = () => {
      cont.innerHTML = htmlCalendario(mes, null, sel);
      cont.querySelectorAll('[data-mes]').forEach((b) => {
        b.onclick = () => { mes = new Date(mes.getFullYear(), mes.getMonth() + Number(b.dataset.mes), 1); pintar(); };
      });
      cont.querySelectorAll('[data-dia]').forEach((b) => {
        b.onclick = () => { sel = fechaDeClave(b.dataset.dia); pintar(); };
      });
      resumen.innerHTML = sel
        ? `📅 <b>${textoFecha(sel)}</b> a las ${esc(horaInp.value || HORA_DEFECTO)}`
        : 'Elige un día en el calendario';
    };
    horaInp.oninput = pintar;
    pintar();
    m.querySelectorAll('[data-quick]').forEach((b) => {
      b.onclick = () => {
        const f = new Date();
        f.setDate(f.getDate() + Number(b.dataset.quick));
        f.setHours(8, 0, 0, 0);
        sel = f; mes = new Date(f); horaInp.value = HORA_DEFECTO; pintar();
      };
    });
    m.querySelector('#r_cancel').onclick = closeModal;
    m.querySelector('#r_clear').onclick = async () => {
      e.recordatorio = null; e.notificado = false; e.actualizado = new Date().toISOString();
      await db.put('entries', e); await reload(); closeModal(); route();
    };
    m.querySelector('#r_save').onclick = async () => {
      if (!sel) { alert('Elige un día en el calendario.'); return; }
      const [hh, mm] = String(horaInp.value || HORA_DEFECTO).split(':').map(Number);
      const f = new Date(sel);
      f.setHours(hh || 0, mm || 0, 0, 0);
      e.recordatorio = f.toISOString();
      e.notificado = false;
      e.actualizado = new Date().toISOString();
      await guardarAjustes({ horaRecordatorio: horaInp.value || HORA_DEFECTO });
      await db.put('entries', e); await reload(); closeModal(); route();
    };
  });
}

/* ============================ vistas ============================ */
function setActiveTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.nav === name));
}

async function renderObras() {
  pageTitle.textContent = 'Chronos';
  backBtn.hidden = true;
  fab.hidden = false;
  fab.onclick = () => obraDialog();
  setActiveTab('#/');

  if (!obras.length) {
    view.innerHTML = `<div class="empty">
      <h2>Sin obras todavía</h2>
      <p>Crea tu primera obra para empezar a añadir fotos, comentarios, PDFs, enlaces y recordatorios.</p>
      <button class="btn primary" id="emptyNew">Nueva obra</button>
    </div>`;
    view.querySelector('#emptyNew').onclick = () => obraDialog();
    return;
  }

  const q = filtro.trim().toLowerCase();
  let list = obras;
  if (q) {
    list = obras.filter((o) => {
      const es = entriesOf(o.id).map((e) => entryLabel(e) + ' ' + (e.zona || '') + ' ' + (e.estado || '')).join(' ');
      return (o.nombre + ' ' + (o.cliente || '') + ' ' + (o.direccion || '') + ' ' + es).toLowerCase().includes(q);
    });
  }

  const cardHtml = async (o) => {
    const es = entriesOf(o.id);
    const fotos = es.filter((e) => e.tipo === 'foto');
    const pend = es.filter((e) => e.recordatorio && !e.completado).length;
    const thumb = fotos.length ? await blobUrl(fotos[0].blobId) : null;
    return `<a class="card" href="${obraHash(o.id)}">
      <div class="thumb" style="${thumb ? `background-image:url('${thumb}')` : ''}">${thumb ? '' : '🏗️'}</div>
      <div class="cardbody">
        <div class="cardtitle">${esc(o.nombre)}</div>
        <div class="cardsub">${esc(o.cliente || o.direccion || '')}</div>
        <div class="cardmeta">${fotos.length} foto${fotos.length === 1 ? '' : 's'} · ${es.length} entrada${es.length === 1 ? '' : 's'}${pend ? ` · <b class="warn">${pend} pendiente${pend > 1 ? 's' : ''}</b>` : ''}</div>
      </div>
      <div class="chev">›</div>
    </a>`;
  };

  // Agrupar por estado: primero las activas, al final las demás.
  const grupos = new Map();
  for (const o of list) {
    const k = (o.estado || '').trim() || 'Sin estado';
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(o);
  }
  const orden = [...grupos.keys()].sort((a, b) => (rangoEstado(a) - rangoEstado(b)) || a.localeCompare(b, 'es'));

  const secciones = [];
  for (const k of orden) {
    const items = grupos.get(k);
    const cards = (await Promise.all(items.map(cardHtml))).join('');
    const pend = items.reduce((n, o) => n + entriesOf(o.id).filter((e) => e.recordatorio && !e.completado).length, 0);
    secciones.push(`<section class="grupo">
      <h2 class="grupo-titulo">${esc(k)} <span class="grupo-n">${items.length}</span>${pend ? `<span class="grupo-pend">${pend} pendiente${pend > 1 ? 's' : ''}</span>` : ''}</h2>
      <div class="cards">${cards}</div>
    </section>`);
  }

  view.innerHTML = list.length ? secciones.join('') : `<div class="empty"><p>Nada coincide con “${esc(filtro)}”.</p></div>`;
}

async function entryHtml(e) {
  let body = '';
  const obraDe = obras.find((x) => x.id === e.obraId);
  const sinArchivo = obraDe && obraDe.archivada
    ? '<em>📦 Archivada — este archivo no está en el dispositivo</em>'
    : '<em>Archivo no disponible en este dispositivo</em>';
  const enDrive = e.blobId && blobsRemotos[e.blobId]
    ? `<div class="pendiente">☁️ Está en tu Drive · <button class="minibtn" data-act="bajar" data-id="${e.id}">descargar</button></div>`
    : '';
  if (e.tipo === 'foto') {
    const u = await blobUrl(e.blobId);
    body = u ? `<img class="entryimg" src="${u}" alt="" loading="lazy">` : (enDrive || sinArchivo);
  } else if (e.tipo === 'pdf') {
    const u = await blobUrl(e.blobId);
    const nom = e.nombre || 'documento.pdf';
    body = u
      ? `<div class="pdfrow">
           <a class="filelink" href="${u}" target="_blank" rel="noopener">📎 ${esc(nom)}</a>
           <button class="minibtn" data-act="ver-pdf" data-id="${e.id}">ver aquí</button>
           <a class="minibtn" href="${u}" download="${esc(nom)}">descargar</a>
         </div>
         <div class="pdfbox" id="pdf_${e.id}" hidden></div>`
      : (enDrive || sinArchivo);
  } else if (e.tipo === 'enlace') {
    body = `<a class="filelink" href="${esc(e.url)}" target="_blank" rel="noopener">🔗 ${esc(e.url)}</a>`;
  } else {
    body = `<div class="comment">${esc(e.texto)}</div>`;
  }
  const remPill = e.recordatorio
    ? `<span class="pill ${e.completado ? 'done' : (new Date(e.recordatorio).getTime() < Date.now() ? 'over' : '')}">⏰ ${fmt(e.recordatorio)}</span>`
    : '';
  const chips = `${e.zona ? `<span class="chip">${esc(e.zona)}</span>` : ''}${e.estado ? `<span class="chip">${esc(e.estado)}</span>` : ''}`;
  const caption = (e.tipo !== 'comentario' && e.texto) ? `<div class="comment" style="margin-bottom:6px">${esc(e.texto)}</div>` : '';
  return `<article class="entry">
    <div class="entrybody">
      ${caption}${body}
      <div class="entrymeta">
        <span>${iconFor(e.tipo)} ${fmt(e.creado)}</span>${chips}${remPill}
        ${e.tipo === 'foto' ? `<button class="minibtn" data-act="anotar" data-id="${e.id}">anotar</button>` : ''}
        <button class="minibtn" data-act="recordatorio" data-id="${e.id}">${e.recordatorio ? 'editar recordatorio' : 'poner recordatorio'}</button>
        <button class="minibtn danger" data-act="del" data-id="${e.id}">borrar</button>
      </div>
    </div>
  </article>`;
}

async function renderObra(id) {
  const o = obras.find((x) => x.id === id);
  if (!o) { location.hash = '#/'; return; }
  pageTitle.textContent = o.nombre;
  backBtn.hidden = false;
  fab.hidden = true;               // en la obra se usa la barra inferior
  setActiveTab('');

  const es = entriesOf(id);
  if (obraActual !== id) { obraActual = id; visibles = 60; }
  const mostradas = es.slice(0, visibles);
  const blocks = await Promise.all(mostradas.map((e) => entryHtml(e)));
  view.innerHTML = `
    <section class="obrahead">
      <h2>${esc(o.nombre)}</h2>
      <div class="meta">
        ${o.estado ? `<span class="chip">${esc(o.estado)}</span>` : ''}${o.archivada ? '<span class="chip">📦 Archivada</span>' : ''}
        ${o.cliente ? esc(o.cliente) + ' · ' : ''}${esc(o.direccion || '')}
      </div>
      ${o.notas ? `<div class="notas">${esc(o.notas)}</div>` : ''}
      <div class="rowbtns">
        <button class="btn" id="b_edit">Editar</button>
        <button class="btn" id="b_share">Compartir resumen</button>
      </div>
    </section>
    ${es.length ? `<div class="entries">${blocks.join('')}</div>` : `<div class="empty"><p>Aún no hay nada en esta obra. Usa <b>📷 Foto</b> o <b>💬 Comentario</b> aquí abajo.</p></div>`}
    ${es.length > visibles ? `<div style="text-align:center;margin-top:14px"><button class="btn" id="b_more">Mostrar más (${es.length - visibles} restantes)</button></div>` : ''}
    <div class="obrabar">
      <button class="btn primary" id="ob_foto">📷 Foto</button>
      <button class="btn" id="ob_com">💬 Comentario</button>
      <button class="btn mas" id="ob_mas" aria-label="Más opciones">＋</button>
    </div>
    <div style="height:62px"></div>
  `;
  view.querySelector('#ob_foto').onclick = () => pickFiles('image/*', 'environment', (fs) => addFiles(id, fs, 'foto'));
  view.querySelector('#ob_com').onclick = () => commentDialog(id);
  view.querySelector('#ob_mas').onclick = () => entryMenu(id);
  view.querySelector('#b_edit').onclick = () => obraDialog(o);
  view.querySelector('#b_share').onclick = () => shareResumen(o);
  const more = view.querySelector('#b_more');
  if (more) more.onclick = () => { visibles += 120; renderObra(id); };
}

let calMes = new Date();
let calDiaSel = null;

async function renderRecordatorios() {
  pageTitle.textContent = 'Recordatorios';
  backBtn.hidden = true;
  fab.hidden = true;
  setActiveTab('#/recordatorios');

  const list = entries.filter((e) => e.recordatorio);
  if (!list.length) {
    view.innerHTML = `<div class="empty"><h2>Sin recordatorios</h2><p>Pon un recordatorio a cualquier foto, comentario, PDF o enlace desde su obra y aparecerá aquí.</p></div>`;
    return;
  }

  // marcas del calendario
  const now = Date.now();
  const marcas = new Map();
  for (const e of list) {
    const k = claveDia(new Date(e.recordatorio));
    const m = marcas.get(k) || { n: 0, overdue: false, hecho: true };
    m.n++;
    if (!e.completado) {
      m.hecho = false;
      if (new Date(e.recordatorio).getTime() < now) m.overdue = true;
    }
    marcas.set(k, m);
  }

  let filtradas = [...list].sort((a, b) => String(a.recordatorio).localeCompare(String(b.recordatorio)));
  if (calDiaSel) filtradas = filtradas.filter((e) => claveDia(new Date(e.recordatorio)) === calDiaSel);

  const rows = filtradas.map((e) => {
    const o = obras.find((x) => x.id === e.obraId);
    const over = !e.completado && new Date(e.recordatorio).getTime() < now;
    return `<div class="rem ${e.completado ? 'done' : (over ? 'over' : '')}">
      <div class="remico">${iconFor(e.tipo)}</div>
      <div class="rembody" data-goto="${obraHash(e.obraId)}" style="cursor:pointer">
        <div class="remtitle">${esc(String(entryLabel(e)).slice(0, 80))}</div>
        <div class="remsub">${esc(o ? o.nombre : '')} · ${fmt(e.recordatorio)}</div>
      </div>
      <button class="minibtn" data-act="toggle-done" data-id="${e.id}">${e.completado ? 'Reabrir' : 'Hecho'}</button>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="cal-wrap">${htmlCalendario(calMes, marcas, calDiaSel ? fechaDeClave(calDiaSel) : null)}</div>
    ${calDiaSel ? `<div class="calselec"><b>${textoFecha(fechaDeClave(calDiaSel))}</b><div class="spacer"></div><button class="minibtn" id="cal_todos">ver todos</button></div>` : ''}
    <div class="rems">${rows || '<div class="hint" style="padding:12px">Ningún recordatorio este día.</div>'}</div>
    <p class="hint" style="margin-top:16px">Los días con recordatorio salen marcados; en rojo, los que ya han vencido. Toca un día para ver solo los suyos.</p>`;

  const cont = view.querySelector('.cal-wrap');
  cont.querySelectorAll('[data-mes]').forEach((b) => {
    b.onclick = () => { calMes = new Date(calMes.getFullYear(), calMes.getMonth() + Number(b.dataset.mes), 1); renderRecordatorios(); };
  });
  cont.querySelectorAll('[data-dia]').forEach((b) => {
    b.onclick = () => { calDiaSel = (calDiaSel === b.dataset.dia) ? null : b.dataset.dia; renderRecordatorios(); };
  });
  const todos = view.querySelector('#cal_todos');
  if (todos) todos.onclick = () => { calDiaSel = null; renderRecordatorios(); };
}

// selector de obra con buscador
function elegirObra(onPick) {
  openModal(`
    <h2>Asignar a una obra</h2>
    <input id="eo_buscar" type="search" placeholder="Buscar obra…" autocomplete="off">
    <div id="eo_lista" class="menu-list" style="max-height:52vh;overflow:auto;margin-top:10px"></div>
    <div class="modalactions"><button class="btn" id="eo_cancel">Cancelar</button></div>`, (m) => {
    const lista = m.querySelector('#eo_lista');
    const input = m.querySelector('#eo_buscar');
    const pintar = () => {
      const q = input.value.trim().toLowerCase();
      const f = obras.filter((o) => (o.nombre + ' ' + (o.cliente || '') + ' ' + (o.direccion || '')).toLowerCase().includes(q));
      lista.innerHTML = f.length
        ? f.map((o) => `<button data-obra="${esc(o.id)}">${esc(o.nombre)}${o.estado ? ` <span class="hint">${esc(o.estado)}</span>` : ''}</button>`).join('')
        : '<div class="hint" style="padding:12px">Sin coincidencias</div>';
      lista.querySelectorAll('[data-obra]').forEach((b) => {
        b.onclick = () => { closeModal(); onPick(b.dataset.obra); };
      });
    };
    input.oninput = pintar;
    pintar();
    input.focus();
    m.querySelector('#eo_cancel').onclick = closeModal;
  });
}

async function asignarInboxA(obraId) {
  let n = 0;
  for (const id of [...seleccionInbox]) {
    const it = inbox.find((x) => x.id === id);
    if (!it) continue;
    await db.put('entries', {
      id: uid(), obraId,
      tipo: it.tipo && String(it.tipo).startsWith('image') ? 'foto' : (it.blobId ? 'pdf' : (it.url && !it.texto ? 'enlace' : 'comentario')),
      blobId: it.blobId, nombre: it.nombre, url: it.url, texto: it.texto || '',
      creado: it.creado || new Date().toISOString(),
      recordatorio: null, notificado: false, completado: false,
    });
    await db.del('inbox', it.id);
    n++;
  }
  seleccionInbox.clear();
  await reload();
  if (n) location.hash = obraHash(obraId);
  else route();
}

function barraInbox() {
  const bar = document.getElementById('ib_bar');
  const cnt = document.getElementById('ib_count');
  if (!bar) return;
  bar.hidden = seleccionInbox.size === 0;
  if (cnt) cnt.textContent = seleccionInbox.size;
  const todo = document.getElementById('ib_todo');
  if (todo) todo.textContent = (seleccionInbox.size === inbox.length && inbox.length) ? 'Quitar selección' : 'Seleccionar todo';
}

async function renderInbox() {
  pageTitle.textContent = 'Recibidos';
  backBtn.hidden = true;
  fab.hidden = true;
  setActiveTab('#/inbox');

  // descartar selecciones de elementos que ya no existen
  seleccionInbox = new Set([...seleccionInbox].filter((id) => inbox.some((x) => x.id === id)));

  if (!inbox.length) {
    view.innerHTML = `<div class="empty"><h2>Nada recibido</h2><p>Cuando compartas una foto o un enlace desde WhatsApp u otra app, llegará aquí para asignarlo a una obra.</p><p class="hint">En Android, instala la app y usa “Compartir → Chronos”.</p></div>`;
    return;
  }

  const rows = (await Promise.all(inbox.map(async (it) => {
    let body = '';
    if (it.blobId) {
      const u = await blobUrl(it.blobId);
      body = u && String(it.tipo).startsWith('image')
        ? `<img class="entryimg" src="${u}" alt="">`
        : (u ? `<a class="filelink" href="${u}" target="_blank" rel="noopener">📎 ${esc(it.nombre || 'archivo')}</a>` : '');
    } else if (it.url) {
      body = `<div class="comment"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.url)}</a></div>`;
    }
    if (it.texto) body += `<div class="comment">${esc(it.texto)}</div>`;
    return `<label class="entry inboxitem">
      <input type="checkbox" data-sel="${esc(it.id)}" ${seleccionInbox.has(it.id) ? 'checked' : ''}>
      <div class="entrybody">
        ${body}
        <div class="entrymeta"><span>${fmt(it.creado)}</span></div>
      </div>
    </label>`;
  }))).join('');

  view.innerHTML = `
    <div class="inboxhead"><button class="btn" id="ib_todo">Seleccionar todo</button></div>
    <div class="entries">${rows}</div>
    <div class="inboxbar" id="ib_bar" hidden>
      <span><b id="ib_count">0</b> seleccionada(s)</span>
      <div class="spacer"></div>
      <button class="btn primary" id="ib_asignar">Asignar a…</button>
      <button class="btn danger" id="ib_descartar">Descartar</button>
    </div>`;

  document.getElementById('ib_todo').onclick = () => {
    if (seleccionInbox.size === inbox.length) seleccionInbox.clear();
    else seleccionInbox = new Set(inbox.map((x) => x.id));
    renderInbox();
  };
  document.getElementById('ib_asignar').onclick = () => elegirObra((obraId) => asignarInboxA(obraId));
  document.getElementById('ib_descartar').onclick = async () => {
    if (!confirm(`¿Descartar ${seleccionInbox.size} elemento(s) sin asignar?`)) return;
    for (const id of [...seleccionInbox]) {
      const it = inbox.find((x) => x.id === id);
      if (!it) continue;
      if (it.blobId) await db.del('blobs', it.blobId);
      await db.del('inbox', it.id);
    }
    seleccionInbox.clear();
    await reload();
    route();
  };
  barraInbox();
}

/* ============================ compartir resumen ============================ */
async function shareResumen(o) {
  const es = entriesOf(o.id);
  const lineas = es.map((e) => `• [${e.tipo}] ${entryLabel(e)}${e.recordatorio ? ' (⏰ ' + fmt(e.recordatorio) + ')' : ''}`);
  const texto = `Obra: ${o.nombre}\n${o.cliente ? 'Cliente: ' + o.cliente + '\n' : ''}${o.direccion ? 'Dirección: ' + o.direccion + '\n' : ''}\n${lineas.join('\n')}`;
  if (navigator.share) {
    try { await navigator.share({ title: o.nombre, text: texto }); return; } catch (_) { /* cancelado */ }
  } else {
    await navigator.clipboard.writeText(texto);
    alert('Resumen copiado al portapapeles.');
  }
}

/* ============================ editor de dibujo ============================ */
const COLORES = ['#e11d48', '#2563eb', '#111827', '#f59e0b', '#16a34a', '#ffffff'];
const GROSORES = [2, 4, 8, 16];
const NOMBRE_GROSOR = ['fino', 'medio', 'grueso', 'muy grueso'];

function blobToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    const u = URL.createObjectURL(blob);
    img.onload = () => res({ img, url: u });
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagen ilegible')); };
    img.src = u;
  });
}

async function openEditor(obraId, baseEntry) {
  let base = null, baseUrl = null;
  if (baseEntry && baseEntry.blobId) {
    const rec = await db.get('blobs', baseEntry.blobId);
    if (rec && rec.blob) {
      try { const r = await blobToImage(rec.blob); base = r.img; baseUrl = r.url; } catch (_) { /* seguimos en blanco */ }
    }
  }

  const MAX = ajustes.comprimir ? (ajustes.maxDim || 1920) : 2400;
  let W, H;
  if (base) {
    const s = Math.min(1, MAX / Math.max(base.width, base.height));
    W = Math.max(1, Math.round(base.width * s));
    H = Math.max(1, Math.round(base.height * s));
  } else if (window.innerHeight > window.innerWidth) { W = 1240; H = 1754; }
  else { W = 1754; H = 1240; }

  const ov = document.createElement('div');
  ov.className = 'editor';
  ov.innerHTML = `
    <div class="ed-top">
      <button class="btn" id="ed-cancel">Cancelar</button>
      <span class="ed-title">${base ? 'Anotar foto' : 'Lienzo en blanco'}</span>
      <button class="btn primary" id="ed-save">Guardar</button>
    </div>
    <div class="ed-tools">
      ${COLORES.map((c, i) => `<span class="swatch ${i === 0 ? 'active' : ''}" data-color="${c}" style="background:${c}"></span>`).join('')}
      <span class="ed-sep"></span>
      ${GROSORES.map((g, i) => `<button class="minibtn ${i === 1 ? 'on' : ''}" data-grosor="${g}">${NOMBRE_GROSOR[i]}</button>`).join('')}
      <span class="ed-sep"></span>
      <button class="minibtn" id="ed-erase">🧽 borrador</button>
      <button class="minibtn" id="ed-undo">↶ deshacer</button>
      <button class="minibtn danger" id="ed-clear">borrar todo</button>
    </div>
    <div class="ed-canvas-wrap"><canvas id="ed-canvas" width="${W}" height="${H}"></canvas></div>`;
  document.body.appendChild(ov);
  document.body.classList.add('editing');

  const canvas = ov.querySelector('#ed-canvas');
  const ctx = canvas.getContext('2d');
  let color = COLORES[0], grosor = GROSORES[1], erase = false;
  let strokes = [], cur = null, drawing = false;
  const activePen = new Set();

  function paintBase() {
    ctx.clearRect(0, 0, W, H);
    if (base) ctx.drawImage(base, 0, 0, W, H);
    else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
  }
  function drawDot(p, c) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.6, p.w / 2), 0, Math.PI * 2);
    ctx.fill();
  }
  function drawSeg(a, b, c) {
    ctx.strokeStyle = c;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.6, (a.w + b.w) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  function redraw() {
    paintBase();
    for (const s of strokes) {
      if (s.points.length === 1) drawDot(s.points[0], s.c);
      for (let i = 1; i < s.points.length; i++) drawSeg(s.points[i - 1], s.points[i], s.c);
    }
  }
  function toCanvas(ev) {
    const r = canvas.getBoundingClientRect();
    const pr = (ev.pressure && ev.pressure > 0.01) ? ev.pressure : 0.5;
    return {
      x: (ev.clientX - r.left) * (W / r.width),
      y: (ev.clientY - r.top) * (H / r.height),
      w: Math.max(1, grosor * (0.35 + 1.3 * pr)),
    };
  }
  function eraserRadius() {
    const r = canvas.getBoundingClientRect();
    return Math.max(6, 18 * (W / r.width));
  }
  function eraseAt(p, rad) {
    const r2 = rad * rad;
    const out = [];
    for (const s of strokes) {
      let run = null;
      for (const q of s.points) {
        if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 > r2) {
          if (!run) { run = { c: s.c, points: [] }; out.push(run); }
          run.points.push(q);
        } else { run = null; }
      }
    }
    strokes = out;
  }

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'pen') activePen.add(ev.pointerId);
    if (ev.pointerType === 'touch' && activePen.size > 0) return; // rechazo de palma
    ev.preventDefault();
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* opcional */ }
    drawing = true;
    if (erase) { eraseAt(toCanvas(ev), eraserRadius()); redraw(); return; }
    cur = { c: color, points: [toCanvas(ev)] };
    strokes.push(cur);
    drawDot(cur.points[0], color);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drawing) return;
    const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    if (erase) {
      for (const e2 of evs) eraseAt(toCanvas(e2), eraserRadius());
      redraw();
      return;
    }
    if (!cur) return;
    for (const e2 of evs) {
      const p = toCanvas(e2);
      const prev = cur.points[cur.points.length - 1];
      cur.points.push(p);
      drawSeg(prev, p, cur.c);
    }
  });
  const terminar = (ev) => {
    if (ev && ev.pointerType === 'pen') activePen.delete(ev.pointerId);
    drawing = false;
    cur = null;
  };
  canvas.addEventListener('pointerup', terminar);
  canvas.addEventListener('pointercancel', terminar);
  canvas.addEventListener('pointerleave', terminar);

  ov.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      color = sw.dataset.color;
      ov.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      sw.classList.add('active');
      if (erase) { erase = false; ov.querySelector('#ed-erase').classList.remove('on'); }
    });
  });
  ov.querySelectorAll('[data-grosor]').forEach((b) => {
    b.addEventListener('click', () => {
      grosor = Number(b.dataset.grosor);
      ov.querySelectorAll('[data-grosor]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
  ov.querySelector('#ed-erase').addEventListener('click', (b) => {
    erase = !erase;
    b.target.classList.toggle('on', erase);
  });
  ov.querySelector('#ed-undo').addEventListener('click', () => { strokes.pop(); redraw(); });
  ov.querySelector('#ed-clear').addEventListener('click', () => {
    if (strokes.length && confirm('¿Borrar todo lo dibujado?')) { strokes = []; redraw(); }
  });

  function cerrar() {
    if (baseUrl) URL.revokeObjectURL(baseUrl);
    ov.remove();
    document.body.classList.remove('editing');
  }
  ov.querySelector('#ed-cancel').addEventListener('click', cerrar);
  ov.querySelector('#ed-save').addEventListener('click', async () => {
    const tipo = base ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((res) => canvas.toBlob(res, tipo, tipo === 'image/jpeg' ? (ajustes.calidad || 0.82) : undefined));
    if (!blob) { alert('No se pudo generar la imagen.'); return; }
    const blobId = uid();
    const baseNombre = (baseEntry && baseEntry.nombre ? baseEntry.nombre.replace(/\.[^.]+$/, '') : 'Lienzo');
    await db.put('blobs', { id: blobId, blob, nombre: base ? 'anotacion.jpg' : 'lienzo.png', tipo });
    await db.put('entries', {
      id: uid(), obraId, tipo: 'foto', blobId,
      nombre: baseNombre + ' (anotado)', texto: '', creado: new Date().toISOString(),
      recordatorio: null, notificado: false, completado: false,
    });
    cerrar();
    await reload();
    route();
  });

  redraw();
}

/* ============================ notificaciones ============================ */
async function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  const due = entries.filter((e) => e.recordatorio && !e.completado && !e.notificado && new Date(e.recordatorio).getTime() <= now);
  for (const e of due) {
    const o = obras.find((x) => x.id === e.obraId);
    try {
      new Notification('Recordatorio · ' + (o ? o.nombre : 'Obra'), { body: String(entryLabel(e)).slice(0, 140), tag: e.id });
    } catch (_) { /* ignorar */ }
    e.notificado = true;
    await db.put('entries', e);
  }
  if (due.length) await reload();
}

/* ============================ sincronización con Drive ============================ */
let sincronizando = false;
let syncPendiente = false;
let ultimoError = null;
let syncInicio = 0;
let progresoActual = '';
let versionLocal = 0;         // sube con cada cambio del usuario
let versionSincronizada = 0;  // hasta dónde se ha subido

// registro de actividad, para poder diagnosticar sin adivinar
const registro = [];
function anota(msg) {
  registro.push(`${new Date().toLocaleTimeString('es-ES')}  ${msg}`);
  if (registro.length > 400) registro.shift();
}

// Marca un registro como borrado para que la sincronización lo propague.
async function marcarBorrado(id, tipo) {
  const m = (await db.get('meta', 'borrados')) || { k: 'borrados', lista: [] };
  m.lista = (m.lista || []).filter((x) => x.id !== id);
  m.lista.push({ id, tipo, actualizado: new Date().toISOString() });
  await db.put('meta', m);
}

async function sincronizarDrive(opts = {}) {
  const silencioso = !!opts.silencioso;
  if (sincronizando) {
    if (!silencioso) alert('Ya hay una sincronización en curso.');
    return;
  }
  if (!drive.configurado()) {
    if (!silencioso) alert('Falta el Client ID de Google.\n\nHay que rellenar CLIENT_ID en js/config.js.');
    return;
  }
  const vSnapshot = versionLocal;
  sincronizando = true;
  syncInicio = Date.now();
  progresoActual = 'Conectando con Drive…';
  anota(silencioso ? '── Sincronización automática' : '── Sincronización manual');
  ultimoError = null;
  // Se marca limpio AHORA: si algo se escribe durante la sincronización,
  // volverá a marcarse como sucio y se re-encolará.
  sucio = false;
  if (!silencioso) closeModal();
  const tituloPrevio = pageTitle.textContent;
  if (!silencioso) pageTitle.textContent = 'Conectando con Drive…';
  else if (syncBtn) syncBtn.title = 'Sincronizando…';
  try {
    const r = await drive.sincronizar((msg) => {
      progresoActual = msg;
      anota(msg);
      pintarEstadoSync();
      if (!silencioso) pageTitle.textContent = msg;
      else if (syncBtn) syncBtn.title = msg;
    }, {
      bajoDemanda: ajustes.bajoDemanda,
      interactivo: !silencioso,
      sinCambiosLocales: versionLocal <= versionSincronizada,
      // El índice ya está a salvo: refrescamos la pantalla para que se vea al instante
      onIndice: async () => { await reload(); route(); },
    });
    versionSincronizada = vSnapshot;      // lo que ya está subido (lo posterior sigue pendiente)
    await reload();
    route();
    progresoActual = '';
    anota(r.sinCambios
      ? 'OK · sin cambios en Drive'
      : `OK · obras ${r.obras} · entradas ${r.entries} · subidos ${r.subidos} · bajados ${r.bajados}${r.papelera ? ' · papelera ' + r.papelera : ''}`);
    if (!silencioso && r.sinCambios) {
      alert('Sin cambios: todo estaba al día.');
    } else if (!silencioso) {
      const extra = r.movidos ? `\nArchivos reorganizados: ${r.movidos}` : '';
      const pap = r.papelera ? `\nEnviados a la papelera de Drive: ${r.papelera}` : '';
      alert(`Sincronizado con Drive.\n\nObras: ${r.obras}\nEntradas: ${r.entries}\nArchivos subidos: ${r.subidos}\nArchivos bajados: ${r.bajados}${extra}${pap}`);
    }
  } catch (err) {
    console.error('Chronos: error de sincronización', err);
    ultimoError = { mensaje: (err && err.message) ? err.message : String(err), cuando: new Date().toISOString() };
    anota('ERROR: ' + ultimoError.mensaje + (progresoActual ? ` (en: ${progresoActual})` : ''));
    progresoActual = '';
    sucio = true;                       // sigue habiendo cambios sin subir
    if (!silencioso) {
      closeModal();
      pageTitle.textContent = tituloPrevio;
      route();
      alert('No se pudo sincronizar:\n\n' + err.message);
    }
  } finally {
    sincronizando = false;
    refrescarBotonSync();
    if (syncPendiente) { syncPendiente = false; programarSync(1200); }
  }
}

/* ---------------------- sincronización automática ---------------------- */
let syncTimer = null;

function enWifi() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c || !c.type) return true;               // no se puede saber: permitimos
  return c.type === 'wifi' || c.type === 'ethernet';
}

function minutosDesde(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return isNaN(t) ? Infinity : (Date.now() - t) / 60000;
}

// Programa una sincronización con retardo (agrupa cambios seguidos).
function programarSync(retraso) {
  if (!ajustes.autoSync || !drive.configurado()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sincronizarAuto, retraso === undefined ? 5000 : retraso);
}

let motivoSync = '';
function setMotivo(m) {
  if (m === motivoSync) return;
  motivoSync = m;
  if (m) anota('Sincronización aplazada: ' + m);
  pintarEstadoSync();
}

async function sincronizarAuto() {
  if (!ajustes.autoSync) { setMotivo('la sincronización automática está desactivada'); return; }
  if (!drive.configurado()) return;
  if (sincronizando) { syncPendiente = true; return; }   // no se descarta: se re-encola al terminar
  if (!navigator.onLine) { setMotivo('sin conexión'); return; }
  if (ajustes.soloWifi && !enWifi()) { setMotivo('esperando WiFi (dato móvil)'); return; }
  setMotivo('');
  await sincronizarDrive({ silencioso: true });
}

function descargaDialog() {
  openModal(`
    <h2>Descarga de archivos</h2>
    <p class="hint">Qué hacer con las fotos y PDFs que ya están en tu Drive. En ambos modos se sincronizan siempre los comentarios, fechas y recordatorios.</p>
    <div class="menu-list">
      <button data-bd="0">${!ajustes.bajoDemanda ? '✅ ' : ''}Descargar todo <span class="hint">— móvil/tablet, para trabajar sin conexión en la obra</span></button>
      <button data-bd="1">${ajustes.bajoDemanda ? '✅ ' : ''}Solo cuando abro un archivo <span class="hint">— PC del trabajo: baja unos KB en vez de 1,2 GB</span></button>
    </div>
    <div class="modalactions"><button class="btn" id="d_close">Cerrar</button></div>`, (m) => {
    m.querySelectorAll('[data-bd]').forEach((b) => {
      b.onclick = async () => {
        await guardarAjustes({ bajoDemanda: b.dataset.bd === '1' });
        closeModal();
        route();
      };
    });
    m.querySelector('#d_close').onclick = closeModal;
  });
}

function autoSyncDialog() {
  openModal(`
    <h2>Sincronización automática</h2>
    <p class="hint">Además del botón ☁, Chronos puede sincronizar sola al abrir la app, al recuperar la conexión y unos segundos después de cada cambio.</p>
    <div class="menu-list">
      <button data-auto="1">${ajustes.autoSync ? '✅ ' : ''}Sincronizar automáticamente</button>
      <button data-wifi="1">${ajustes.soloWifi ? '✅ ' : ''}Solo con WiFi <span class="hint">(no gastar datos móviles)</span></button>
    </div>
    <div class="modalactions"><button class="btn" id="a_close">Cerrar</button></div>`, (m) => {
    m.querySelector('[data-auto]').onclick = async () => {
      await guardarAjustes({ autoSync: !ajustes.autoSync });
      closeModal();
      autoSyncDialog();
    };
    m.querySelector('[data-wifi]').onclick = async () => {
      await guardarAjustes({ soloWifi: !ajustes.soloWifi });
      closeModal();
      autoSyncDialog();
    };
    m.querySelector('#a_close').onclick = closeModal;
  });
}

// Estados visualmente inequívocos: color + franja con texto.
function pintarEstadoSync() {
  const bar = document.getElementById('syncBar');
  if (syncBtn) { syncBtn.className = 'iconbtn'; syncBtn.textContent = '☁'; syncBtn.hidden = !drive.configurado(); }
  if (bar) { bar.hidden = true; bar.className = 'syncbar'; }
  if (!drive.configurado()) return;

  if (sincronizando) {
    if (syncBtn) { syncBtn.className = 'iconbtn trabajando'; syncBtn.title = 'Sincronizando…'; }
    if (bar) { bar.hidden = false; bar.className = 'syncbar trabajando'; bar.textContent = '⏳ ' + (progresoActual || 'Sincronizando…'); }
    return;
  }
  if (ultimoError) {
    if (syncBtn) { syncBtn.className = 'iconbtn error'; syncBtn.textContent = '!'; syncBtn.title = 'Falló la sincronización'; }
    if (bar) { bar.hidden = false; bar.className = 'syncbar error'; bar.textContent = '⚠ No se pudo sincronizar: ' + ultimoError.mensaje + ' — pulsa aquí para reintentar'; }
    return;
  }
  if (sucio) {
    if (syncBtn) { syncBtn.className = 'iconbtn pendiente'; syncBtn.title = 'Hay cambios sin subir'; syncBtn.innerHTML = '☁<span class="punto"></span>'; }
    const detalle = motivoSync ? ` (${motivoSync})` : '';
    if (bar) { bar.hidden = false; bar.className = 'syncbar pendiente'; bar.textContent = `↑ Hay cambios sin subir${detalle} — pulsa aquí para sincronizar`; }
  }
}

async function refrescarBotonSync() {
  pintarEstadoSync();
  if (!syncBtn || !drive.configurado()) return;
  if (!sincronizando && !sucio && !ultimoError) {
    const u = await drive.ultimaSync();
    syncBtn.title = u ? 'Todo sincronizado · ' + fmt(u) : 'Sincronizar con Drive';
  }
}

async function estadoSyncTexto() {
  if (sincronizando) {
    const min = Math.round((Date.now() - syncInicio) / 60000);
    return `⏳ Sincronizando${progresoActual ? ': ' + esc(progresoActual) : '…'}${min >= 1 ? ` (${min} min)` : ''}`;
  }
  if (ultimoError) return '⚠️ El último intento falló: ' + esc(ultimoError.mensaje) + ' (' + fmt(ultimoError.cuando) + ')';
  if (sucio) return '☁︎ Hay cambios pendientes de subir. Pulsa el botón ☁ de la barra superior.';
  if (!drive.configurado()) return 'Sincronización no configurada.';
  const u = await drive.ultimaSync();
  return u ? '☁ Todo sincronizado. Última: ' + fmt(u) : '☁ Todo sincronizado.';
}

function registroDialog() {
  const txt = registro.length ? registro.slice(-250).join('\n') : 'Sin actividad todavía.';
  openModal(`
    <h2>Registro de sincronización</h2>
    <p class="hint">Últimas operaciones. Si algo falla, cópialo y me lo pasas: con esto dejo de adivinar.</p>
    <textarea id="rg_txt" readonly style="min-height:260px;font-family:ui-monospace,monospace;font-size:.76rem;white-space:pre">${esc(txt)}</textarea>
    <div class="modalactions">
      <button class="btn" id="rg_copiar">Copiar</button>
      <button class="btn primary" id="rg_close">Cerrar</button>
    </div>`, (m) => {
    m.querySelector('#rg_close').onclick = closeModal;
    m.querySelector('#rg_copiar').onclick = async () => {
      try { await navigator.clipboard.writeText(txt); alert('Registro copiado al portapapeles.'); }
      catch (_) { alert('No se pudo copiar. Selecciona el texto y cópialo a mano.'); }
    };
  });
}

/* ============================ ajustes ============================ */
async function settingsDialog() {
  const estado = await estadoSyncTexto();
  openModal(`
    <h2>Ajustes</h2>
    <p class="hint" style="margin:-6px 0 12px">${estado}<br><span style="opacity:.6">versión ${VERSION}</span></p>
    <div class="menu-list">
      <button id="s_notif">🔔 Activar notificaciones</button>
      <button id="s_calidad">🖼️ Calidad de las fotos</button>
      <button id="s_auto">🔁 Sincronización automática</button>
      <button id="s_descarga">📥 Descarga de archivos</button>
      <button id="s_registro">📋 Registro de sincronización</button>
      <button id="s_forzar">☁️ Sincronizar ahora</button>
      <button id="s_export">⬇️ Exportar copia de seguridad (.json)</button>
      <button id="s_import">⬆️ Importar copia de seguridad</button>
      <button id="s_migracion">📥 Importar migración de AppSheet (1 clic)</button>
      <button id="s_drive">☁️ Sincronizar con Google Drive</button>
      <button class="btn" id="s_close" style="text-align:center">Cerrar</button>
    </div>
    <p class="hint" style="margin-top:14px">Los datos se guardan solo en este dispositivo hasta que actives la sincronización.</p>`, (m) => {
    m.querySelector('#s_close').onclick = closeModal;
    m.querySelector('#s_notif').onclick = async () => {
      if (!('Notification' in window)) { alert('Este navegador no soporta notificaciones.'); return; }
      const p = await Notification.requestPermission();
      alert(p === 'granted' ? 'Notificaciones activadas.' : 'No se concedieron permisos.');
    };
    m.querySelector('#s_export').onclick = exportBackup;
    m.querySelector('#s_import').onclick = importBackup;
    m.querySelector('#s_migracion').onclick = importarDesdeServidor;
    m.querySelector('#s_calidad').onclick = calidadDialog;
    m.querySelector('#s_auto').onclick = autoSyncDialog;
    m.querySelector('#s_descarga').onclick = descargaDialog;
    m.querySelector('#s_registro').onclick = registroDialog;
    m.querySelector('#s_forzar').onclick = () => sincronizarDrive();
    m.querySelector('#s_drive').onclick = sincronizarDrive;
  });
}

// Importa de una sola vez los backups de AppSheet servidos en la carpeta local.
async function importarDesdeServidor() {
  let idx;
  try {
    const r = await fetch('rescate/index.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('sin indice');
    idx = await r.json();
  } catch (_) {
    alert('No encuentro la carpeta de migración.\n\nDebe existir: obras-app/rescate/index.json');
    return;
  }
  const archivos = idx.archivos || [];
  if (!archivos.length) { alert('La carpeta de migración está vacía.'); return; }
  if (!confirm(`Se importarán ${archivos.length} ficheros (${idx.total_mb} MB).\nPuede tardar varios minutos. ¿Continuar?`)) return;
  let ok = 0, err = 0;
  for (let i = 0; i < archivos.length; i++) {
    try {
      const resp = await fetch('rescate/' + encodeURIComponent(archivos[i]), { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const d = await resp.json();
      for (const o of (d.obras || [])) await db.put('obras', o);
      for (const e of (d.entries || [])) await db.put('entries', e);
      for (const b of (d.blobs || [])) {
        const blob = await (await fetch(b.dataUrl)).blob();
        await db.put('blobs', { id: b.id, nombre: b.nombre, tipo: b.tipo, blob });
      }
      ok++;
    } catch (e) { console.error('Error importando', archivos[i], e); err++; }
    pageTitle.textContent = `Importando… ${i + 1}/${archivos.length}`;
  }
  await reload(); closeModal(); route();
  alert(`Importación terminada: ${ok} de ${archivos.length}.${err ? ` Errores: ${err}.` : ''}`);
}

function calidadDialog() {
  const ops = [
    { max: 1600, t: 'Ligera', d: '1600 px · ~250 KB por foto' },
    { max: 1920, t: 'Recomendada', d: '1920 px · ~450 KB por foto' },
    { max: 2560, t: 'Alta', d: '2560 px · ~800 KB por foto' },
    { max: 0, t: 'Sin comprimir', d: 'tamaño original de la cámara (3-6 MB)' },
  ];
  const marcado = (o) => (o.max === 0 ? !ajustes.comprimir : (ajustes.comprimir && ajustes.maxDim === o.max));
  openModal(`
    <h2>Calidad de las fotos</h2>
    <p class="hint">Se aplica a las fotos nuevas: cámara, galería y anotaciones. Las que ya tienes no se tocan.</p>
    <div class="menu-list">
      ${ops.map((o) => `<button data-max="${o.max}">${marcado(o) ? '✅ ' : ''}${o.t} <span class="hint">— ${o.d}</span></button>`).join('')}
    </div>
    <div class="modalactions"><button class="btn" id="q_close">Cerrar</button></div>`, (m) => {
    m.querySelectorAll('[data-max]').forEach((b) => {
      b.onclick = async () => {
        const max = Number(b.dataset.max);
        await guardarAjustes({ comprimir: max > 0, maxDim: max > 0 ? max : 1920 });
        closeModal();
        route();
      };
    });
    m.querySelector('#q_close').onclick = closeModal;
  });
}

async function exportBackup() {
  const payload = { app: 'obras', version: 1, exportado: new Date().toISOString(), obras: [], entries: [], blobs: [] };
  payload.obras = obras;
  for (const e of entries) { payload.entries.push(e); }
  for (const b of await db.getAll('blobs')) {
    const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b.blob); });
    payload.blobs.push({ id: b.id, nombre: b.nombre, tipo: b.tipo, dataUrl });
  }
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `obras-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  closeModal();
}

async function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.multiple = true;
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    if (!confirm(`Se importarán ${files.length} archivo(s). Puede tardar si contienen fotos. ¿Continuar?`)) return;
    let obrasN = 0, errN = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        const data = JSON.parse(await files[i].text());
        if (!data || !Array.isArray(data.obras)) { errN++; continue; }
        for (const o of data.obras) await db.put('obras', o);
        for (const e of (data.entries || [])) await db.put('entries', e);
        for (const b of (data.blobs || [])) {
          const blob = await (await fetch(b.dataUrl)).blob();
          await db.put('blobs', { id: b.id, nombre: b.nombre, tipo: b.tipo, blob });
        }
        obrasN++;
        if (obrasN % 5 === 0) pageTitle.textContent = `Importando… ${i + 1}/${files.length}`;
      } catch (err) { console.error('Error importando', files[i].name, err); errN++; }
    }
    await reload(); closeModal(); route();
    alert(`Importadas ${obrasN} obra(s).${errN ? ` Con error: ${errN}.` : ''}`);
  };
  inp.click();
}

/* ============================ router ============================ */
function route() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  searchBar.hidden = parts.length > 0;
  searchBtn.hidden = parts.length > 0;
  if (parts[0] === 'obra' && parts[1]) {
    let id = parts[1];
    try { id = decodeURIComponent(id); } catch (_) { /* usar tal cual */ }
    return renderObra(id);
  }
  if (parts[0] === 'recordatorios') return renderRecordatorios();
  if (parts[0] === 'inbox') return renderInbox();
  return renderObras();
}

/* ============================ eventos ============================ */
view.addEventListener('change', (ev) => {
  const c = ev.target.closest('input[data-sel]');
  if (!c) return;
  if (c.checked) seleccionInbox.add(c.dataset.sel);
  else seleccionInbox.delete(c.dataset.sel);
  barraInbox();
});

view.addEventListener('click', async (ev) => {
  const go = ev.target.closest('[data-goto]');
  if (go) { location.hash = go.dataset.goto; return; }
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  ev.preventDefault();
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === 'recordatorio') return reminderDialog(id);
  if (act === 'anotar') {
    const e = entries.find((x) => x.id === id);
    if (e) return openEditor(e.obraId, e);
    return;
  }
  if (act === 'ver-pdf') {
    const e = entries.find((x) => x.id === id);
    const box = document.getElementById('pdf_' + id);
    if (!e || !box) return;
    if (!box.hidden) { box.innerHTML = ''; box.hidden = true; btn.textContent = 'ver aquí'; return; }
    const u = await blobUrl(e.blobId);
    if (!u) { alert('Este PDF no está disponible en el dispositivo.'); return; }
    box.innerHTML = `<iframe src="${u}" title="PDF" style="width:100%;height:75vh;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>`;
    box.hidden = false;
    btn.textContent = 'ocultar';
    return;
  }
  if (act === 'bajar') {
    const e = entries.find((x) => x.id === id);
    if (!e || !e.blobId) return;
    btn.textContent = 'descargando…';
    try {
      await drive.descargarBlob(e.blobId);
      await route();
    } catch (err) {
      alert('No se pudo descargar:\n\n' + err.message);
      btn.textContent = 'descargar';
    }
    return;
  }
  if (act === 'toggle-done') {
    const e = entries.find((x) => x.id === id);
    if (e) { e.completado = !e.completado; e.actualizado = new Date().toISOString(); await db.put('entries', e); await reload(); route(); }
    return;
  }
  if (act === 'del') {
    const e = entries.find((x) => x.id === id);
    if (e && confirm('¿Borrar esta entrada?')) {
      if (e.blobId) await db.del('blobs', e.blobId);
      await db.del('entries', e.id);
      await marcarBorrado(e.id, 'entry');
      await reload(); route();
    }
    return;
  }
  if (act === 'del-inbox') {
    const it = inbox.find((x) => x.id === id);
    if (it) { if (it.blobId) await db.del('blobs', it.blobId); await db.del('inbox', it.id); await reload(); route(); }
    return;
  }
});

backBtn.onclick = () => { location.hash = '#/'; };
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => { location.hash = t.dataset.nav; }; });
searchBtn.onclick = () => { searchBar.hidden = !searchBar.hidden; if (!searchBar.hidden) searchInput.focus(); };
syncBtn.onclick = () => sincronizarDrive();
searchInput.oninput = () => { filtro = searchInput.value; renderObras(); };
menuBtn.onclick = settingsDialog;
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Sincronización automática: al cambiar datos, al recuperar red y al volver a la app.
let sucio = false;   // hay cambios locales que aún no han subido a Drive
db.onWrite(() => { versionLocal++; sucio = true; programarSync(); pintarEstadoSync(); });
document.getElementById('syncBar').onclick = () => { if (!sincronizando) sincronizarDrive(); };
window.addEventListener('online', () => programarSync(2000));
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    if (sucio) sincronizarAuto();          // última oportunidad antes de perder el foco
    return;
  }
  const u = await drive.ultimaSync();
  if (minutosDesde(u) > 10) programarSync(1500);
});

// Aviso si se intenta cerrar con cambios sin sincronizar (clave en incógnito).
window.addEventListener('beforeunload', (e) => {
  if (sucio) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================ arranque ============================ */
async function init() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (_) { /* sin SW */ }
  }
  anota('Chronos ' + VERSION + ' — inicio');
  await cargarAjustes();
  await reload();
  route();
  refrescarBotonSync();
  if (drive.configurado()) {
    const u = await drive.ultimaSync();
    if (minutosDesde(u) > 5) programarSync(4000);
  }
  checkReminders();
  setInterval(checkReminders, 60000);
  // Cada 5 minutos, si hay algo pendiente y las condiciones lo permiten.
  setInterval(async () => {
    // Vigilante: si una sincronización lleva colgada demasiado, se libera.
    if (sincronizando && syncInicio && Date.now() - syncInicio > 12 * 60 * 1000) {
      sincronizando = false;
      progresoActual = '';
      ultimoError = { mensaje: 'La sincronización se quedó colgada más de 12 minutos.', cuando: new Date().toISOString() };
      anota('WATCHDOG: sincronización colgada, liberada');
      refrescarBotonSync();
    }
    if (!ajustes.autoSync || !drive.configurado()) return;
    if (sincronizando) return;
    const u = await drive.ultimaSync();
    if (minutosDesde(u) > 1) programarSync(1000);   // sondeo barato: 1 petición pequeña
  }, 60 * 1000);
}
init();
