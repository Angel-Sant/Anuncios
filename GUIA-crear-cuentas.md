# Crear cuentas de acceso — Comunica (botón manual en GitHub Actions)

Esto resuelve la carga masiva de las cuentas de acceso (Firebase Authentication) sin instalar
nada ni usar la terminal — un botón que revisa tu Directorio y crea, de un jalón, la cuenta de
quien todavía no tenga una. A quien ya tiene cuenta lo salta (no la duplica ni la toca).

**Se corre siempre A MANO** — nunca se dispara solo ni por horario, a diferencia del robot de
notificaciones. Úsalo hoy para la carga inicial de todos, y después cada vez que agregues gente
nueva al Directorio y quieras darles acceso de una vez.

## Archivos a subir

Dentro de tu repositorio "Anuncios", agrega estos dos (respetando la ubicación exacta):

```
Anuncios/
├── notificador/
│   └── crear-cuentas.js
└── .github/
    └── workflows/
        └── crear-cuentas.yml
```

> No necesitas tocar `notificador/package.json` — usa las mismas dependencias que ya tiene el
> robot de notificaciones (`firebase-admin`), así que si ya subiste ese, aquí no falta nada más.

## Cómo usarlo

1. En tu repositorio, ve a la pestaña **Actions**.
2. En la lista de flujos, de lado izquierdo, busca **"Crear cuentas de acceso (Comunica)"**.
3. Botón **"Run workflow"** (arriba a la derecha de esa lista).
4. Te va a mostrar un campo de texto: **"Contraseña temporal para las cuentas NUEVAS…"** —
   escribe ahí la contraseña que quieras que tengan todas las cuentas que se creen en esta
   corrida (ej. `Bilbao2026`, o la que uses de convención). Mínimo 6 caracteres.
5. Dale **"Run workflow"** (el botón verde).
6. Espera unos segundos a que aparezca la corrida en la lista, dale clic y luego a **"crear"**
   para ver el registro — te dice cuántas cuentas creó, cuántas ya existían, y si hubo algún
   correo repetido o vacío que se saltó.

## Después de correrlo

- Todas las cuentas nuevas quedan con la MISMA contraseña temporal que escribiste — avísales
  a las personas para que la usen la primera vez, y si quieren cambiarla, usan el link de
  "¿Olvidaste tu contraseña?" en la pantalla de login (Firebase se encarga solo de mandarles
  el correo).
- Si alguien no tenía correo capturado en el Directorio, esa persona se salta — complétalo en
  Personal (en la app) y vuelve a correr el flujo para que se le cree la cuenta.
- Es seguro correrlo las veces que quieras: a quien ya tiene cuenta simplemente no lo toca.

## Diferencia con el robot de notificaciones

| | Notificaciones (`enviar.js`) | Crear cuentas (`crear-cuentas.js`) |
|---|---|---|
| Cuándo corre | Solo (cada 10 min) | Solo a mano ("Run workflow") |
| Qué hace | Manda avisos/recordatorios | Crea cuentas de acceso faltantes |
| Riesgo si se corre de más | Ninguno (no repite envíos) | Ninguno (no duplica cuentas existentes) |
