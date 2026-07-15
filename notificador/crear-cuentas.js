/* ============================================================
   Comunica · Colegio Bilbao — Crear cuentas de acceso faltantes
   Se corre A MANO desde GitHub Actions ("Run workflow"), NO automático.
   Revisa el directorio (colección "usuarios" en Firestore) y, por cada
   persona con correo que TODAVÍA NO tenga cuenta en Firebase Authentication,
   le crea una con la contraseña temporal que hayas escrito al lanzar el flujo.
   A quien ya tiene cuenta lo salta (no la toca, no la duplica).
   ============================================================ */
import admin from 'firebase-admin';

const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const TEMP_PASSWORD = process.env.TEMP_PASSWORD || '';

if (!SA.project_id) {
  console.error('Falta el Secret FIREBASE_SERVICE_ACCOUNT.');
  process.exit(1);
}
if (!TEMP_PASSWORD || TEMP_PASSWORD.length < 6) {
  console.error('La contraseña temporal debe tener al menos 6 caracteres.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();
const auth = admin.auth();

(async () => {
  const snap = await db.collection('usuarios').get();
  let creadas = 0, existentes = 0, sinCorreo = 0, errores = 0;

  for (const docu of snap.docs) {
    const u = docu.data();
    if (!u.email) { console.log('  — Sin correo, se omite:', u.name || docu.id); sinCorreo++; continue; }

    try {
      await auth.getUserByEmail(u.email);
      existentes++; // ya tenía cuenta, no se toca
    } catch (e) {
      if (e.code !== 'auth/user-not-found') { console.error('  ⚠ Error revisando', u.email, '-', e.message); errores++; continue; }
      try {
        await auth.createUser({ email: u.email, password: TEMP_PASSWORD, displayName: u.name || undefined });
        console.log('  ✓ Cuenta creada:', u.email);
        creadas++;
      } catch (e2) {
        console.error('  ✗ Error creando', u.email, '-', e2.message);
        errores++;
      }
    }
  }

  console.log('----------------------------------------');
  console.log(`Listo. Creadas: ${creadas} · Ya existían: ${existentes} · Sin correo: ${sinCorreo} · Errores: ${errores}`);
  process.exit(errores > 0 ? 1 : 0);
})();
