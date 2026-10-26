# Fase 1.5A — diseño de revocación segura

Estado: propuesta para aprobación, **sin implementación de revocación**.
Base: `27d52cdb70b22d0e9ab22f4d98f09d6dcd8b7467`, rama
`feature/screenly-phase-0`, 26 de octubre de 2026. PR #1 debe seguir en borrador.

Se consultaron `AGENTS.md`, `SCREENLY_SECURITY.md`, `SCREENLY_PHASE1_PRIVACY.md`,
`SCREENLY_PHASE1_3_LINKS.md` y `SCREENLY_PHASE1_4_CACHE.md`. La auditoría original
es histórica: el código ya crea vídeos privados y corrige caché, pero no revoca
capacidades bearer antiguas. No se modifican producción, esquemas, dependencias,
lockfiles, mecanismos internos, VPS ni migraciones en esta fase.

## 1. Arquitectura y riesgos actuales

La sesión NextAuth y `VideosPolicy.ts::decideCanView` permiten propietario,
membresías explícitas, grants de email y compartición pública con restricciones
heredadas de contraseña/dominio. `Videos.getByIdForViewing` conecta esa política
con las lecturas de aplicación. No se debe sustituir por comprobar solo
`video.public` ni solo la organización activa del usuario.

`S3BucketAccess.getSignedObjectUrl`, el proveedor CloudFront y el adaptador Drive
entregan capacidades independientes de esa sesión. El proxy `/api/storage/object`
elige `getTokenVideo` si el token coincide con ID y clave; esa rama consulta
existencia, no la política del espectador. Drive utiliza este token en sus URLs.
S3/CloudFront entregan directamente el objeto firmado. Un objeto de otro vídeo
no debe quedar autorizado por compartir prefijo parcialmente.

Riesgos confirmados por pruebas aisladas:

- Revocar membresía bloquea la URL normal, pero no el token firmado antiguo.
- Convertir un vídeo público en privado tampoco invalida ese token: una nueva
  prueba lo caracteriza mediante el handler real y la política real con fixtures.
- La firma propia no incorpora sujeto, sesión, finalidad ni versión de permiso.
  Conocer el ID solo no concede acceso en los endpoints probados; poseer la URL
  bearer sí, incluso sin sesión. El milisegundo exacto de expiración aún se acepta.
- Fase 1.4 evita caché de las respuestas de tres endpoints; no revoca firmas,
  purga cachés existentes ni impide almacenar bytes deliberadamente.

No se ha probado una filtración en la instalación real. No se conocen ACL, CDN,
retención, TTL máximos efectivos o credenciales de los buckets del VPS.

## 2. Matriz de mecanismos y consumidores

Los TTL siguientes son los defaults del código, no promesas de validez efectiva.
Los callers pueden sobrescribirlos; deben inventariarse antes del corte legacy.

| Mecanismo / generación                                                                  | Quién lo solicita y alcance                                                                                        | TTL / validación actual                                                                                                   | Revocación y consumidores                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Sesión NextAuth, `database/auth/auth-options.ts`                                        | Login habilitado; identidad de humano, no permiso universal                                                        | JWT con secreto de sesión y decoder propio; no se fija maxAge general aquí                                                | Logout local no invalida necesariamente copias del JWT; cada lectura necesita política/estado vigente; web y escritorio autenticado      |
| Token de objeto, `Storage/SignedObject.ts::createStorageObjectToken`                    | Backend al resolver URL Drive en `Storage/index.ts::createDriveObjectUrl`; ID y clave de objeto                    | 1 h; HMAC con `NEXTAUTH_SECRET`, expiración y comparación ID/clave en proxy; interno Drive usa 2 h                        | Sin registro/revocación individual ni sujeto; `/api/storage/object`, player, miniaturas y consumidores internos                          |
| S3 GET, `S3Buckets/S3BucketAccess.ts`                                                   | Código con acceso a bucket tras autorización del caller; un objeto                                                 | 1 h por defecto, SigV4; proveedor valida firma/fecha/credencial                                                           | MySQL no revoca la URL; player, previews, VTT, móvil, descargas y jobs; GET interno multimedia puede usar 3 h                            |
| CloudFront, `S3Buckets/index.ts`, `cloudfront-signed-url.ts`                            | Mismo contrato de lectura; recurso exacto y deadline                                                               | 1 h por defecto, policy firmada con key pair                                                                              | Cambiar membresía no invalida firma ni edge cache; requiere control en la ruta de entrega o invalidación de firma/distribución           |
| S3 PUT/POST/UploadPart, `S3BucketAccess.ts`, `Storage/index.ts`                         | Creadores/subidores autorizados por handlers, objeto o sesión multipart                                            | PUT/part usualmente 1 h; creación upload en Storage usa 30 min; rutas internas sobrescriben a 3 h                         | Credencial de escritura no es permiso de lectura; `api/upload/[...route]/multipart.ts`, desktop/GPUI, recorder web                       |
| Reupload desktop, `lib/desktop-reupload-token.ts`                                       | Sesión de propietario mediante multipart; propietario/vídeo, sourceIdentity, proveedor, uploadId y nueva outputKey | 30 días; HMAC con separación de dominio, Zod estricto, límites temporales y contraste de sesión/source                    | No es token de visionado; preservar continuidad de reemplazo e integridad, revisar cada endpoint de completar/abortar                    |
| Upload de medios de comentario, `Comments/CommentMediaToken.ts`                         | Endpoint autenticado de `api/upload/[...route]/comment-media.ts`; usuario, vídeo, comentario, claves y MIME        | 6 h; HMAC `comment-media:` separado, forma y expiración                                                                   | No revoca por espectador; `actions/videos/new-media-comment.ts` y finalización validan claims; no permitir intercambio con lectura       |
| Secret de media server, `lib/media-client.ts`, `media-server/src/lib/auth.ts`           | Backend que conoce `MEDIA_SERVER_WEBHOOK_SECRET`; operaciones y callbacks internos                                 | Sin TTL por request, header compartido; validadores de cada extremo                                                       | Rotación operativa amplia, no revocación de espectador; extracción, mux, thumbnails, transcripción y verificación                        |
| Descriptor interno, `storage/object/route.ts`, `media-server/src/lib/media-transfer.ts` | Requiere indicador interno, secret y autorización de objeto por su vía correspondiente                             | Depende de URL/descriptor emitido; headers y destinos restringidos; no-store                                              | No es autorización administrativa; puede contener URL/credenciales de transporte que nunca deben llegar al espectador                    |
| Señal Loom, `lib/loom-import-signal-token.ts`                                           | Workflow genera `loom-import:video:attempt`; progreso y señales de importación                                     | No HMAC ni deadline propio en esta función; prefijo comprobado                                                            | Identificador de correlación, **no** credencial autónoma de lectura; verificar autenticación de callbacks por separado                   |
| API key legacy, `web-backend/src/Auth.ts`, tabla `authApiKeys`                          | Usuario/dispositivo autorizado; identidad bearer mediante ID de 36 caracteres                                      | Consulta directa DB; esquema sin hash ni expiración                                                                       | Eliminación de fila retira identidad, no URLs ya firmadas; no adoptar como nueva credencial administrativa                               |
| Agente, `lib/agent-token.ts`, `agent-auth.ts`                                           | Intercambio de código y scopes; CLI/API autenticada                                                                | Nuevas claves 90 días; hash, expiresAt, revokedAt y scopes en DB                                                          | Revocación de clave no revoca automáticamente S3 ya emitidas; aplicar también política del vídeo a cada recurso                          |
| MCP OAuth, `lib/mcp-auth.ts`                                                            | Cliente registrado y consentimiento `caps:read`                                                                    | Código 5 min, access 1 h, refresh 30 días; hashes, expiración, revokedAt y rotación de refresh                            | Revalidar identidad y scopes por petición; no convertir el token MCP en capacidad genérica del bucket                                    |
| Enlace compartido `/s/ID`, `actions/caps/share.ts`, viewer grants                       | Propietario/actor autorizado configura visibilidad y destinatarios                                                 | ID sin TTL no es secreto; `VideosPolicy` resuelve reglas actuales                                                         | Revocable mediante reglas si se consulta política; no basta para invalidar URLs directas entregadas antes                                |
| Contraseñas, `actions/videos/password.ts`, `lib/password-cookie.ts`                     | Verificación de contraseña actual; cookie `x-cap-password` guarda hashes cifrados, no plaintext                    | Cookie de sesión, HttpOnly/SameSite/Secure en producción; `Video.verifyPasswordCandidates` compara contra hashes vigentes | Cambio de hash invalida la comprobación de política antigua; no invalida bearer del objeto; incluye contraseñas heredadas de colecciones |

Otros flujos con firmas —BAA, instaladores/actualizador, OAuth de integraciones,
SDK comercial `developer_videos`— son dominios distintos. No se reutilizan sus
credenciales ni se declara auditada toda su superficie. La separación debe
abarcar también URLs emitidas por móvil, acciones server y API v1, no solo el player.

## 3. Comparación de alternativas

| Alternativa                                  | Seguridad/revocación                                                                              | Coste/latencia y complejidad                                                  | Multimedia, escala y compatibilidad                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A: proxy con política en cada petición       | Retirada efectiva en nueva admisión tras commit, si lee estado fresco y no filtra URL directa     | Lookup por request, ancho de banda del proxy; complejidad media               | Compatible MP4/Range/HEAD/HLS y S3/MinIO; requiere streaming, pooling y capacidad de egress                        |
| B: viewer token corto autónomo               | Limita ventana, no revoca al instante; replay en otro navegador mientras sea bearer               | Validación local barata, renovación y coordinación de player                  | Fácil HLS, pero token en playlist/URL puede filtrarse; Range nuevo sigue permitido hasta expirar                   |
| C: access epochs                             | Invalida todos los permisos derivados que incluyan epoch anterior **si se consulta** epoch actual | Estado y mutaciones atómicas; caché de epoch introduce ventana                | Útil para contraseña/visibilidad; solo epoch de vídeo no cubre revocar un miembro de una org; no afecta S3 directa |
| D: registro de capacidades                   | Revocación individual por token/job/sesión, auditable                                             | Lookup, almacenamiento, limpieza, concurrencia y renovación; complejidad alta | Bueno para jobs; registro no sirve si la URL final evita el validador                                              |
| E: A + grants/versiones acotadas + D interno | Mejor separación y retirada por política; tokens no sustituyen permisos                           | Coste de proxy y estado donde aporta control; implementación gradual          | Recomendado: formatos estables y almacenamiento intercambiable, exige migrar todos los emisores de URL             |

No elegir B como solución de revocación efectiva. C o D sin un punto de control
en **todas** las lecturas tampoco solucionan los enlaces S3/CloudFront.

## 4. Arquitectura recomendada: E con A como base

### 4.1 Espectadores y propietarios

El navegador recibe URLs estables de un proxy de medios Screenly; no URLs directas
S3/CloudFront/Drive. Por cada GET/HEAD/Range y cada playlist/segmento:

1. Normalizar ID y recurso lógico permitido; resolver la fila mínima y su estado
   actual. No enumerar objetos ni firmar destinos antes de autorizar.
2. Resolver principal: sesión humana vigente o identidad automatizada con scopes;
   comprobar organización/tombstone, vídeo eliminado y política actual.
3. Aplicar la política existente, preservando propietario, grants, organización,
   espacios y contraseñas heredadas. El propietario no necesita membresía de
   espectador, pero una cuenta/sesión revocada o vídeo borrado no obtiene bypass.
4. Resolver **server-side** la clave permitida por ese recurso/vídeo. No aceptar
   una ruta arbitraria como permiso; verificar objeto publicado actual y prefijo.
5. Leer storage internamente y transmitir sin materializar el archivo completo,
   sin redirect al objeto ni credenciales en JSON/headers. Mantener no-store.

Las credenciales S3 solo residen en servidor/worker. Una URL de origen usada
internamente no debe aparecer en Location, playlist, VTT, logs o error al cliente.
Las reglas públicas se evalúan de nuevo en cada request; público → privado debe
bloquear nuevas lecturas anónimas incluso desde una pestaña anterior.

### 4.2 Compartición explícita y versiones

Para destinatarios identificados usar sesión y grants actuales. Para enlaces con
contraseña/invitados, establecer un grant de reproducción ligado a un navegador
mediante cookie HttpOnly Secure, con sesión aleatoria opaca (hash en registro),
vídeo y versión de acceso. No ligar solo a IP o User-Agent ni poner el secreto
de sesión en la URL. El enlace inicial es bootstrap sujeto a las reglas del vídeo;
el consentimiento para compartir debe ser explícito. Copiar solo la URL no
transfiere la sesión; robar también la cookie sigue siendo un compromiso de
credenciales, no resuelto por este vínculo.

Propuesta posterior de estado: `videoAccessEpoch`, epoch de contraseña/colección
cuando corresponda y grants revocables de reproducción con sujeto/sesión,
expiración y revokedAt. Son campos/tablas **propuestos**, no creados aquí.
Incrementar epochs en la misma transacción que cambios relevantes. Revalidar
siempre membresías/grants actuales: no intentar representar todos los cambios
de organización exclusivamente con un contador de vídeo. Tokens cortos, si se
usan para bootstrap/renovación, no conceden lectura sin sesión y comprobación.

En 1.5B inicial se puede implementar A para sesiones sin tocar schema; el registro
y epochs requieren otro incremento y autorización específica de migraciones.

### 4.3 Qué significa retirada efectiva

Contrato propuesto inicial: tras confirmar una mutación de permisos, **la siguiente
petición admitida** debe leer permisos frescos del almacén autoritativo y denegar
sin contactar origen. No usar caché positiva ni réplicas con lag para esa decisión;
si DB no está disponible, fallar cerrado (503) sin contenido. Invalidación de
caché por evento, por sí sola, no demuestra esta garantía.

No se promete borrar buffers del player ni bytes ya entregados. Una descarga
MP4 larga ya autorizada puede seguir abierta; para limitarla, la fase posterior
debe cortar/revalidar streams por intervalo/bytes y señales de revocación. Medir
y fijar ese límite antes de prometer retirada durante una conexión existente.
HLS limita nuevas lecturas por segmento, pero quedan segmentos ya descargados.
No hay pruebas en esta fase que demuestren revocación inmediata real.

## 5. Separación estricta de credenciales

| Clase          | Principal/alcance propuestos                                                                            | Validación y retirada                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Visionado      | Humano, propietario o miembro + sesión y vídeo                                                          | Política actual siempre; grants de invitado ligados a navegador, sin bypass con token de objeto legacy                                          |
| Upload         | Usuario y sesión multipart/recording; operaciones create/part/complete/abort y claves concretas         | Mantener checks de propietario/sourceIdentity y límites; perder permiso de espectador no cancela automáticamente una subida propia autorizada   |
| Procesamiento  | Identidad de servicio + jobId/attemptId; entradas/salidas exactas y operaciones read/write por separado | Token con versión, audience, purpose, exp, jti y clave propia; comprobar estado del trabajo; renovación controlada, no renovar un job cancelado |
| API/agentes    | Identidad y scopes del token API + política del recurso                                                 | No aceptar su token como secret de media server; no entregar capacidades permanentes de storage                                                 |
| Administración | Rol explícito, operación administrativa y auditoría                                                     | No convertir una clave de worker o upload en admin; rutas separadas y mínimo privilegio                                                         |

Para trabajos internos se recomienda registro de capacidades con hash y
revokedAt/attempt actual, distinto del registro de grants humanos. TTL propuesto
corto renovable, dimensionado con mediciones: no sustituir ciegamente tres horas
por un minuto y romper FFmpeg. Firma con claves/IDs y dominios separados del
secreto NextAuth; negar audience o método incorrecto. No compartir una firma
genérica entre subir, ver y procesar. Job recibe únicamente inputs/outputs de
ese intento, sin listado libre de bucket. Callbacks son otro permiso.

Retirar un espectador no cancela un trabajo autorizado. Borrado del vídeo sí debe
cancelar lecturas/escrituras del job y sus credenciales; cleanup requiere una
capacidad administrativa de borrado separada. Comprobar tombstone y job state al
admitir, renovar y publicar resultados para no resucitar vídeos eliminados.

## 6. Contrato de compatibilidad multimedia

- MP4: conservar 200/206/416, Range, Content-Range, Content-Length, Accept-Ranges,
  tipo MIME y ETag, sin compresión o buffering que invalide offsets; validar If-Range
  y saltos de búsqueda. HEAD no lee el cuerpo y autoriza antes de metadatos.
- HLS: reescribir todas las URI: masters, audio/vídeo, segmentos, init maps,
  claves de cifrado si existen y referencias relativas. Ninguna puede saltarse
  el proxy. No limitarse a proteger el master y dejar segmentos firmados directos.
- Subtítulos, thumbnails, GIF, audio levels y medios de comentarios usan la misma
  decisión de vídeo; transcript editable sigue en una ruta específica autorizada.
- Grabación progresiva: preservar estados en curso/readiness, orden de segmentos,
  publicación atómica, reintentos y recuperación; no usar permiso de viewer como
  condición de finalización de una captura del propietario.
- Workers obtienen medios por la interfaz interna, sin cookies humanas. Transcripción,
  generación de thumbnails y export usan jobs y capacidad de servicio; no requieren
  una sesión de espectador activa.
- Clientes externos: los tags video/audio/img y HLS deben enviar las credenciales
  apropiadas. Preferir mismo origen; si móvil/escritorio usa otro origen, definir
  autorización por header y CORS estricto, no degradar a URL bearer sin revocación.

## 7. Archivos que cambiarían en 1.5B

| Archivos/familia                                                                                                             | Cambio propuesto                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/web-backend/src/Storage/SignedObject.ts`, `Storage/index.ts`                                                       | Separar emisores viewer/interno y validación de claims; no eliminar legacy antes de migrar workers                                  |
| `S3Buckets/S3BucketAccess.ts`, `S3Buckets/index.ts`, `Storage/GoogleDrive.ts`                                                | Lectura de origen server-side y firma solo interna; conservar upload; contratos de streaming por proveedor                          |
| `apps/web/app/api/storage/object/route.ts`                                                                                   | Revalidar principal viewer; ruta/propósito interno separado; impedir bypass legacy en modo viewer; Range/HEAD y recursos permitidos |
| `app/api/thumbnail/route.ts`, `app/api/video/preview/route.ts`                                                               | Devolver URL del proxy protegido o bytes, no capacidad del origen                                                                   |
| `app/api/playlist/route.ts`                                                                                                  | Todas las URI protegidas, incluidas rutas legacy y segmentos en curso                                                               |
| `packages/web-backend/src/Videos/VideosPolicy.ts`, `Videos/index.ts`, `VideosRepo.ts`                                        | Centralizar decisión fresca, existencia/tombstone y autorización antes de resolver storage                                          |
| `packages/database/schema.ts` y nuevos artefactos generados                                                                  | Solo en incremento aprobado aparte: grants/epochs/estado de jobs; nada generado en 1.5A                                             |
| `actions/caps/share.ts`, `actions/videos/password.ts`, `actions/collections/password.ts`, `actions/videos/viewer-invites.ts` | Actualizaciones atómicas de versiones/revocación donde se introduzca estado                                                         |
| Mutadores de organización/espacio y borrado, workflows de transferencia                                                      | Revalidar membresía vigente y cancelar jobs al borrar; inventariar todos los paths de mutación, no solo UI                          |
| `lib/media-client.ts`, `media-server/src/lib/auth.ts`, `lib/media-transfer.ts`, callbacks/workflows                          | Identidad por servicio/trabajo y renovación; preservar límites de origen y anti-redirect de credenciales                            |
| `api/upload/[...route]/multipart.ts`, `comment-media.ts`, `lib/desktop-reupload-token.ts`                                    | Mantener separación de escritura y asegurar que nuevos tokens no se aceptan para lectura ni viceversa                               |
| `api/mobile/[...route]/route.ts`, `api/v1/[...route]/route.ts`, acciones y `lib/comment-media.ts`                            | Dejar de emitir URLs directas a humanos y agentes; actualizar contratos/consumidores                                                |
| `api/mcp`, `lib/mcp-auth.ts`, `lib/agent-auth.ts`, backend Auth                                                              | Identidad/scopes revocables + política de vídeo; no reutilizar legacy key como admin                                                |
| Componentes player/preview/editor, SDK/GPUI/CLI consumidores afectados                                                       | Compatibilidad de cookies/header, renovación y manejo de 401/403/404 sin loops                                                      |
| Tests de perfiles, tokens, multipart, player y proveedores                                                                   | Seguridad negativa y continuidad multimedia, incluido replay legacy                                                                 |

Los nombres de rutas nuevas, claims y tablas se fijarán en 1.5B antes del primer
commit funcional; no se modifican bindings generados manualmente.

## 8. Migración sin pérdida de datos

1. Inventariar emisores de URLs y duraciones máximas reales, identidades de firma,
   CDN y cachés. No asumir que el máximo legacy es una hora; existen overrides
   y tokens de upload de larga duración. No registrar valores de firmas.
2. Introducir contratos/validadores separados e interfaz interna compatible;
   probar workers antes de cambiar el tráfico de espectadores.
3. Si se aprueba estado nuevo, migración aditiva generada con Drizzle, backup y
   restauración probados en entorno aislado; no reescribir ni borrar objetos.
4. Cambiar emisores viewer y playlists, con prueba de que ningún redirect/JSON
   revela origen. Desactivar emisión legacy para nuevos espectadores.
5. Drenar o reemitir capacidades de trabajos activos. Registrar cuáles siguen
   usando el esquema antiguo; no revocarlas por accidente con claves humanas.
6. Cerrar bypass viewer legacy tras comprobar compatibilidad interna. Un feature
   flag no puede dar fallback silencioso a la rama insegura al fallar DB.
7. Tratar enlaces directos ya entregados: esperar una caducidad máxima comprobada
   o retirar permisos/claves/distribución antigua con operación autorizada y
   pruebas reales. Si espectadores y workers compartían firmante, no es posible
   distinguirlos retroactivamente: drenar/renovar trabajos antes del corte global.
   S3, CloudFront y caché requieren medidas propias y verificación de origen.
8. Mantener medios y copias de seguridad privados; rollback funcional no debe
   reactivar acceso legacy viewer. Ante fallo del proxy, fallar cerrado o pausar
   reproducción. No proclamar revocación hasta cerrar rutas directas antiguas.

No se ejecuta ninguno de estos pasos operativos en 1.5A. Tampoco se generan
migraciones. Las pruebas de MySQL/S3/MinIO esperan un entorno autorizado.

## 9. Plan de pruebas de aceptación de 1.5B

En todos los casos denegados verificar cero bytes, Location o URL de origen,
cero lecturas/firma/listado de storage previo a autorización y respuesta no-store.
Separar pruebas unitarias, handlers con fixtures y E2E/proveedor real.

| Escenario                               | Resultado esperado del diseño / nivel necesario                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1. Usuario autorizado                   | MP4, HLS, thumbnail y VTT disponibles; owner y miembro cubiertos por separado                                           |
| 2. Revocar membresía durante playback   | Tras commit, próxima admisión denegada; medir por separado stream abierto y buffers; concurrencia con MySQL real        |
| 3. Token antiguo                        | No permite lectura viewer sin sesión/política actual; rechazar epoch/grant revocado                                     |
| 4. Otro navegador                       | Copiar URL no copia la cookie HttpOnly de grant; requiere autenticación/compartición explícita propia                   |
| 5. Cambiar contraseña                   | Grants y cookies de contraseña antigua no desbloquean nuevas lecturas; mantener bypass de propietario según política    |
| 6. Público a privado                    | Pestaña anónima antigua y cada URI HLS denegadas; login/owner funciona                                                  |
| 7. Eliminar vídeo                       | Existencia/tombstone deniega viewer y job; finalización concurrente no repone publicación                               |
| 8. Caducar token                        | Límite `now >= exp`, reloj controlado, token futuro/inválido y renovación con sesión revocada denegados                 |
| 9. Range                                | 206/416 correctos, If-Range, saltos; repetir Range tras revocar deniega sin leer bytes                                  |
| 10. HEAD                                | Metadatos sin cuerpo solo tras autorizar; ninguna filtración por status de origen                                       |
| 11. HLS                                 | Masters, variantes, init, audio y segmentos: cada lectura autorizada; no URI de origen ni bypass por ruta relativa      |
| 12. Derivados                           | JPEG/GIF/VTT/audio-levels/comentarios con política vigente; JSON editable no expuesto genéricamente                     |
| 13. S3/CloudFront antiguos              | Reutilizarlos contra proveedor real tras el corte debe fallar; no simular esto solo cambiando filas MySQL               |
| 14. Job interno tras revocar espectador | Mux/upload/transcripción continúan con capacidad propia; token viewer no invoca API interna, job cancelado no renueva   |
| 15. Objeto de otro vídeo                | ID/clave/audience/método alterados, prefijos ambiguos y traversal fallan antes de storage                               |
| Infra caída                             | DB/job registry no disponible: sin fallback a public o URL legacy; medir latencia y recuperación                        |
| Caché y carreras                        | No stale allow tras cambios; headers/error/redirect/HEAD preservados; probar CDN/navegador real y transición simultánea |

Pruebas actuales reutilizadas: `private-resource-authorization`, `videos-policy`,
`desktop-reupload-token`, `comment-media-token`, `agent-auth`, `mcp-auth`,
`s3-bucket-access` y `cloudfront-signed-url`. No confundir sus fixtures con pruebas
de revocación de una instalación real.

## 10. Commits pequeños propuestos para 1.5B

1. Contratos y pruebas negativas: clases de principal/propósito, mapa de recursos,
   garantías de siguiente petición y compatibilidad legacy explícita; sin activar.
2. Capacidad interna diferenciada y validadores, conservando upload/reupload;
   tests de audience, método, job/attempt y dominios criptográficos.
3. Migrar un consumidor interno (por ejemplo extracción de audio) y probar fallo,
   reintento, expiración y renovación; extender a mux/thumbnail/transcripción.
4. Proxy viewer MP4/HEAD/Range con política fresca y sin redirect; pruebas de
   revocación de miembro y propietario, luego pruebas de bytes con proveedor aislado.
5. Thumbnail/GIF/VTT/comentarios por el proxy; eliminar URLs de origen de respuestas
   viewer, preservando no-store y estados anteriores.
6. HLS completo y grabación progresiva; pruebas de reproducción/búsqueda y URI
   alternativas. Extender a móvil/API/agentes sin convertirlos en workers.
7. Solo con aprobación de esquema: registro/epochs para invitados y jobs;
   migración generada y pruebas transaccionales. Puede dividirse por tabla/flujo.
8. Cierre legacy, procedimiento de corte de firmas/CDN y verificación real
   autorizada; no activar públicamente antes de cumplir la matriz de pruebas.

Cada commit incluye sus regresiones y checks de AGENTS. Detener rollout si faltan
garantías de storage/origen; no agrupar despliegue ni cambios de VPS con estos commits.

## 11. Evidencia de 1.5A y riesgos residuales

Se añadió únicamente una caracterización pública → privada con token antiguo;
el comportamiento inseguro sigue presente deliberadamente. La batería indicada
aprobó **199 pruebas en ocho archivos** con Bun 1.4.4. No hay nuevas dependencias,
schema o migraciones. Pruebas seguras sin puertos/servicios/API de pago:

```bash
bun run --cwd apps/web test __tests__/unit/private-resource-authorization.test.ts __tests__/unit/desktop-reupload-token.test.ts __tests__/unit/comment-media-token.test.ts __tests__/unit/agent-auth.test.ts __tests__/unit/mcp-auth.test.ts __tests__/unit/s3-bucket-access.test.ts __tests__/unit/cloudfront-signed-url.test.ts __tests__/unit/videos-policy.test.ts
```

El typecheck completo aprobó (`next typegen` y `tsc-rs -b`).
Biome aprobó el test modificado, Prettier el documento y Git el diff.
Persisten riesgos de copia local, buffering, capacidades directas legacy,
almacenamiento/CDN desconocidos, endpoints aún no migrados y abuso de recursos.
La futura interfaz añade ancho de banda/consultas y necesita medición; no se
estima capacidad del VPS sin inspección autorizada. La separación no resuelve
por sí sola vulnerabilidades de dependencias ni exposición de credenciales en logs.

**Punto de parada: solicitar aprobación del diseño antes de 1.5B.** Este documento
no autoriza despliegue, migración, distribución ni implementación de los mecanismos.
