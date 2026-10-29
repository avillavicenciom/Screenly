# Fase 1.5B.6 — auditoría HLS y bloqueo de publicación legacy

**Estado: bloqueada antes de implementar. No hay un proxy HLS nuevo ni una
migración de lectores en esta entrega.** Se aplica la instrucción del usuario:
«Si descubres una incompatibilidad estructural que requiere ampliar el alcance,
documenta el bloqueo y detente para solicitar aprobación».

## Estado inicial y alcance de la revisión

- Rama comprobada: `feature/screenly-phase-0`; árbol limpio antes de la auditoría.
- HEAD inicial y remoto: `df52b8aec09989db9843e9ec2cfe366599bc7cce`.
- Incrementos anteriores presentes: `d34ed65e6` (capacidades internas),
  `f8a7739b4` (MP4), `48690d24b` (derivados) y `df52b8aec` (documentación).
- `main` remota: `8a5d50919f23d4186686de2fbaf965b74c744522`.
- Se consultaron `AGENTS.md`, `apps/web/AGENTS.md`, la guía instalada de Route
  Handlers de Next y los documentos de diseño de revocación, capacidades internas,
  proxy MP4 y derivados exigidos por la solicitud.

La auditoría identifica contratos en código, no datos de una instalación real.
No se inspeccionan buckets/VPS ni se presuponen muestras de playlists existentes.

## Matriz de emisores, formatos y lectores existentes

Todas las claves siguientes llevan el prefijo `ownerId/videoId/`.

| Emisor / fuente                            | Formatos y claves                                                                                               | Ruta actual de lectura y consumidores                                                                                       | Exposición actual                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Video.SegmentsSource` / `desktopSegments` | `segments/manifest.json`, `segments/video/init.mp4`, `segments/audio/init.mp4`, `segment_NNN.m4s` en cada pista | `/api/playlist` con `segments-status`, `segments-master`, `segments-video`, `segments-audio`; web y móvil                   | Master usa rutas web; variantes firman init y cada segmento                                                                       |
| `Video.M3U8Source` / `local`               | `combined-source/stream.m3u8`, segmentos TS referenciados                                                       | `/api/playlist` y enlace móvil directo al manifiesto                                                                        | Bucket por defecto: redirect firmado; custom: reemplaza líneas terminadas en `.ts` por firmas, sin analizar todas las URI de tags |
| `Video.M3U8Source` / `MediaConvert`        | `output/video_recording_000.m3u8`                                                                               | Bucket por defecto y `getCapPlayback` móvil                                                                                 | URL firmada al manifiesto; referencias descendientes no pasan por una revalidación viewer propia                                  |
| Rama legacy de bucket personalizado        | Objetos bajo `video/` y `audio/`; duración, bandwidth, resolución y códecs en metadata                          | `/api/playlist?videoType=master`, `video` o `audio`; genera playlists con `generateMasterPlaylist` / `generateM3U8Playlist` | Lista objetos, firma cada clave y genera VOD; no verifica publicación por objeto                                                  |
| `S3Buckets` / CloudFront                   | Mismas claves lógicas; firma S3 o distribución configurada                                                      | `getSignedObjectUrl` y redirects / URI anteriores                                                                           | Capacidad de origen independiente de permisos actuales                                                                            |
| Adaptador Drive                            | Mismas claves lógicas, resueltas a ficheros Drive                                                               | Firma mediante interfaz Storage y `/api/storage/object`; también existe `getObjectResponse` de bytes                        | Ruta legacy y sus tokens continúan; el proxy nuevo debe usar lectura de bytes, no esas URLs                                       |
| `generateM3U8Playlist`                     | Playlists VOD generadas con `EXTINF` y `ENDLIST`                                                                | `apps/web/utils/video/ffmpeg/helpers.ts`                                                                                    | Contiene sustitución de host S3 por `https://v.cap.so`; no basta con proteger el master                                           |

`packages/web-domain/src/Video.ts::Video.getSource`, `M3U8Source` y
`SegmentsSource` definen las claves reales. La ruta `/api/playlist` contiene
los selectores citados; no se introduce ningún selector ni endpoint hipotético.

Consumidores web inspeccionados: `Share.tsx`, `ShareVideo.tsx`,
`HLSVideoPlayer.tsx` y `lib/share-video-metadata.ts`. El reproductor distingue
master Instant, readiness y reproducción temprana; no es suficiente cambiar
una URL inicial. `apps/web/app/api/mobile/[...route]/route.ts::getCapPlayback`
firma directamente `M3U8Source`; para `SegmentsSource` devuelve
`/api/playlist?...videoType=segments-master`.

## Publicación progresiva existente

`lib/segment-playback.ts` y la rama Instant de `/api/playlist` ya distinguen:

- Manifiesto completo válido frente a completo inconsistente: este último da
  409; `getSegmentPlaybackState` usa `readCompletedRecordingManifest`.
- `segments-status`: 202 mientras espera y 204 cuando puede reproducir; incluye
  `X-Cap-Recording-Complete` y, para early playback, duraciones disponibles.
- `requireComplete` frente a `earlyPlayback`; early requiere init y prefijos
  contiguos de ambas pistas, no cualquier segmento ya subido fuera de orden.
- EVENT sin ENDLIST mientras crece; VOD/ENDLIST cuando corresponde. Hay
  compatibilidad de entradas numéricas y de duración explícita, y una reparación
  legacy de la bandera audio-init mediante comprobación de objeto existente.

Esta familia ofrece una autoridad concreta para admitir cada init/segmento.
El proxy debe releerla tras autorizar cada petición, no aceptar un índice solo
porque la clave exista. `segments/recording.json` informa longitud observada;
no sustituye el manifiesto de publicación ni debe exponerse como objeto genérico.

## Bloqueo de contrato en HLS legacy

La exigencia «recursos publicados» y el rechazo de «segmentos no publicados»
no tienen una definición equivalente comprobada en la rama legacy custom:

1. `apps/web/app/api/playlist/route.ts`, rama posterior a `source.type ===
"local"`, consulta `video/` y `audio/` para generar master y variantes.
2. La lectura usa `listObjects`, seguida de `getSignedObjectUrl` y `headObject`
   para **cada** objeto del listado. No consulta un manifiesto de publicación,
   identidad de intento ni un estado de commit de cada segmento en esa rama.
3. `apps/web/app/api/upload/[...route]/signed.ts` permite al propietario obtener
   targets de subida para subpaths/archivos. Comprueba propiedad y restricciones
   de rutas, pero eso no proporciona una confirmación de publicación de cada
   objeto para el lector legacy. La existencia y metadata de duración no prueban
   por sí mismas ese estado.
4. `videoProcessingJobs.manifestSha256` y los manifiestos Instant existen, pero
   no hay en el lector legacy inspeccionado un vínculo que permita utilizarlos
   como allowlist de esas pistas. No se presupone que cubran grabaciones antiguas.

Por tanto, envolver el listado en un proxy de bytes mejoraría la revocación,
pero no demostraría el requisito de excluir objetos no publicados. Exigir sin
más `segments/manifest.json` o el manifiesto fijo MediaConvert a todas esas
grabaciones cambiaría su contrato de lectura y podría romper reproducción
legacy que actualmente depende del listado. No se ha confirmado que todas las
grabaciones reales dispongan de esos manifiestos alternativos.

Esto es una incompatibilidad de contrato identificada en código, **no una
afirmación de explotación comprobada en producción** ni una prueba de que todo
vídeo legacy esté incompleto. No se decide silenciosamente que «listado equivale
a publicado» ni se modifica grabación/subidas para crear un nuevo contrato.

Se necesita aprobar una de estas direcciones antes de implementar íntegramente:

1. **Recomendada:** ampliar la preparación para definir cómo publicar/identificar
   las pistas legacy y cómo tratar grabaciones antiguas. Revisar primero si un
   manifiesto existente es utilizable; no se presupone necesidad de esquema.
   Cualquier cambio de escritor, backfill o migración se presentará por separado.
2. Autorizar un alcance reducido: migrar familias con manifiesto verificable y
   definir expresamente qué ocurrirá con legacy sin él —por ejemplo, denegar
   reproducción hasta preparar su inventario—. Eso no sería todavía protección
   integral compatible de todos los formatos y requiere aceptar ese impacto.

## Compatibilidad móvil y separación interna

`apps/mobile/app/caps/[id].tsx` pasa URI/contentType a `player.replaceAsync`,
sin Authorization en la fuente de reproducción, aunque sí adjunta Bearer a
miniaturas. Redirigir sus URLs firmadas a un proxy de sesión web no conserva por
sí solo la reproducción privada. Hay que probar propagación de credenciales a
master/variantes/init/segmentos en el reproductor nativo, no solo en fetch de API.

`HttpAuthMiddlewareLive` admite claves API en rutas con middleware; en cambio,
`provideOptionalAuth` obtiene la sesión web. `viewer-media.ts` reutiliza esa vía
opcional para propietarios/miembros/público. La integración HLS móvil debe
resolver esta diferencia sin convertir una clave en query string, introducir
un bypass legacy ni bloquear el acceso anónimo expresamente público.

Los workers conservan `getInternalSignedObjectUrl`, las capacidades de extracción
de audio y las subidas existentes. Su acceso no debe requerir cookies de viewer.
`streamViewerObject` ya proporciona S3 interno/Drive, rangos, If-Range, ETag,
cancelación y saneamiento de errores; `viewerMediaApi` proporciona no-store y
revalidación. Estos componentes son reutilizables, pero no resuelven por sí solos
qué segmentos legacy están publicados.

## Verificaciones ejecutadas y límites

Sin modificar código ni iniciar servicios, Node 24 y Bun 1.4.4 del entorno:

```bash
bun run --cwd apps/web test \
  __tests__/unit/segment-playlist-route.test.ts \
  __tests__/unit/segment-playback.test.ts \
  __tests__/unit/mp4-playback-route.test.ts \
  __tests__/unit/viewer-derivatives.test.ts \
  __tests__/unit/loom-preview-gif.test.ts \
  __tests__/unit/media-client.test.ts \
  __tests__/unit/media-extraction-capability.test.ts \
  __tests__/unit/media-capability.test.ts
bun run --cwd apps/web test \
  __tests__/unit/early-segment-playback.test.ts \
  __tests__/unit/segment-playback-probe.test.ts
bun run tsc-rs -p apps/web/tsconfig.json --noEmit
bun run tsc-rs -p apps/media-server/tsconfig.json
```

- Primera batería: **258 aprobadas / 8 archivos**; segunda: **19 / 2**.
  Total: **277 pruebas existentes**, no pruebas de un proxy HLS nuevo.
- Typecheck web: aprobado sin errores; conserva avisos/sugerencias Effect.
- Typecheck independiente media server: mismos siete errores que en 1.5B.5,
  comparados sin diferencias: `drive-resumable-upload.test.ts` (107, 124, 141),
  `media-routes-real-world.integration.test.ts` (1061), `media-size.test.ts` (34),
  `capcodec-encoder.ts` (337, 344). No se tocan esos archivos.
- Prettier y `git diff --check` se aplican a este documento. Biome de código no
  procede: no hay archivos TS/JS modificados.

Las pruebas de referencia verifican readiness, early playback, MP4, derivados,
generación y capacidades internas con fixtures. No demuestran revocación HLS
de segmentos ni las nuevas garantías solicitadas, que **no se implementaron**.
No se ejecutaron pruebas E2E ni conexiones MySQL/S3/MinIO/Drive/CDN reales.

## Riesgos vigentes y punto de parada

Las playlists/init/segmentos HLS siguen pudiendo entregar URLs firmadas. La
revocación del siguiente GET/HEAD/Range no está implementada para esas lecturas.
Tampoco se añaden validadores de URI, rechazo de rutas de playlist manipuladas,
allowlists de publicación o caché privada uniforme HLS en este informe. Las
firmas antiguas, origen público, cachés previas y copias locales mantienen los
riesgos conocidos. No hay certificación de seguridad.

Una vez resuelto el contrato se necesitan pruebas nuevas de todas las familias,
URI de tags y líneas, referencias absolutas/relativas, traversal y recursos
desconocidos; matriz de perfiles/revocación; cero storage ante denegación;
HEAD/Range/If-Range/cancelación; MIME/200/206/416/202/204/409; credenciales móviles
y regresiones internas. No se debe exponer el manifiesto JSON como acceso
arbitrario ni aceptar todas las extensiones bajo un prefijo.

**Detenido antes de implementar 1.5B.6 para decisión del usuario sobre el contrato
legacy.** Solo se publica este informe. No se inicia 1.5B.7, no se cambia el
estado del PR #1, no se fusiona `main`, no se modifica infraestructura, esquema,
dependencias ni lockfiles, y no se aplica ninguna migración.
