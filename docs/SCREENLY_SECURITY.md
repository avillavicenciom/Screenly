# Screenly — seguridad, dependencias y licencias

Auditoría estática y pruebas específicas del 26 de octubre de 2026.
No es un pentest ni certifica el despliegue: no se accedió al VPS, buckets reales,
credenciales o infraestructura. No se reproducen secretos en esta documentación.

## Hallazgos priorizados

| ID / prioridad                    | Evidencia                                                                                                                                 | Consecuencia y siguiente acción                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-01 / alta                     | `schema.ts::videos.public` usa `default(true)`; `packages/env/server.ts` define `CAP_VIDEOS_DEFAULT_PUBLIC` con true                      | Incompatible con garantía privada por defecto. Revisar todas las creaciones, defaults y políticas de organización; migración solo tras inventario/aprobación |
| SEC-02 / alta                     | Avisos npm para Next 16.3.0, NextAuth 4.24.14 y Drizzle 0.44.6                                                                            | Evaluar rangos y exposición, actualizar en tarea separada con regresiones; no cambiar locks en esta auditoría                                                |
| SEC-03 / alta                     | `packages/database/schema.ts::authApiKeys` almacena ID bearer; `web-backend/src/Auth.ts::HttpAuthMiddlewareLive` lo consulta directamente | Clave legacy sin hash/expiración en ese esquema. Migrar hacia hash, scopes, revocación/TTL; no confundir con `agentApiKeys`, que sí los modela               |
| SEC-04 / alta antes de distribuir | GPUI conserva identidad y endpoint de updater de Cap                                                                                      | Definir identidad y claves propias Screenly, conservar minisign; no distribuir apuntando al canal upstream                                                   |
| SEC-05 / media-alta               | `auth-options.ts` imprime OTP/email si email está deshabilitado en self-host; trusted proxy opcional                                      | Logs dan acceso a códigos durante su vigencia. Restringir logs y configurar entrega segura; proxy debe retirar cabeceras del cliente y aislar origen         |
| SEC-06 / media                    | `apps/media-server/src/lib/auth.ts::canReadStatus` permite estado público por defecto                                                     | Revisar información expuesta y configurar estado privado/red interna; operaciones de escritura sí exigen secret                                              |
| SEC-07 / media                    | Descarga Whisper `write_whisper_parts` sin hash fijado identificado                                                                       | Pin de artefacto/hash y staging atómico; el tamaño por sí solo no autentica contenido                                                                        |
| SEC-08 / pendiente                | Muchas rutas de objetos/preview/HLS/VTT y contratos legacy                                                                                | Completar matriz de permisos por endpoint; no se ha demostrado un bypass concreto de vídeo privado                                                           |

Estos hallazgos distinguen decisiones inseguras para el objetivo privado de
exploits confirmados. Un aviso de dependencia no prueba explotabilidad del
despliegue, y una prueba de política aprobada no certifica todas las rutas.

## Autenticación y autorización trazadas

`packages/database/auth/auth-options.ts` integra NextAuth con email, Google,
Apple, WorkOS/OIDC y trusted proxy; existen comprobaciones de correo y dominios.
`web-backend/src/Auth.ts::getCurrentUser` incorpora rechazo de escrituras
cross-site por cookie. `apps/web/lib/agent-auth.ts` y `mcp-auth.ts` exponen otras
superficies de autenticación: deshabilitar lo no requerido tras revisar contratos.

`VideosPolicy.ts::decideCanView` trata propietario, membresías de organización y
espacio, grants de email, visibilidad y contraseña. `buildCanView` devuelve true
si no existe el vídeo; esto no entrega datos por sí solo, pero exige que los
callers mantengan not-found y no firmen rutas construidas solo desde el ID.
Comprobar ese comportamiento al ampliar endpoints.

`getNewVideoPublic` en `packages/database/video-sharing-default.ts` respeta el
default privado de organización y la variable global. Configurar esa variable
no basta para probar todos los caminos de creación o reparar vídeos ya públicos.
`public-share-video.ts` excluye contenido privado, contraseñas heredadas, dominios
y subidas activas en la ruta de metadatos públicos inspeccionada.

El acceso debe autorizarse también para MP4, playlists/segmentos HLS, posters,
miniaturas, captions, transcript, resúmenes, comentarios, descargas y búsqueda.
Un bucket público o URL duradera puede eludir una página protegida; revisar ACL,
TTL, caché y revocación de enlaces con un despliegue controlado posterior.

## Credenciales, archivos y APIs

`packages/database/crypto.ts` cifra secretos con AES-GCM y deriva claves con
PBKDF2. `password-cookie.ts` usa cookie cifrada, HttpOnly, SameSite y Secure en
producción. Esto no sustituye control de acceso al almacén y rotación de claves.

`agentApiKeys` guarda hash, scopes, expiración y revocación; la tabla legacy
`authApiKeys` no ofrece las mismas garantías. Los ficheros de sesión del cliente
y sus permisos de disco requieren validación en Windows; no se inspeccionaron
credenciales personales. Los defaults de Docker Compose son de desarrollo:
reemplazarlos y no exponer puertos de DB/storage en un despliegue privado.

Media server exige `MEDIA_SERVER_WEBHOOK_SECRET` en operaciones protegidas;
la comparación actual es igualdad de string, no timing-safe. Mantenerlo interno
y considerar comparación constante. `media-transfer.ts` restringe descriptor
local y destino Drive y usa redirects limitados; conserva también fetch de
URLs externas. Falta demostrar protección SSRF completa en todas las rutas,
incluidos redirecciones, DNS, IP privadas y protocolos de herramientas multimedia.
`loom-download-url.ts` aplica restricciones Loom, sin cubrir el resto del sistema.

Las URLs firmadas son credenciales temporales: no copiarlas a logs o documentos.
Mantener aislamiento de trabajadores y límites de recursos para archivos hostiles,
timeouts y limpieza. `video-input-validation.ts::validateVideoInput` decodifica
con FFmpeg y detecta error; no es un sandbox contra una vulnerabilidad del decoder.
`recording-preverify.ts` autentica pruebas de fragmentos mediante HMAC; 13 pruebas
verifican manipulación/lecturas acotadas. No sustituye verificación de fuente.

No se encontraron credenciales añadidas en los seis documentos; la revisión de
patrones y contenido publicado se limita a este cambio. No se declara limpio todo
el historial Git ni todas las dependencias de secretos preexistentes.

## Auditoría de dependencias

Se ejecutó `bun audit --json` en la raíz, sin `fix`; salida **1**.
El registro respondió 62 nombres de paquetes y 291 entradas de avisos (15
critical, 115 high, 132 moderate, 29 low), 256 URLs de advisory distintas.
Son entradas crudas del registro: no son 291 vulnerabilidades explotables
confirmadas ni todas afectan a cada versión instalada. Ejemplo: el aviso crítico
Vitest `<3.2.6` no incluye el runner instalado **3.2.6**.

Rangos concretos cotejados con paquetes instalados:

| Paquete instalado | Aviso recibido                                                           | Rango recibido / evaluación                                                                                 |
| ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Next 16.3.0       | [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36) | `>=16.0.0 <16.3.3`: incluido; RCE descrita para servidor Windows, no certifica exposición del VPS           |
| Next 16.3.0       | [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) | `>=16.0.0 <16.3.8`: incluido; revisar optimización de imágenes/SSRF                                         |
| NextAuth 4.24.14  | [GHSA-7rqj-j65f-68wh](https://github.com/advisories/GHSA-7rqj-j65f-68wh) | `>=4.10.3 <4.24.15`: incluido; normalización email                                                          |
| Drizzle 0.44.6    | [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) | `<0.45.2`: incluido; revisar identificadores SQL dinámicos                                                  |
| DOMPurify 3.4.11  | Avisos de sanitización presentes en el resultado                         | Incluido también en el rango crítico `>=3.4.4 <=3.4.16` de GHSA-cg2g-xh64-v4q7; revisar configuración y uso |

Conservar lockfiles ahora. En una tarea autorizada: guardar SBOM, filtrar por
versión y dependencia de producción/desarrollo, trazar alcanzabilidad y aplicar
actualizaciones con pruebas. No se ejecutó `cargo audit`/RustSec: falta toolchain
preparado y deben revisarse por separado los dos workspaces, forks Git y binarios
FFmpeg/ONNX. No afirmar ausencia de vulnerabilidades Rust o nativas.

## Licencias y producto privado

`LICENSE` reserva MIT para familias `cap-camera*` y `scap-*`, conserva licencias
de terceros y aplica AGPLv3 al resto. `licenses/LICENSE-MIT` contiene el texto MIT.
No extrapolar la excepción MIT a todo procesamiento multimedia ni al cliente UI.

Uso privado no equivale a permiso para convertir el derivado en software
propietario. Distribuir binarios modificados AGPL obliga, según el caso, a ofrecer
fuente correspondiente y avisos a destinatarios; la sección 13 aborda usuarios
que interactúan por red con versiones modificadas. Un repositorio privado no
satisface por sí solo esas obligaciones frente a usuarios que deben recibir
acceso al código. Definir usuarios/destinatarios y distribución con asesoramiento
jurídico antes de lanzar, o negociar licencia alternativa con titulares si procede.
No es necesario publicar datos privados de vídeos para cumplir licencias.

Mantener avisos, inventariar licencias de GPUI/Zed y forks, FFmpeg y opciones de
compilación, codecs/patentes, ONNX, modelos y recursos gráficos. No reutilizar
marcas, firmas ni claves de Cap. Esta auditoría identifica obligaciones a revisar;
no emite una opinión legal sobre un modelo de distribución aún no definido.

## Evidencia de pruebas

`share-cap-authorization` 12, `public-share-video` 8, `s3-bucket-access` 5,
`agent-auth` 10 y `multipart-presign` 38 casos aprobados. `media-transfer` 16 y
`recording-preverify` 13 aprobados. No prueban acceso contra buckets reales,
revocación de CDN, configuración TLS/headers del VPS ni ataques en producción.
