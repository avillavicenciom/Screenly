# Screenly — web, backend y biblioteca

Estado: código inspeccionado y pruebas locales específicas; sin servidor Next.js,
Docker, MySQL o S3 real. Resultados reproducibles en `SCREENLY_ARCHITECTURE.md`.

## Aplicación y API

`apps/web/package.json` fija Next.js 16.3.0 y React 19.2.4; Node 24.x.
El App Router combina sitio, dashboard, páginas compartidas, API y workflows.
`apps/web/AGENTS.md` requiere consultar la documentación instalada de Next antes
de cambiar código: esta fase no modifica código de Next.

`packages/web-domain/src/Http/Api.ts` y los contratos `web-api-contract*` definen
interfaces; `packages/web-backend/src` implementa Videos, Comments, Organisations,
Spaces, Folders, Storage y S3Buckets usando Effect. `apps/web/lib/server.ts`
adapta handlers y runtime. Persisten rutas Hono/Next para upload y APIs específicas;
un cambio transversal de autorización debe revisar también esas rutas.

## Grabación desde navegador

Entrada: `apps/web/app/(org)/dashboard/caps/record/RecordVideoPage.tsx` →
`../components/web-recorder-dialog/web-recorder-dialog.tsx::WebRecorderDialog`
→ `useWebRecorder.ts::useWebRecorder`.

| Área                     | Implementación                                                                                             | Límites de la evidencia                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pantalla/ventana/pestaña | `packages/recorder-core/src/capture-streams.ts::acquireDisplayStream` usa `getDisplayMedia` con reintentos | El usuario y el navegador eligen la superficie; no captura silenciosa                 |
| Webcam y flotante        | `CameraPreviewWindow.tsx`, `CameraSelector.tsx`, `useCameraDevices.ts`                                     | Preview existe; no asumir que una burbuja HTML externa queda en el vídeo final        |
| Micrófono y sistema      | `capture-streams.ts` mezcla fuentes con Web Audio; `SystemAudioToggle.tsx`                                 | El navegador puede no entregar audio de sistema aunque se solicite                    |
| Pausa/reanudación        | `useWebRecorder.ts`, `InProgressRecordingBar.tsx`; SDK `CapRecorder.pause/resume`                          | Tests SDK cubren estados y duración; permisos y sincronía real N                      |
| Formatos                 | `recorder-utils.ts::RecordingPipeline`, `recorder-constants.ts`                                            | WebM progresivo o raw WebM/MP4 según capacidades MediaRecorder                        |
| Conversión               | `recording-conversion.ts`, Mediabunny y detección `VideoEncoder`                                           | Compatibilidad de codecs WebCodecs por navegador no probada                           |
| Recuperación             | `recording-spool.ts::RecordingSpool`, `recoverOrphanedRecordingSpools`                                     | IndexedDB persistente cuando está disponible; fallback de memoria no sobrevive cierre |
| Subida progresiva        | `instant-mp4-uploader.ts`, `recording-upload.ts`                                                           | Pruebas con red/storage simulados; sin validar proveedor real                         |

Se reutiliza `packages/recorder-core` en la extensión. `packages/sdk-recorder`
ofrece integración embebida con StreamManager y MediaRecorder, pero es otra
superficie API: no asumir que implementa toda la recuperación del diálogo web.

Windows Chrome/Edge son los primeros candidatos a certificación. HTTPS o contexto
seguro, consentimiento, gesto del usuario y soporte `getDisplayMedia` son
requisitos del navegador. Safari/Firefox y audio de ventana/sistema necesitan una
matriz propia. La UI tiene fallback cámara cuando no hay display capture.
Grabación de varios monitores simultáneamente no está establecida por esta ruta.

## Biblioteca, almacenamiento y publicación

`packages/database/schema.ts` modela `videos`, `folders`, `spaces`, `sharedVideos`,
`videoViewerGrants`, `comments`, `videoUploads` y `videoProcessingJobs`.
La pertenencia a organizaciones y espacios articula la biblioteca compartida.
La aplicación usa MySQL con Drizzle (`packages/database/index.ts::db`);
no asumir soporte PlanetScale HTTP por una frase antigua del CLI de entorno.

El vídeo se almacena en S3 compatible/MinIO, con integraciones en
`packages/web-backend/src/Storage` y URLs firmadas en
`S3Buckets/S3BucketAccess.ts`. El disco `.cap` nativo contiene fuentes y edición;
la biblioteca remota contiene vídeo publicado y derivados. Definir explícitamente
qué queda solo local, qué se publica y si el proyecto editable debe subirse.

`apps/web/app/api/upload/[...route]/multipart.ts` controla creación de sesión,
propiedad, firma de partes y finalización. `lib/desktop-recording-publication.ts`
y `workflows/finalize-desktop-recording.ts` conectan recepción, procesamiento y
publicación; no equiparar HTTP 200 de subida con vídeo reproducible.
`recording-storage-lifecycle` cubre preservación de originales y fallos remotos.

## Reproducción, edición y colaboración

`app/s/[videoId]/_components/CapVideoPlayer.tsx`, `HLSVideoPlayer.tsx` y
`ShareVideo.tsx` implementan reproducción; `PendingRecordingShare.tsx` y
`RecordingInProgress.tsx` distinguen vídeo pendiente/en curso.
`SummaryChapters.tsx`, `CaptionContext.tsx` y el sidebar muestran IA/subtítulos.
`Comments` en backend, `comments` en DB y los componentes `timeline` gestionan
comentarios con posición temporal y medios adjuntos.

`app/s/[videoId]/edit/TranscriptSidebar.tsx`, `lib/edit-transcript.ts` y
`workflows/edit-video.ts` permiten edición apoyada en transcript y remapeo de
palabras. No son una réplica completa del editor Studio de escritorio.
`edit-transcript.test.ts` verificó 25 casos de lógica y el sidebar 3 casos de
búsqueda. No se comprobó render final del edit ni colaboración simultánea.

## Autenticación y permisos

NextAuth en `packages/database/auth/auth-options.ts`: Google, Apple, email,
WorkOS/OIDC y trusted proxy condicional. `packages/web-backend/src/Auth.ts`
resuelve sesión o API key legacy; agentes tienen tokens y scopes separados.
`VideosPolicy.ts::buildCanViewLoaded` aplica propietario, membresías, grants,
dominios y contraseñas. `EffectiveVideoRules.ts` resuelve reglas heredadas.

Hay controles reales, pero Screenly debe adoptar privado por defecto y asegurar
que thumbnails, VTT, HLS, MP4, descargas y metadatos siguen la misma política.
`public-share-video.ts::isPublicShareVideoCandidateEligible` excluye candidatos
privados/restringidos; sus 8 pruebas no sustituyen una prueba de todas las rutas.
Detalles y riesgos en `SCREENLY_SECURITY.md`.

## Reutilizar y desarrollar

Reutilizar UI de biblioteca, permisos, upload y player. Reducir exposición de
features comerciales/agentes con decisiones explícitas, conservando contratos.
Desarrollar o completar: garantía privada en todas las vías de creación,
adaptador STT autoalojado, sincronización de captions locales, SRT consistente,
búsqueda global autorizada y pruebas E2E Windows/navegador. No se afirma que la
búsqueda actual del sidebar sea un índice global de la biblioteca.

## Límites comerciales heredados

`web-recorder-dialog.tsx` recibe `user.isPro`; `useWebRecorder.ts` aplica
`FREE_PLAN_MAX_RECORDING_MS` y la cabecera muestra Free/Pro. La presencia de
funciones en el código no garantiza disponibilidad para cualquier cuenta. Revisar
entitlements, cuotas y configuración self-host antes de definir el producto
Screenly; esta auditoría no elimina controles ni modifica condiciones comerciales.
