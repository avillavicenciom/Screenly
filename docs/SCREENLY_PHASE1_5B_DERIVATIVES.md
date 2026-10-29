# Fase 1.5B.5 — proxy de recursos derivados

Implementación del incremento 5 sobre `f8a7739b4f0bc3cd271092ef00714dcf763ab76c`,
en `feature/screenly-phase-0`. Commit de implementación:
`48690d24bdf65959099d10c1cca8c72fe201ef92`. La documentación se publica en un
commit separado. Los documentos de diseño, capacidades internas, proxy MP4 y
caché anteriores son antecedentes históricos; sus puntos de parada han recibido
la aprobación del usuario para este incremento concreto.

## Auditoría y alcance

| Recurso / emisor anterior                                                  | Consumidores                                                                                            | Resultado                                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miniaturas JPEG/PNG: `/api/thumbnail` devolvía una URL firmada en `screen` | Editor y diálogo CTA                                                                                    | Se conserva el JSON; `screen` apunta al proxy de bytes                                                                                                                |
| `Videos.getThumbnailURL`, `VideosRpcs` y `ThumbnailRequest`                | `VideoThumbnail`, biblioteca y capturas en `Share.tsx`                                                  | Devuelven una URL relativa sin tocar storage; la existencia y selección de la imagen se resuelven al pedir los bytes                                                  |
| GIF: `/api/video/preview` redirigía al proveedor                           | `VideoPreviewGif`, biblioteca, portapapeles y metadatos compartidos                                     | Entrega bytes GIF con autorización actual; no redirige al almacenamiento                                                                                              |
| `/api/playlist?...fileType=transcription`                                  | Consumidores de VTT de esa interfaz                                                                     | Redirect del mismo origen al proxy VTT, antes de resolver storage; corrige también el caso de bucket por defecto que alcanzaba el redirect multimedia previo          |
| `/api/playlist?...fileType=enhanced-audio`                                 | Audio mejorado auxiliar                                                                                 | Redirect del mismo origen al proxy de `enhanced-audio.mp3`; no activa controles de audio deshabilitados                                                               |
| `commentMediaUrl(videoId, key)`                                            | `VideoCommentCard`, `VoiceNotePill`, poster del comentario                                              | Ahora recibe un ID de comentario, no una clave; el servidor consulta el registro antes de resolver el objeto                                                          |
| `transcription.vtt`, `transcription.<idioma>.vtt` y artefactos live/edit   | Acciones `get-transcript`, `translate-transcript`, `get-live-transcript`, editor y contexto de captions | Las acciones existentes entregan contenido bajo sus políticas actuales; no se convierten en una API genérica de objetos ni se cambian sus permisos en este incremento |
| SRT                                                                        | Búsqueda en rutas, componentes y utilidades inspeccionados                                              | No se identificó un artefacto SRT publicado ni un emisor dedicado que migrar; no se inventa una ruta de lectura                                                       |
| Niveles / mejora de audio                                                  | `audio-level-publication`, salida MP4 `audio-quality-v3`, waveform de comentarios                       | La salida publicada sigue la resolución del proxy MP4; waveform permanece en `mediaMeta`, sin URL separada; no se exponen archivos internos de análisis               |
| OG y extracción de poster                                                  | `/api/video/og`, `get-og-image.tsx`, `lib/og/poster-frame.ts`                                           | Flujos distintos: imagen pública o placeholder de privacidad y lectura interna para renderizar; sin migración de estos mecanismos                                     |

Se inspeccionaron `AGENTS.md`, las instrucciones web, la guía de Route Handlers
de la versión instalada de Next y los cuatro documentos previos exigidos.
No se modifican generación de recursos, capturas Windows/web, subidas,
transcripción, workers, esquemas, dependencias ni lockfiles.

## Arquitectura y endpoints

`apps/web/lib/viewer-media.ts` extrae del incremento 4 tres componentes:

- `authorizeViewerVideo`: `provideOptionalAuth`, política actual mediante
  `Videos.getByIdForViewing` y comprobación de existencia/tombstone de la
  organización. Devuelve 404 ante inexistencia o denegación y 503 ante fallo de
  autenticación/DB. No conserva decisiones entre peticiones.
- `isVideoObjectKey` y `streamViewerObject`: validación de pertenencia y lectura
  de metadatos/bytes. Reutilizan `playbackRange` y `playbackStream` del incremento 4. S3 conserva la lectura interna con IfMatch; Drive conserva su adaptador de
  bytes. Ningún firmador público participa en esta lectura.
- `viewerMediaApi`: construye GET y HEAD con Effect HttpApi, conecta los servicios
  mediante `apiToHandler` y aplica la caché privada incluso a errores.

El proxy MP4 utiliza esos componentes sin cambiar su contrato. No es una
refactorización de los adaptadores multimedia ni de las políticas de negocio.

`apps/web/lib/viewer-derivatives.ts::derivativeResponse` implementa:

| Endpoint / selector                                     | Recurso permitido y resolución                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/api/playback/resource?videoId=...&resource=thumbnail` | Miniatura publicada del vídeo o descubrimiento anterior de screenshots, validando prefijo y extensión JPEG/PNG |
| `resource=preview`                                      | `preview/animated-preview.gif`, con resolución existente de salidas publicadas                                 |
| `resource=vtt`                                          | Clave fija `ownerId/videoId/transcription.vtt`                                                                 |
| `resource=enhanced-audio`                               | Clave fija `ownerId/videoId/enhanced-audio.mp3`                                                                |
| `resource=comment-media&commentId=...`                  | Registro actual de comentario y clave canónica de su MIME permitido                                            |
| `resource=comment-thumbnail&commentId=...`              | Thumbnail JPEG del mismo registro de comentario de vídeo                                                       |
| `/api/thumbnail?videoId=...`                            | Descriptor JSON `{ screen: "/api/playback/resource?..." }`, previa autorización y comprobación de existencia   |
| `/api/video/preview?videoId=...`                        | Mismos bytes GIF, conservando el path de imágenes existente                                                    |

No se aceptan claves, buckets ni URLs de origen del solicitante. Un parámetro
`key` se rechaza con 400. Se validan también claves persistidas de thumbnail/GIF;
se rechazan prefijos de otro vídeo, traversal y extensiones incompatibles.
Los tokens legacy presentes en la URL no conceden acceso.

En comentarios se consulta por ID **y** vídeo, se comprueban ambos valores de
la fila, tipo audio/vídeo y `mediaMeta`, y se exige coincidencia exacta con
`commentMediaKeys`. El poster debe ser el thumbnail canónico de esa fila. Un
comentario borrado o todavía no publicado no habilita lectura aunque su objeto
siga en storage. El modelo inspeccionado no tiene una visibilidad de lectura
adicional por autor: los espectadores autorizados del vídeo ven los comentarios;
las reglas de autor para escribir/borrar se mantienen en sus acciones existentes.

## Compatibilidad, fallos y caché

- GET transmite sin cargar el archivo completo. HEAD autoriza y devuelve
  metadatos sin leer bytes. Se preservan Content-Length conocido, ETag y MIME
  acotado: JPEG, PNG, GIF, `text/vtt; charset=utf-8`, audio/mpeg y formatos
  permitidos de comentarios. Se añade nosniff.
- Se mantienen Range único, If-Range, 200, 206 y 416 mediante el helper del proxy
  MP4; el audio/vídeo adjunto puede solicitar intervalos. Rangos inválidos pueden
  consultar tamaño después de autorizar, pero no leen bytes.
- La cancelación del lector o AbortSignal cancela el stream de origen. Los
  errores de lectura no incluyen mensajes del proveedor. Redirects de origen y
  longitudes/rangos incoherentes se rechazan con 502 y se cancela su cuerpo.
- Miniatura ausente y GIF ausente devuelven 404 vacío; una caída de storage
  devuelve 502, sin JSON sensible ni fallback público. Fallos de DB devuelven 503. Las denegaciones ocurren antes de adquirir storage, leer, listar o firmar.
- La generación GIF existente se conserva tras autorizar y solo cuando el
  proveedor confirma ausencia. HEAD no inicia generación. `fallback=og` conserva
  el redirect relativo al renderizador OG solamente tras autorización y ausencia
  confirmada; un fallo de permisos/DB/storage no lo activa. Los trabajos internos
  ya admitidos no dependen de que el espectador mantenga abierta la conexión.
- `PRIVATE_RESOURCE_HEADERS` centraliza `private, no-store`, CDN-Cache-Control
  y Vercel-CDN-Cache-Control no-store, Pragma no-cache y Expires 0. Los nuevos
  redirects VTT/audio usan esas cabeceras. Las respuestas del proxy y del JSON
  conservan la política incluso para vídeos públicos, HEAD, errores y 416.
- Un vídeo explícitamente público sigue accesible anónimamente si la política
  existente lo permite; contraseñas y restricciones heredadas siguen vigentes.
  Convertirlo a privado o revocar membresía bloquea la siguiente petición.

`VideoThumbnail`, `VideoPreviewGif` y `ScreenshotImage` usan imágenes sin
optimización de Next; las peticiones del navegador al mismo origen pueden llevar
sus cookies. Editor/CTA siguen leyendo `screen`. Los componentes de comentarios
conservan blobs locales durante carga y utilizan el proxy para los medios
publicados. Los contratos de claves y tokens de subida no cambian.

Los captions actuales de `ShareVideo` pueden construirse a partir del contenido
VTT ya recibido mediante Blob; este incremento no retira blobs ni bytes anteriores.
La prueba VTT verifica cues, marcas de tiempo y UTF-8, pero no sustituye un test
de decodificación/reproducción de subtítulos en un navegador real.

## Validación ejecutada

Node 24 / Bun 1.4.4 del entorno preparado. **481 pruebas aprobadas en 21 archivos**:

```bash
bun run --cwd apps/web test \
  __tests__/unit/viewer-derivatives.test.ts \
  __tests__/unit/mp4-playback-route.test.ts \
  __tests__/unit/private-resource-authorization.test.ts \
  __tests__/unit/thumbnail-published-output.test.ts \
  __tests__/unit/segment-playlist-route.test.ts \
  __tests__/unit/recording-storage-lifecycle.test.ts \
  __tests__/unit/media-comment-playback-cleanup.test.ts \
  __tests__/unit/video-preview-gif.test.ts \
  __tests__/unit/loom-preview-gif.test.ts \
  __tests__/unit/comment-media-keys.test.ts \
  __tests__/unit/comment-media-token.test.ts \
  __tests__/unit/new-media-comment-thumbnail.test.ts \
  __tests__/unit/transcription-media-authorization.test.ts \
  __tests__/unit/media-extraction-capability.test.ts \
  __tests__/unit/media-capability.test.ts \
  __tests__/unit/media-client.test.ts \
  __tests__/unit/s3-playback-stream.test.ts \
  __tests__/unit/recording-output.test.ts \
  __tests__/unit/share-playback.test.ts \
  __tests__/unit/playback-source.test.ts \
  __tests__/unit/share-player-expired-url.test.ts
```

Las 130 pruebas nuevas de derivados cubren propietario, miembro, ajeno, anónimo,
público, cambios de membresía/publicación/contraseña, vídeo u organización
eliminados, token legacy firmado válido, claves ajenas/traversal, DB, storage,
GET/HEAD, MIME, VTT real como fixture, imágenes ausentes, rangos, cancelación,
compatibilidad de contratos y ausencia de URLs de origen. Se usa el handler
Effect HTTP y `buildCanViewLoaded` reales con identidad, DB y storage simulados.
La interfaz de Drive se prueba con fixtures; S3 usa adaptador real y SDK simulado.

Las regresiones cambian expresamente las expectativas anteriores inseguras:
JSON con firma y GIF redirect al origen dejan de ser resultados válidos. El
test de ciclo de almacenamiento confirma que el RPC de miniaturas ya no lee
storage para emitir la URL; la selección de salida publicada se verifica al
resolver los bytes. Pasan las pruebas existentes de generación GIF, comentarios,
publicación, audio interno, capacidades y HLS/segmentos, cuyas playlists no se
reescriben en este incremento.

- `bun run tsc-rs -p apps/web/tsconfig.json --noEmit`: aprobado sin errores. Hay
  avisos/sugerencias de Effect, incluidos fixtures; no son errores TypeScript.
- Biome: aprobado sobre los 17 archivos TS/TSX modificados.
- Prettier: aplicado y comprobado en este documento con
  `--ignore-path /dev/null`, porque `/docs/` está ignorado por el repositorio.
- `git diff --check` y revisión de archivos/claves sensibles: aprobados. No se
  publican `.env` ni credenciales; las claves en fixtures son ficticias.
- Typecheck independiente de media server: conserva exactamente los siete
  errores previos, comparados sin diferencias con el informe del incremento 4:
  tres TS2352 en `drive-resumable-upload.test.ts` (107, 124, 141), TS2769 en
  `media-routes-real-world.integration.test.ts` (1061), TS2322 en
  `media-size.test.ts` (34) y dos TS2345 en `capcodec-encoder.ts` (337, 344).

Son pruebas aisladas y regresiones con fixtures. No se iniciaron servidores ni
Docker, no se llamó a IA/API de pago, no se aplicaron migraciones y no se
modificó el VPS. No se probó MySQL/S3/MinIO/CloudFront/Drive real ni reproducción
E2E; no se declara Screenly listo para uso real.

## Archivos publicados

Implementación y pruebas, 17 archivos:

- Rutas: `apps/web/app/api/playback/resource/route.ts`,
  `playback/mp4/route.ts`, `thumbnail/route.ts`, `video/preview/route.ts` y
  `playlist/route.ts`, estas últimas bajo el mismo directorio `app/api`.
- Helpers: `apps/web/lib/viewer-media.ts`, `viewer-derivatives.ts`,
  `private-resource-response.ts` y `comment-media.ts`.
- Consumidores: `VideoCommentCard.tsx` y `VoiceNotePill.tsx` en
  `apps/web/app/s/[videoId]/_components/media-comment/` y
  `packages/web-backend/src/Videos/index.ts`.
- Tests en `apps/web/__tests__/unit/`: `viewer-derivatives.test.ts`,
  `private-resource-authorization.test.ts`, `thumbnail-published-output.test.ts`,
  `segment-playlist-route.test.ts` y `recording-storage-lifecycle.test.ts`.

Documentación: este archivo, en commit separado.

## URLs legacy y riesgos pendientes

`/api/storage/object`, móvil, API v1, SDK/developer videos, descargas y otros
emisores no migrados mantienen sus mecanismos actuales. Las URLs directas
preexistentes pueden seguir funcionando hasta caducar o hasta un corte del
proveedor autorizado. Los tokens legacy no se invalidan globalmente. Tampoco
se migran raw-preview, playlists HLS, segmentos, init ni sus URI de origen.
No se presenta esta entrega como revocación completa de toda la aplicación.

Las acciones de contenido/transcripciones y los renderizadores OG siguen
requiriendo su propia auditoría de autorización, caché y organización; no son
el nuevo endpoint de archivos. Ningún consumidor debe convertir una caída del
proxy en un fallback automático a una URL bearer antigua.

La garantía es la siguiente admisión tras un cambio confirmado de permisos:
no se retiran respuestas ya admitidas, buffers, blobs, imágenes ya mostradas o
copias descargadas. Hay carreras entre autorización y lectura; no hay epochs ni
transacción MySQL/storage. Drive no añade aquí una revisión fijada equivalente
a IfMatch de S3. ACL, origen público, cachés anteriores, CORS/cookies de clientes
externos y buffering de infraestructura requieren pruebas reales autorizadas.

Las miniaturas pueden requerir listado tras autorizar y el descriptor JSON
añade otra comprobación de existencia; GIF puede consultar metadatos más de una
vez. Medir coste/latencia y abuso antes de optimizar, evitando cachés de permisos
que reintroduzcan accesos obsoletos.

## Recomendaciones para el incremento 6

1. Revisar este incremento y autorizar un entorno aislado con MySQL y storage
   reales para probar revocación, imágenes, captions, búsqueda temporal,
   desconexión y caché con navegador/CDN.
2. Inventariar y migrar todas las URI de HLS: master, variantes, init, audio y
   segmentos, incluidos estados progresivos; no proteger solo el master.
3. Cubrir los clientes móvil/API/agentes y sus credenciales/CORS, preservando la
   separación de espectadores y capacidades internas.
4. Planificar el cierre legacy y el tratamiento de firmas/cachés antiguas con
   aprobación operativa posterior, sin cortar uploads ni trabajos en curso.

**Punto de parada:** incremento 5 terminado para revisión. No se implementa el
incremento 6. No se modifica `main`, no se fusiona ni se convierte el PR #1 a
Ready. La lectura del estado del PR mediante GitHub API devolvió `Forbidden`;
no se pudo verificar remotamente el indicador Draft y no se intentó cambiarlo.
