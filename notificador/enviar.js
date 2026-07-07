/* ============================================================
   Comunica · Colegio Bilbao — Robot de notificaciones
   Se ejecuta solo (GitHub Actions) cada pocos minutos:
   1) Avisos nuevos  -> push a la audiencia elegida
   2) Recordatorios de eventos (avisos agendados) -> push a la audiencia
   3) Recordatorios de tareas personales -> push SOLO a su dueño (privado)
   Marca en Firestore lo ya enviado para no repetir.
   ============================================================ */
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

// --- Credenciales (vienen de los "Secrets" de GitHub, nunca del código) ---
const SA        = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const OS_APP_ID = process.env.ONESIGNAL_APP_ID;
const OS_KEY    = process.env.ONESIGNAL_REST_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;           // ej. avisos@bilbao.edu.mx
const EMAIL_PASS = process.env.EMAIL_APP_PASSWORD;   // contraseña de aplicación de Google Workspace
const APP_URL   = 'https://angel-sant.github.io/Anuncios/';
const TZ_OFFSET = 6; // Ciudad de México = UTC-6 (sin horario de verano)

if (!SA.project_id || !OS_APP_ID || !OS_KEY) {
  console.error('Faltan credenciales. Revisa los Secrets del repositorio.');
  process.exit(1);
}
const emailHabilitado = !!(EMAIL_USER && EMAIL_PASS);
if (!emailHabilitado) {
  console.warn('EMAIL_USER / EMAIL_APP_PASSWORD no configurados: esta corrida NO enviará correos, solo push.');
}
const mailer = emailHabilitado ? nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
}) : null;

admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();

// --- Directorio completo (una sola vez por corrida): para resolver a qué correos les toca cada aviso ---
let USERS_CACHE = [];
async function cargarUsuarios() {
  const snap = await db.collection('usuarios').get();
  USERS_CACHE = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
function areasDe(u){ if(Array.isArray(u.areas)&&u.areas.length) return u.areas; return u.area?[u.area]:[]; }
const AUD_MATCH = {
  todos:        () => true,
  docentes:     u => u.role==='docente',
  coords:       u => u.role==='coordinacion' || u.role==='direccion',
  kinder:       u => areasDe(u).includes('Kinder'),
  primaria:     u => areasDe(u).includes('Primaria'),
  secundaria:   u => areasDe(u).includes('Secundaria'),
  bachillerato: u => areasDe(u).includes('Bachillerato'),
  admin:        u => u.area==='Administración',
  transporte:   u => u.subarea==='Transporte',
  mantenimiento:u => u.subarea==='Mantenimiento e Intendencia',
  seguridad:    u => u.subarea==='Seguridad',
  'admin-of':   u => u.subarea==='Administración',
  enfermeria:   u => u.subarea==='Enfermería',
  cafeteria:    u => u.subarea==='Cafetería',
};
function destinatariosPara(audId) {
  const fn = AUD_MATCH[audId] || AUD_MATCH.todos;
  return USERS_CACHE.filter(u => u.email && fn(u));
}

// --- Envía un correo (plantilla simple con la marca de Comunica) ---
async function enviarCorreo({ to, heading, content }) {
  if (!emailHabilitado) return false;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#4A8BC4;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
        <strong style="font-size:15px">Comunica · Colegio Bilbao</strong>
      </div>
      <div style="border:1px solid #e2e2e2;border-top:none;border-radius:0 0 10px 10px;padding:20px">
        <h2 style="margin:0 0 10px;font-size:18px;color:#222">${heading}</h2>
        <p style="font-size:14px;color:#444;line-height:1.5;white-space:pre-wrap">${content || ''}</p>
        <a href="${APP_URL}" style="display:inline-block;margin-top:14px;background:#4A8BC4;color:#fff;
          text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Abrir Comunica</a>
      </div>
    </div>`;
  try {
    await mailer.sendMail({ from: `"Comunica · Colegio Bilbao" <${EMAIL_USER}>`, to, subject: heading, html });
    return true;
  } catch (e) {
    console.error('  ⚠ Error enviando correo a', to, '-', e.message);
    return false;
  }
}
// Envía a toda una audiencia (uno por uno, para no exponer correos entre destinatarios)
async function enviarCorreosAudiencia(audId, heading, content) {
  if (!emailHabilitado) return 0;
  const dest = destinatariosPara(audId);
  let ok = 0;
  for (const u of dest) { if (await enviarCorreo({ to: u.email, heading, content })) ok++; }
  if (dest.length) console.log('  ✉ correos:', ok + '/' + dest.length);
  return ok;
}

/* ---------- Mapa de audiencias -> filtro de OneSignal ----------
   La app etiqueta cada suscripción con: area, rol, seccion.
   'todos' = a todos; lo demás filtra por etiqueta.               */
function targetFor(aud) {
  switch (aud) {
    case 'todos':        return { included_segments: ['Total Subscriptions'] };
    case 'docentes':     return { filters: [{ field: 'tag', key: 'rol',  relation: '=', value: 'docente' }] };
    case 'coords':       return { filters: [{ field: 'tag', key: 'rol',  relation: '=', value: 'coordinacion' },
                                            { operator: 'OR' },
                                            { field: 'tag', key: 'rol',  relation: '=', value: 'direccion' }] };
    case 'kinder':       return { filters: [{ field: 'tag', key: 'area_Kinder', relation: '=', value: 'si' }] };
    case 'primaria':     return { filters: [{ field: 'tag', key: 'area_Primaria', relation: '=', value: 'si' }] };
    case 'secundaria':   return { filters: [{ field: 'tag', key: 'area_Secundaria', relation: '=', value: 'si' }] };
    case 'bachillerato': return { filters: [{ field: 'tag', key: 'area_Bachillerato', relation: '=', value: 'si' }] };
    case 'admin':        return { filters: [{ field: 'tag', key: 'area', relation: '=', value: 'Administración' }] };
    case 'transporte':   return { filters: [{ field: 'tag', key: 'seccion', relation: '=', value: 'Transporte' }] };
    case 'mantenimiento':return { filters: [{ field: 'tag', key: 'seccion', relation: '=', value: 'Mantenimiento e Intendencia' }] };
    case 'seguridad':    return { filters: [{ field: 'tag', key: 'seccion', relation: '=', value: 'Seguridad' }] };
    case 'admin-of':     return { filters: [{ field: 'tag', key: 'seccion', relation: '=', value: 'Administración' }] };
    case 'enfermeria':   return { filters: [{ field: 'tag', key: 'seccion', relation: '=', value: 'Enfermería' }] };
    case 'cafeteria':    return { filters: [{ field: 'tag', key: 'seccion', relation: '=', value: 'Cafetería' }] };
    default:             return { included_segments: ['Total Subscriptions'] };
  }
}

// --- Envía una notificación por la API nueva de OneSignal ---
async function enviarPush({ heading, content, target }) {
  const body = {
    app_id: OS_APP_ID,
    target_channel: 'push',
    headings: { en: heading, es: heading },
    contents: { en: content, es: content },
    url: APP_URL,
    ...target
  };
  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${OS_KEY}` },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    console.error('  ⚠ OneSignal respondió con error:', JSON.stringify(json.errors || json));
    return false;
  }
  console.log('  ✓ enviado (id ' + (json.id || '—') + ', destinatarios ' + (json.recipients ?? '?') + ')');
  return true;
}

// --- Fecha/hora "de pared" en CDMX -> instante UTC ---
function cdmxToInstant(y, mo, d, h, mi) {
  // UTC = hora local + 6h
  return new Date(Date.UTC(y, mo, d, h + TZ_OFFSET, mi)).getTime();
}
function ymd(dateObj) { return { y: dateObj.getUTCFullYear(), mo: dateObj.getUTCMonth(), d: dateObj.getUTCDate() }; }

// Momento (epoch ms) en que debe dispararse un recordatorio dado.
// Devuelve null si ese tipo no aplica a este item.
function momentoRecordatorio(label, eventDate, eventTime) {
  const base = new Date(eventDate);               // fecha del evento (ISO)
  const { y, mo, d } = ymd(base);
  const restarDias = n => { const t = new Date(Date.UTC(y, mo, d)); t.setUTCDate(t.getUTCDate() - n); const p = ymd(t); return cdmxToInstant(p.y, p.mo, p.d, 7, 0); };
  switch (label) {
    case '1 semana antes':          return restarDias(7);
    case '3 días antes':            return restarDias(3);
    case '1 día antes':             return restarDias(1);
    case 'El mismo día (7:00 a.m.)':return cdmxToInstant(y, mo, d, 7, 0);
    case '1 hora antes': {
      const [hh, mm] = (eventTime || '08:00').split(':').map(Number);
      return cdmxToInstant(y, mo, d, hh, mm) - 60 * 60 * 1000;
    }
    default: return null; // 'Diario' se maneja aparte
  }
}

const now = Date.now();
const VENTANA = 6 * 60 * 60 * 1000; // solo dispara recordatorios vencidos en las últimas 6 h (evita reenviar viejos)
let enviados = 0;

// ============ 1) AVISOS NUEVOS ============
async function procesarAvisosNuevos() {
  const snap = await db.collection('avisos').where('notified', '==', false).get();
  for (const docu of snap.docs) {
    const a = docu.data();
    console.log('Aviso nuevo:', a.title);
    const pre = a.prio === 'urgente' ? '🔴 ' : (a.prio === 'importante' ? '🟠 ' : '');
    const ok = await enviarPush({ heading: pre + (a.title || 'Aviso'), content: a.body || '', target: targetFor(a.aud) });
    await enviarCorreosAudiencia(a.aud, pre + (a.title || 'Aviso'), a.body || '');
    await docu.ref.update({ notified: true, notifiedAt: now });
    if (ok) enviados++;
  }
}

// ============ 2) RECORDATORIOS DE EVENTOS (avisos agendados) ============
async function procesarRecordatoriosEventos() {
  const snap = await db.collection('avisos').get();
  for (const docu of snap.docs) {
    const a = docu.data();
    if (!a.event || !Array.isArray(a.event.reminders) || a.event.reminders.length === 0) continue;
    const sent = Array.isArray(a.sentReminders) ? a.sentReminders : [];
    const nuevos = [];

    for (const label of a.event.reminders) {
      if (label === 'Diario (7:00 a.m.)') {
        // Repite cada día a las 7:00 hasta el día del evento
        const ev = ymd(new Date(a.event.date));
        const finEvento = cdmxToInstant(ev.y, ev.mo, ev.d, 23, 59);
        const hoy = new Date(now - TZ_OFFSET * 3600 * 1000); // "hoy" en CDMX
        const hy = hoy.getUTCFullYear(), hm = hoy.getUTCMonth(), hd = hoy.getUTCDate();
        const hoy7 = cdmxToInstant(hy, hm, hd, 7, 0);
        const clave = 'Diario:' + hy + '-' + String(hm + 1).padStart(2, '0') + '-' + String(hd).padStart(2, '0');
        if (now >= hoy7 && now <= finEvento && !sent.includes(clave)) {
          console.log('Recordatorio diario:', a.title);
          const ok = await enviarPush({ heading: '🔔 Recordatorio: ' + a.title, content: a.body || 'Actividad programada.', target: targetFor(a.aud) });
          await enviarCorreosAudiencia(a.aud, '🔔 Recordatorio: ' + a.title, a.body || 'Actividad programada.');
          if (ok) { enviados++; nuevos.push(clave); }
        }
        continue;
      }
      if (sent.includes(label)) continue;
      const t = momentoRecordatorio(label, a.event.date, a.event.time);
      if (t == null) continue;
      if (now >= t && now - t <= VENTANA) {
        console.log('Recordatorio (' + label + '):', a.title);
        const ok = await enviarPush({ heading: '🔔 Recordatorio: ' + a.title, content: a.body || 'Actividad programada.', target: targetFor(a.aud) });
        await enviarCorreosAudiencia(a.aud, '🔔 Recordatorio: ' + a.title, a.body || 'Actividad programada.');
        if (ok) { enviados++; nuevos.push(label); }
      }
    }
    if (nuevos.length) await docu.ref.update({ sentReminders: [...sent, ...nuevos] });
  }
}

// ============ 3) RECORDATORIOS DE TAREAS PERSONALES (privados) ============
async function procesarRecordatoriosTareas() {
  const snap = await db.collection('tareas_personales').where('done', '==', false).get();
  for (const docu of snap.docs) {
    const t = docu.data();
    if (!t.due || !Array.isArray(t.reminders) || t.reminders.length === 0) continue;
    const sent = Array.isArray(t.sentReminders) ? t.sentReminders : [];
    const nuevos = [];
    const dueDate = new Date(t.due + 'T00:00:00Z'); // due es 'YYYY-MM-DD'

    for (const label of t.reminders) {
      if (label === 'Diario (7:00 a.m.)') continue; // no aplicamos diario a tareas personales
      if (sent.includes(label)) continue;
      const when = momentoRecordatorio(label, dueDate.toISOString(), t.time);
      if (when == null) continue;
      if (now >= when && now - when <= VENTANA) {
        console.log('Recordatorio de tarea (privado):', t.title);
        const ok = await enviarPush({
          heading: '🔔 Pendiente: ' + t.title,
          content: t.notes || 'Tienes un pendiente para hoy.',
          target: { include_aliases: { external_id: [String(t.owner)] }, target_channel: 'push' }
        });
        const dueño = USERS_CACHE.find(u => String(u.id) === String(t.owner));
        if (dueño && dueño.email) await enviarCorreo({ to: dueño.email, heading: '🔔 Pendiente: ' + t.title, content: t.notes || 'Tienes un pendiente para hoy.' });
        if (ok) { enviados++; nuevos.push(label); }
      }
    }
    if (nuevos.length) await docu.ref.update({ sentReminders: [...sent, ...nuevos] });
  }
}

(async () => {
  try {
    await cargarUsuarios();
    await procesarAvisosNuevos();
    await procesarRecordatoriosEventos();
    await procesarRecordatoriosTareas();
    console.log('Listo. Notificaciones enviadas en esta corrida:', enviados);
    process.exit(0);
  } catch (e) {
    console.error('Error en el robot:', e);
    process.exit(1);
  }
})();
