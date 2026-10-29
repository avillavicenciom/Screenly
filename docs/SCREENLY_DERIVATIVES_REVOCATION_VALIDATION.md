# Revocación de recursos derivados y requisitos de validación real

Fecha: 2026-10-27. Rama `feature/screenly-phase-0`, base `4e4142eb5`.
Alcance autorizado: pruebas y documentación. No se modifica comportamiento
productivo, no se activa el proxy HLS y se detiene tras este incremento.

Cierre de revisión y publicación: 2026-10-28. La comprobación final repite
636 pruebas aprobadas y nueve live omitidas en 4,87 s; el typecheck conserva
cero errores, 56 avisos y 118 sugerencias Effect. La revisión independiente
final del documento no encuentra bloqueos; no añade ejecuciones de pruebas.

## Alcance, coordinación y criterios

Este incremento extiende la evidencia de revocación MP4 de
[SCREENLY_HLS_VIEWER_REVOCATION_VALIDATION.md](SCREENLY_HLS_VIEWER_REVOCATION_VALIDATION.md)
a recursos derivados existentes. El coordinador verificó rama, HEAD y árbol
inicialmente limpio; cada agente leyó las instrucciones aplicables.

| Responsable | Tarea                         | Archivos y exclusión                                                                                |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Subagente 1 | Perfiles, grants y revocación | Primer editor exclusivo de `apps/web/__tests__/unit/viewer-derivatives.test.ts`                     |
| Subagente 2 | HTTP, caché y streaming       | Inspección inicial sin editar; toma el mismo archivo solo tras el handoff explícito del coordinador |
| Subagente 3 | Requisitos y documentación    | Editor exclusivo de este documento                                                                  |
| Subagente 4 | Auditoría independiente       | Solo lectura, revisión del diff y checks offline específicos                                        |
| Coordinador | Integración y publicación     | Validación conjunta, commits, push y actualización de PR; sin edición simultánea del harness        |

Criterios: acceso previo correcto con política real; tras cambiar un permiso,
denegación de nuevas solicitudes antes de adquirir almacenamiento, leer, listar,
firmar o generar recursos; cuerpo vacío y caché privada en denegaciones; ausencia
de URLs de origen o credenciales en respuestas. GET, HEAD, Range e If-Range se
prueban donde el contrato los admite. No se atribuye soporte Range a un
descriptor JSON solo por compartir infraestructura con un stream.

Retirar una vía de acceso solo implica denegación si no existe otra válida.
Los grants se prueban con identidad diferenciada y sin membresía alternativa.
Cambiar contraseña debe volver a comprobarse aunque siga existiendo membresía.

## Rutas reales, resolución y consumidores

`apps/web/app/api/playback/resource/route.ts` conecta
`derivativeResponse` de `apps/web/lib/viewer-derivatives.ts` mediante
`viewerMediaApi`. Las rutas de compatibilidad thumbnail y preview usan el mismo
respondedor con un selector fijo. El cliente no proporciona key, bucket u origen.

| Ruta o selector                                       | Recurso / resolución actual                                                            | Consumidores y referencias                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/playback/resource?videoId=…&resource=thumbnail` | Miniatura publicada o screenshot validado JPEG/PNG                                     | `Videos.getThumbnailURL` en `packages/web-backend/src/Videos/index.ts`, `VideosRpcs.ts`, `apps/web/lib/Requests/ThumbnailRequest.ts`, `apps/web/components/VideoThumbnail.tsx` |
| `resource=preview`                                    | GIF bajo preview o salida publicada                                                    | Alias `/api/video/preview`; `VideoThumbnail.tsx` y `apps/web/app/s/[videoId]/_components/VideoPreviewGif.tsx`                                                                  |
| `resource=vtt`                                        | `transcription.vtt`, clave fija del vídeo                                              | Redirect de `/api/playlist?fileType=transcription`; acciones/Blob de captions son flujos separados y no se consideran migrados por este test                                   |
| `resource=enhanced-audio`                             | `enhanced-audio.mp3`, clave fija                                                       | Redirect de `/api/playlist?fileType=enhanced-audio`; no activa controles deshabilitados del reproductor                                                                        |
| `resource=comment-media&commentId=…`                  | Fila actual de comentario, tipo/MIME y clave canónica                                  | `commentMediaUrl` de `apps/web/lib/comment-media.ts`; `VideoCommentCard.tsx` y `VoiceNotePill.tsx` bajo media-comment                                                          |
| `resource=comment-thumbnail&commentId=…`              | JPEG canónico de la misma fila de comentario                                           | Poster de `VideoCommentCard.tsx` vía `commentMediaUrl`                                                                                                                         |
| `/api/thumbnail?videoId=…`                            | JSON con `screen` relativo al proxy, no bytes de imagen                                | `apps/web/app/s/[videoId]/edit/EditVideoClient.tsx` y `_components/call-to-action/CallToActionDialog.tsx`                                                                      |
| `/api/video/preview?videoId=…`                        | Bytes GIF; puede resolver fallback OG relativo tras ausencia confirmada y autorización | `VideoThumbnail.tsx` y `VideoPreviewGif.tsx`; compatibilidad del path existente                                                                                                |

Las rutas completas para los selectores de la tabla comparten el prefijo
`/api/playback/resource?videoId=…&resource=`; los comentarios añaden commentId.
No se inventa una ruta SRT: la auditoría previa no identificó un artefacto
publicado dedicado que migrar.

La autorización real es `authorizeViewerVideo` en
`apps/web/lib/viewer-media.ts`, con `buildCanViewLoaded` de
`packages/web-backend/src/Videos/VideosPolicy.ts` y
`Policy.withPublicPolicy`. El harness conserva el handler HTTP Effect y la
política, pero simula identidad/sesión, repositorios de permisos, DB y storage.
Esto no prueba cookies reales, commits MySQL, ACL del proveedor ni E2E.

## Caché y límites del stream

`private-resource-response.ts` aplica `Cache-Control: private, no-store`,
`CDN-Cache-Control: no-store`, `Vercel-CDN-Cache-Control: no-store`,
`Pragma: no-cache` y `Expires: 0`. El helper común se aplica a respuestas,
HEAD, errores y redirects. El fallback OG permitido sigue siendo una URL relativa
del mismo origen; no es una firma de almacenamiento ni una excepción a autorizar.
La autorización y el contenido de su destino `/api/video/og` quedan fuera de la
cobertura de este incremento: comprobar el redirect protegido no demuestra
protección transitiva del renderizador OG.

`streamViewerObject` utiliza HEAD de storage para tamaño/ETag después de
autorizar, soporta Range único e If-Range y transmite mediante `playbackStream`.
HEAD no debe iniciar lectura de bytes o generación GIF. Un 416 autorizado puede
consultar tamaño, pero no leer bytes; una denegación debe preceder a cualquier IO
de almacenamiento. Las consultas necesarias para autorizar sí pueden acceder a DB.

La revocación afecta a nuevas admisiones. No retira imágenes ya mostradas,
subtítulos convertidos en Blob, copias descargadas, buffers ni necesariamente
streams que ya fueron admitidos. No se confunde un stream sintético controlado
con una transferencia remota interrumpida a mitad de lectura.
Existe una carrera entre autorización y apertura/lectura de storage: no hay una
transacción DB-storage en este contrato. Un permiso retirado tras la admisión no
se vuelve a consultar por cada chunk de la respuesta ya admitida.

## Resultados de este incremento

El archivo de derivados pasa de **130 a 315 pruebas**, un aumento neto de 185.
La cobertura de autorización incorpora una matriz de 120 casos (seis selectores
× cuatro cambios de permisos × GET, HEAD, Range, If-Range coincidente y obsoleto).
Los cambios son retirada de membresía, retirada de grant explícito, publicación
pública que pasa a privada y cambio de contraseña conservando una verificación
anterior. Las rutas de compatibilidad añaden 28 casos de revocación: 20 de GIF
y ocho de descriptor JSON, limitado a GET/HEAD. Se conservan las comprobaciones
de propietario, miembro, ajeno y anónimo y se añade el espectador con grant.

La fase HTTP añade **39 casos**: seis por selector para HEAD ausente/caído,
If-Range débil, 416 del origen con cancelación del cuerpo, filtrado de cabeceras
y continuidad del stream previamente admitido; dos redirects OG protegidos
GET/HEAD tras ausencia confirmada; y un descriptor de miniatura retenido que
no concede acceso a su URL de bytes después de revocar el grant.

Cada denegación tras revocar comprueba 404 vacío, las cinco directivas de caché
y ausencia de Location; exige cero acceso, HEAD, lectura, firma, listado o
generación de almacenamiento. El caso del descriptor conserva una URL relativa
válida, pero la petición de bytes debe volver a autorizar. El caso del stream
recibe un primer chunk, deniega una nueva Range y permite completar el stream
admitido previamente; no se presenta como aborto remoto.

| Comprobación                                                                                | Resultado de esta entrega                                                                                |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pruebas de derivados                                                                        | 315/315 aprobadas                                                                                        |
| Regresión conjunta de MP4, derivados, playlist, contratos, motor, adaptadores y capacidades | 636/636 aprobadas en diez archivos; 4,17 s                                                               |
| Drive live sin opt-in                                                                       | 9 omitidas deliberadamente; no se realizaron conexiones                                                  |
| Casos fallidos finales                                                                      | 0 en las suites ejecutadas                                                                               |
| Typecheck web                                                                               | Salida 0; sin errores; 56 avisos y 118 sugerencias Effect, mismos conteos que el incremento previo       |
| Formato y diff                                                                              | Biome del test y git diff comprobados por el coordinador; Prettier de este documento comprobado          |
| Auditor independiente                                                                       | 403/403 aprobadas: derivados 315, MP4 51 y playlist 37; revisión, Biome y diff sin hallazgos bloqueantes |
| E2E, MySQL, S3/MinIO y retención/concurrencia reales                                        | Bloqueados o no ejecutados: faltan recursos/alcance descritos debajo                                     |

Los errores registrados por escenarios negativos de playlist son esperados por
esos tests, no casos fallidos. No se ocultan los diagnósticos Effect ni se tratan
como errores de TypeScript. No se ejecutó typecheck del media server: no se
modifica ese módulo.

Comprobación específica reproducible:

```bash
export PATH=/workspace/.tools/node_modules/.bin:$PATH
bun run --cwd apps/web test \
  __tests__/unit/viewer-derivatives.test.ts \
  __tests__/unit/mp4-playback-route.test.ts \
  __tests__/unit/segment-playlist-route.test.ts
bun run tsc-rs -p apps/web/tsconfig.json --noEmit
```

La regresión de diez archivos añade los siete unit tests de contratos, motor,
adaptadores y capacidades enumerados en
SCREENLY_HLS_VIEWER_REVOCATION_VALIDATION.md. Se incluye también el runner
Drive real en el comando conjunto para comprobar que omite sus nueve casos
sin opt-in; ese archivo omitido no cuenta entre los diez aprobados.

La evidencia previa de **nueve casos con Drive real** se conserva en
[SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md](SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md).
No se repite como parte de este incremento ni se extrapola a revocación viewer,
retención, concurrencia o seguridad HLS completa. Un caso live omitido sin opt-in
no equivale a aprobado.

## Entorno observado y verificaciones reales pendientes

Solo se inspeccionó la presencia de nombres, sin leer o mostrar credenciales:
DATABASE_URL, MYSQL_URL y SCREENLY_HLS_TEST_S3_BUCKET, S3_REGION, S3_ENDPOINT,
AWS_PROFILE, SCOPE_FILE y MANIFEST_FILE no están disponibles en esta sesión.
Los nombres abreviados de esta frase llevan el prefijo SCREENLY_HLS_TEST_.
Esta observación no demuestra que no exista un servicio externo; no se buscaron
cuentas, buckets ni recursos de producción.

Orden propuesto de preparación y ejecución, sujeto a aprobación específica:

| Orden | Área                            | Recursos y permisos necesarios                                                                                                                                                               | Criterio de aceptación / límite                                                                                                                                                                |
| ----- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | MySQL de laboratorio            | Servicio exclusivo ya disponible, esquema compatible preparado por su responsable, credencial acotada y fixtures de usuarios/vídeos/membresías/grants/contraseñas identificadas              | Retirada persistida y confirmada antes de nueva solicitud; sin caché de decisiones obsoletas; fallo DB deniega. No generar ni aplicar migraciones en este incremento                           |
| 2     | S3/MinIO de laboratorio         | Bucket exclusivo versionado, región/endpoint HTTPS, claves y VersionIds exactos, tamaño, ETag y SHA256 FULL_OBJECT; perfil/rol nativo lector explícito compatible con SigV4                  | Leer identidad exacta y verificar bytes; negar revisiones/checksums discrepantes sin fallback. No usar placeholders proxy como claves crudas SigV4 ni conceder escritura por conveniencia      |
| 3     | E2E MP4 y derivados             | Instancia aislada autorizada, navegador, sesiones de owner/member/grant/outsider/anónimo, muestras sintéticas y proveedores declarados; acceso a MySQL preparado y limpieza acotada aprobada | Reproducir/mostrar recurso permitido; tras revocar, nueva petición denegada antes de storage; medir caché y no exponer enlaces de origen. No prometer retiro de bytes previos                  |
| 4     | Retención y concurrencia reales | Muestras desechables versionadas, política de retención observable, identidades lectora/escritora separadas y autorización de mutación/ACL/limpieza                                          | Cambios de identidad durante lectura fallan cerrado, no mezclan generaciones; verificar recuperación y purga sin tocar originales. No deducir retención histórica de un head actual            |
| 5     | HLS completo                    | Publicación persistida y activación por autoridad confiable según diseño aprobado; proxy por recurso aún por implementar/autorizar; fixtures VOD/EVENT, init/audio/segmentos y casos legacy  | Cada manifiesto, variante, audio, init y segmento se autoriza con permisos vigentes, solo identidades publicadas y URI del mismo origen. Requiere sus propias pruebas E2E y revisión de código |

Los requisitos detallados de storage, scope, manifests y destinos se mantienen en
[SCREENLY_HLS_REAL_STORAGE_REQUIREMENTS.md](SCREENLY_HLS_REAL_STORAGE_REQUIREMENTS.md).
Antes de conectar, comprobar readiness actual, política de red, credencial elegida
y recursos exactos. No se amplían dominios ni permisos desde este trabajo.

Las pruebas MySQL de cambio de permisos necesitan escrituras acotadas de datos
de laboratorio por un responsable autorizado; no se confunden con una prueba de
solo lectura. El ensayo de retención puede exigir configuración o purgas con
autorización separada: no quedan autorizadas por este plan.

### Runners existentes que no deben activarse automáticamente

`apps/web/__tests__/e2e/agent-local-e2e.test.ts` se habilita con
`CAP_AGENT_E2E=1`. Su `seedDatabase` ejecuta SHOW TABLES, desactiva
FOREIGN_KEY_CHECKS y realiza TRUNCATE TABLE y DELETE. Además usa createServer,
spawn y PutObjectCommand. No se ejecutó: contradice las restricciones actuales
sin aislamiento y autorización adicionales. Su nombre E2E no acredita que sea
seguro apuntarlo a un servicio compartido.

No se inicia Next, MySQL, MinIO, Docker ni otro servicio; no se cambia infraestructura,
VPS, esquemas, dependencias, lockfiles, permisos u objetos existentes.

## Riesgos residuales y parada

Las playlists HLS legacy todavía pueden emitir firmas directas de init y
segmentos; conocer un enlace antiguo puede conservar capacidad hasta su
expiración aunque Screenly deniegue una nueva solicitud. El resultado de derivados
no cierra esa vía ni revoca credenciales internas, móvil/API u otros emisores
no migrados. Véanse el diseño de revocación y
[SCREENLY_PHASE1_5B_HLS_PUBLICATION_DESIGN.md](SCREENLY_PHASE1_5B_HLS_PUBLICATION_DESIGN.md).

El diseño recomienda manifiesto explícito más registro activo/CAS y validación
legacy controlada. Listar objetos, verificar sus hashes o tener un job completo
no acredita por sí solo publicación autorizada. No se activa publicación, proxy
ni fallback a firmas para eludir una incompatibilidad.

Si las pruebas revelan un defecto productivo, registrar reproducción, impacto y
corrección mínima propuesta; no modificar producción sin aprobación. Continuar
solo tareas independientes autorizadas, sin rebajar expectativas para obtener
verde.

Al cerrar este incremento se publican pruebas y documentación en commits separados,
se actualiza PR #1 en borrador y se detiene para revisión. Main intacta, sin merge.
