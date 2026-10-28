# Laboratorio E2E: sesiones, reproducción y nuevas lecturas

Fecha: 2026-10-28. Base inspeccionada `47fa26d2c`, rama
`feature/screenly-phase-0`. **Especificación preparada, ejecución bloqueada.**
No se implementa un runner ejecutable ni se inicia navegador, aplicación, DB,
almacenamiento o servicio. Los casos siguientes no son pruebas aprobadas.

## Entorno concreto que debe aprobar el responsable

Una instancia web exclusiva del laboratorio, con origen HTTPS y puerto elegidos
por el operador, un MySQL dedicado y el proveedor preparado según
[SCREENLY_LAB_MYSQL_PLAN.md](SCREENLY_LAB_MYSQL_PLAN.md) y
[SCREENLY_LAB_STORAGE_PLAN.md](SCREENLY_LAB_STORAGE_PLAN.md). No usar VPS,
dominios, cookies, secretos, base de datos o bucket de producción. El manifiesto
local de ejecución deberá identificar commit, origen, DB, proveedor y las claves
exactas de fixtures; sus valores reales y secretos se mantienen fuera de Git.

El ejecutor futuro debe exigir opt-in y una configuración explícita, sin fallback
a DATABASE_URL o bucket por defecto. Debe rechazar destino no aprobado antes de
conectar, fallar si faltan recursos y no aprovisionarlos automáticamente. Esta
comprobación aún no está implementada. El operador debe aprobar cómo identificará
inequívocamente los recursos de laboratorio, no solo que un hostname sea local.

El repositorio tiene `@playwright/test` en
`apps/chrome-extension/package.json`, resuelto a 1.61.1 en `bun.lock`, y
`apps/chrome-extension/playwright.config.ts`. Ese harness prueba la extensión,
no las rutas viewer web. No hay un harness navegador específico de estas rutas
preparado aquí. Reutilizar la versión ya fijada no autoriza ejecutar el script
de extensión, descargar Chromium ni añadir dependencias web. El operador debe
confirmar navegador disponible y aprobar el futuro runner/configuración web,
sin iniciar servidores desde el test ni configurar `webServer` implícito.

## Sesión real: contrato observado

`packages/database/auth/auth-options.ts::authOptions` usa
`session.strategy = "jwt"`; la tabla `sessions` no es la autoridad de la sesión
actual del navegador. `decodeSessionToken` consulta `users.authSessionVersion`
y rechaza una versión distinta o un usuario ausente. Por tanto, insertar filas
en sessions o adjuntar `CurrentUser` no demuestra autenticación real.

La cookie `next-auth.session-token` está configurada como HttpOnly, Secure,
SameSite=None y path `/`. El laboratorio necesita un origen HTTPS confiable
para el navegador; no desactivar Secure, TLS, validación de certificados o
CSRF para que pase un entorno HTTP mal configurado.

Propuesta inicial: cuatro cuentas sintéticas creadas por el operador de fixtures,
login real mediante el EmailProvider existente y cinco contextos de navegador
separados, incluido uno anónimo. El flujo pasa por la UI `/login` y el handler
`apps/web/app/api/auth/[...nextauth]/route.ts`, conserva los tokens CSRF y usa el
callback real de NextAuth. No fabricar JWT, copiar cookies de producción ni
inyectar servicios Effect en el runner E2E.

El OTP requiere una decisión adicional: usar la rama existente de
`sendVerificationRequest` con entrega no configurada, en una instancia aislada
aprobada, o un receptor de correo de laboratorio autorizado. La rama de consola
no es exclusiva de desarrollo: el código rechaza la falta de entrega cuando
NODE_ENV es production y NEXT_PUBLIC_IS_CAP es true; fuera de esa combinación
puede imprimir el OTP. Verificar los valores efectivos y la rama esperada antes
de arrancar; no cambiar NODE_ENV o IS_CAP para eludir una restricción de correo.
No contratar ni activar correo/SSO externo.

Los OTP y URLs de callback son secretos. La futura captura debe usar un pipe
privado de stdout del proceso de laboratorio, consumido únicamente en memoria
por el harness antes de cualquier tee, colector de logs o trazas. No heredar
stdout a la terminal ni escribirlo a archivos, reportes, grabaciones o chat.
Aplicar plazo de espera, descarte inmediato tras consumo/caducidad y errores
redactados. Esta captura no está implementada y requiere revisión y autorización
de inicio del proceso; si la plataforma conserva stdout antes del consumidor,
la vía de consola no es admisible y debe elegirse otro canal aprobado.
Si no existe una vía aprobada, la autenticación E2E queda bloqueada; no habilitar
trusted-proxy como bypass. Su proveedor requiere una frontera proxy real que
elimine cabeceras del cliente y no sirve para simular cinco identidades.

La contraseña de un vídeo es independiente de la sesión: probar la UI
`PasswordGate.tsx` y `actions/videos/password.ts::verifyVideoPassword`, que fija
`x-cap-password`. `lib/password-cookie.ts` cifra los hashes verificados; no
leerlos ni fabricar la cookie. `lib/server.ts::CookiePasswordAttachmentLive`
los añade a la política real en cada petición. El propietario puede omitir la
contraseña por diseño; usar miembro/grant para verificar su cambio.

## Fixtures y matriz de casos preparados

Usar un identificador de ejecución ficticio en el diseño, por ejemplo `lab_run`,
convertido por el operador en IDs válidos para las restricciones reales del
esquema. No ejecutar SQL genérico ni asumir que ese prefijo cabe en cada columna.
Se requieren owner, member, viewer-grant y outsider sin membresías/grants
alternativos, una organización de laboratorio, un vídeo privado y otro público,
versiones sintéticas de MP4/JPEG/GIF/VTT/MP3 y comentario vídeo con poster.
Cada archivo debe tener tamaño/hash independiente conocido. No basta reutilizar
el segmento fMP4 de un segundo como MP4 standalone; validar cada contenedor
destinado al reproductor antes de declararlo fixture de reproducción.

| ID de caso propuesto | Acción y criterio de aceptación                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E-AUTH-01          | Owner, member y viewer con grant abren vídeo privado; outsider y anónimo no reciben bytes ni URLs de origen. Anónimo accede al vídeo expresamente público si no hay restricciones adicionales.                                                                                     |
| E2E-MP4-01           | `/s/[videoId]` reproduce MP4 sintético; comprobar avance temporal y decodificación, junto con solicitudes a `/api/playback/mp4`, MIME y cuerpo esperado. Un 200 solo no prueba reproducción.                                                                                       |
| E2E-DER-01           | Mostrar miniatura/GIF y poster de comentario; cargar VTT con cues reconocibles y comprobar audio publicado. Cubrir los seis selectores de `/api/playback/resource` y sus aliases actuales.                                                                                         |
| E2E-REV-01           | Tras commit confirmado de retirada de membresía o grant, repetir URL exacta con GET/HEAD/Range/If-Range coincidente y obsoleto: nueva admisión 404 vacía, no lectura/firma/listado ni generación. Mantener cookie de sesión para aislar la revocación del permiso.                 |
| E2E-REV-02           | Público pasa a privado tras commit: el contexto anónimo conserva URL/ETag, pero nuevas solicitudes quedan denegadas.                                                                                                                                                               |
| E2E-PASS-01          | Miembro verifica contraseña real y obtiene acceso; después cambia el hash confirmado por el operador y la cookie anterior no permite una nueva lectura. Recuperar acceso solo mediante una nueva verificación válida.                                                              |
| E2E-HTTP-01          | Admitidos: GET 200, HEAD sin bytes, Range 206/416 y tratamiento de If-Range. Denegados antes de consultar storage; cinco directivas de caché privadas en errores y respuestas. Thumbnail JSON solo GET/HEAD.                                                                       |
| E2E-CACHE-01         | Repetir con caché del navegador habilitada; comprobar nueva solicitud del recurso y denegación tras revocar. Distinguir caché de red de imagen ya mostrada, Blob y copia descargada. Sin CDN real no acreditar comportamiento de CDN/proxy.                                        |
| E2E-DESC-01          | Conservar `screen` recibido de `/api/thumbnail`; retirar grant y seguir esa URL: vuelve a autorizar y deniega. Preview fallback OG solo prueba redirect relativo protegido, no protección transitiva de `/api/video/og`.                                                           |
| E2E-STREAM-01        | Con fuente de laboratorio suficientemente grande y lectura controlada, revocar tras admisión: nueva Range denegada; registrar qué bytes del stream original continúan. No exigir revocación retroactiva ni inferir cancelación remota de una muestra pequeña.                      |
| E2E-SESSION-01       | Logout mediante flujo real NextAuth con CSRF elimina la sesión del contexto; la siguiente petición privada se trata como anónima. No afirmar invalidación global del JWT capturado: es un escenario distinto, ligado a authSessionVersion y a su propia autorización de escritura. |

Una retirada debe observarse confirmada desde una conexión independiente antes
de lanzar la siguiente petición. El fixture controller necesita aprobación
específica de escrituras acotadas a los IDs de esa ejecución. Estas mutaciones
no quedan autorizadas por el diseño. No se usa retraso fijo como prueba de commit
ni se interpreta una caché React por petición como prueba de persistencia.

## Evidencia de cero almacenamiento y limpieza

Una respuesta 404 no demuestra por sí sola cero IO. La futura ejecución necesita
correlación por petición entre ruta, decisión y operaciones del cliente storage,
junto con auditoría de lectura del proveedor cuando esté disponible. Contar HEAD,
GET, firma, listado y generación; no basta comprobar que no hay una descarga en
el navegador. No desactivar storage para conseguir cero lecturas: eso convertiría
una denegación en un error de proveedor y dejaría el criterio sin verificar.

La instrumentación real necesaria no está implementada aquí. Su diseño/aplicación
requiere revisión separada, sin registrar cookies, Authorization, JWT, OTP,
contraseñas, URLs firmadas o mensajes brutos del proveedor. Guardar solo IDs de
caso/run, commit, conteos, estado HTTP, tamaño/hash y tiempos. Desactivar traces,
HAR, vídeos y screenshots con datos de autenticación; si se requieren después,
aprobar redacción y retención antes de capturarlos.

El navegador solo cierra sus contextos y temporales propios; la limpieza remota
la realiza un operador autorizado usando el inventario de IDs/versiones de esa
ejecución. Sin TRUNCATE, DELETE global, borrado por bucket o purga de recursos
ajenos. Conservar evidencia mínima y detenerse ante destino/fixture discrepante.

## Runners inspeccionados y estado de evidencia

- `__tests__/e2e/agent-local-e2e.test.ts`: `CAP_AGENT_E2E=1` activa un runner
  que asigna DATABASE_URL a una DB local por defecto; `seedDatabase` ejecuta
  TRUNCATE/DELETE y desactiva FOREIGN_KEY_CHECKS. Usa createServer, spawn y
  PutObject; simula password-cookie y otros servicios. No es reutilizable sin
  separación de preparación destructiva ni evidencia de sesión viewer real.
- `content-transfer-local-e2e.test.ts`: MySQL y múltiples PutObject; no ejecutar
  como sustituto de esta matriz ni asumir solo lectura por su nombre.
- `live-transcribe-local-e2e.test.ts` y `ai-provider-live-e2e.test.ts`: proveedores
  IA reales, crédito y/o escrituras en DB/bucket. No activar sus flags.

No se ejecutó ninguno. Las **315 pruebas de derivados y 636 de regresión** del
incremento previo usan DB/storage/sesión simulados. Las **nueve pruebas reales de
Drive** de `SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md` verificaron dos revisiones,
no login, revocación viewer o reproducción. No se repiten en esta preparación.

Condición de avance: aprobar origen/servicios, identidades de fixtures, login
sin bypass, navegador disponible, escrituras y limpieza acotadas e instrumentación.
Después implementar un runner nuevo optativo, revisarlo offline y autorizar su
ejecución separadamente. HLS completo permanece bloqueado por publicación/proxy:
ningún resultado MP4/derivados acredita revocación de enlaces HLS legacy.
