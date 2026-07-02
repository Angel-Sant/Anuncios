/* ============================================================
   Comunica · Colegio Bilbao — Robot de notificaciones
   Se ejecuta solo (GitHub Actions) cada pocos minutos:
   1) Avisos nuevos  -> push a la audiencia elegida
   2) Recordatorios de eventos (avisos agendados) -> push a la audiencia
   3) Recordatorios de tareas personales -> push SOLO a su dueño (privado)
   Marca en Firestore lo ya enviado para no repetir.
   ============================================================ */
import admin from 'firebase-admin';

// --- Credenciales (vienen de los "Secrets" de GitHub, nunca del código) ---
const SA        = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const OS_APP_ID = process.env.ONESIGNAL_APP_ID;
const OS_KEY    = process.env.ONESIGNAL_REST_API_KEY;
const APP_URL   = 'https://angel-sant.github.io/Anuncios/';
const TZ_OFFSET = 6; // Ciudad de México = UTC-6 (sin horario de verano)

if (!SA.project_id || !OS_APP_ID || !OS_KEY) {
  console.error('Faltan credenciales. Revisa los Secrets del repositorio.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();

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
    case 'kinder':       return { filters: [{ field: 'tag', key: 'area', relation: '=', value: 'Kinder' }] };
    case 'primaria':     return { filters: [{ field: 'tag', key: 'area', relation: '=', value: 'Primaria' }] };
    case 'secundaria':   return { filters: [{ field: 'tag', key: 'area', relation: '=', value: 'Secundaria' }] };
    case 'bachillerato': return { filters: [{ field: 'tag', key: 'area', relation: '=', value: 'Bachillerato' }] };
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
        if (ok) { enviados++; nuevos.push(label); }
      }
    }
    if (nuevos.length) await docu.ref.update({ sentReminders: [...sent, ...nuevos] });
  }
}

(async () => {
  try {
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
