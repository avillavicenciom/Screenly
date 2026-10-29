# Fase 1.5B.4 — proxy de reproducción MP4

Implementación del incremento 4 en `feature/screenly-phase-0`, sobre
`d34ed65e6fa890c83ae57e9ff5d3f2aec7c2f418`. No constituye autorización para
desplegar ni una certificación de seguridad de toda la aplicación. Los
incrementos 1–3 se describen en `SCREENLY_PHASE1_5B_INTERNAL.md`; el diseño
aprobado está en `SCREENLY_PHASE1_5_REVOCATION_DESIGN.md`.

## Auditoría de rutas y consumidores

| Ruta o emisor                                                                  | Consumidores y comportamiento                                                                                    | Alcance de este incremento                                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/share-playback.ts`, `getSharePlaybackUrl`                                 | La página `app/s/[videoId]/page.tsx` proporciona `initialPlaybackUrl` al reproductor                             | Devuelve una URL relativa del proxy para `Mp4Source`, sin adquirir storage ni firmar                                                                |
| `app/api/playlist/route.ts`, `getPlaylistResponse`                             | `ShareVideo.tsx`, `Share.tsx`, `EmbedVideo.tsx`, `EditVideoClient.tsx` y `share-video-metadata.ts` solicitan MP4 | Solo fuentes `desktopMP4`/`webMP4`, sin `fileType`, con `videoType=mp4` o `master`, redirigen al proxy del mismo origen; ninguna firma en esta rama |
| `app/api/playback/mp4/route.ts`                                                | URL inicial y resolución de playlist anteriores                                                                  | Nueva entrega de bytes GET/HEAD/Range, sin redirect al origen                                                                                       |
| `app/api/storage/object/route.ts`                                              | Capacidades de objeto legacy y consumidores todavía no migrados                                                  | Sin cambios; conserva su compatibilidad y sus riesgos                                                                                               |
| Otras ramas de `/api/playlist`                                                 | HLS, segmentos, init, audio, VTT, raw-preview y exportación; `videoType=mp4` para fuentes que no son `Mp4Source` | Sin migrar; algunas ramas todavía firman objetos MP4                                                                                                |
| `app/api/mobile/[...route]/route.ts`, rama `source instanceof Video.Mp4Source` | API móvil devuelve `getSignedObjectUrl(source.getFileKey())`                                                     | Sin migrar                                                                                                                                          |
| `packages/web-backend/src/Videos/index.ts`, descarga de vídeos                 | RPC `app/api/[[...route]]`, descargas y clientes de backend                                                      | Conserva URLs firmadas para descarga; sin migrar                                                                                                    |
| `Storage`, `S3BucketAccess` y clientes de bucket                               | S3, CloudFront, Drive, APIs y procesamiento interno                                                              | Se añade una lectura S3 de bytes independiente; las interfaces de firma y procesamiento anteriores permanecen                                       |

La API v1, los flujos de developer videos/embed y las herramientas de importación
son superficies distintas, no migradas por esta ruta. `/api/download` entrega
instaladores, no es el proxy de vídeos de la biblioteca. No se cierra ningún
endpoint legacy en este incremento.

`app/s/[videoId]/_components/playback-source.ts`, `resolvePlaybackSource`, realiza
un GET de sondeo `Range: bytes=0-0`, cancela su cuerpo y utiliza la URL resuelta.
Acepta el nuevo path relativo sin extensión `.mp4`. `CapVideoPlayer.tsx` conserva
su resolución y los mecanismos existentes de recuperación. El fallback
`raw-preview` continúa separado y fuera del proxy MP4; no se presenta como una
ruta ya migrada. No se modifican grabación Windows/web, subida progresiva,
procesamiento, extracción de audio, transcripción ni credenciales de workers.

## Autorización y flujo de bytes

1. `getResponse` valida `videoId` y rechaza un parámetro `key`. El cliente no
   puede elegir bucket, clave, proveedor o URL de origen.
2. `provideOptionalAuth` vincula la identidad actual y los adjuntos de contraseña.
   `Videos.getByIdForViewing` ejecuta la política existente, que consulta el vídeo
   y sus permisos; no hay caché de decisiones en el proxy entre peticiones.
3. Se exige además que la organización exista y no tenga `tombstoneAt`, también
   para el propietario. Un vídeo ausente o una denegación devuelve 404; un fallo
   de autenticación/repositorio no reconocido devuelve 503. No se intenta storage
   ni fallback público/legacy ante estos fallos.
4. Solo se admite `Video.Mp4Source`. Se valida tanto el `outputKey` persistido
   como la clave resuelta: prefijo exacto `ownerId/videoId/`, extensión `.mp4`,
   caracteres acotados y ausencia de segmentos `.`/`..`. La validación explícita
   evita que el fallback de `Mp4Source.getFileKey` oculte un `outputKey` inválido.
5. Después de autorizar se obtiene `Storage.getAccessForVideo` y `headObject`.
   HEAD termina aquí, sin leer el cuerpo. GET valida el rango y abre un stream.
6. S3 usa `getPlaybackObjectResponse` con el cliente interno configurado,
   `GetObjectCommand`, `Range`, `IfMatch` del ETag y `abortSignal`. No utiliza el
   firmador público ni una URL CloudFront. Drive usa su `getObjectResponse`
   existente con señal de cancelación. `withPublishedRecordingOutput` mantiene
   la resolución de las salidas publicadas y de mejora de audio.
7. `playbackStream` propaga cancelación y errores de lectura, con backpressure.
   No llama a `arrayBuffer`, `transformToByteArray` ni carga el MP4 completo.
   Se construyen cabeceras permitidas; no se reenvían Location, cookies ni
   cuerpos de error del proveedor. Redirects y respuestas incoherentes se
   cancelan y producen 502 vacío.

Un token legacy válido no sustituye la sesión/política del espectador. El
parámetro `token` no concede permisos en la nueva ruta. No se crean ni reutilizan
credenciales administrativas, capacidades de procesamiento o grants nuevos.
El almacenamiento usa sus credenciales configuradas existentes.

## Semántica HTTP y caché

| Petición o resultado                          | Respuesta                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET completo autorizado                       | 200 y stream `video/mp4`; Content-Length, ETag cuando existe, Accept-Ranges y nosniff |
| HEAD autorizado                               | 200, mismos metadatos, sin lectura del cuerpo; Range no se aplica a HEAD              |
| Range único acotado, abierto o sufijo         | 206, Content-Range y Content-Length del intervalo                                     |
| Range mal formado, múltiple o no satisfacible | 416 vacío, `Content-Range: bytes */tamaño`; sin lectura de bytes                      |
| If-Range igual al ETag fuerte                 | Conserva Range                                                                        |
| If-Range distinto, débil o fecha no resuelta  | Ignora Range y entrega 200 completo                                                   |
| 416 del proveedor                             | 416 vacío saneado; sin XML ni mensajes de origen                                      |
| Error de storage o respuesta incoherente      | 502 vacío; se cancela el cuerpo cuando procede                                        |
| Denegación o inexistencia                     | 404 vacío antes de obtener storage                                                    |
| Fallo de autenticación/DB                     | 503 vacío antes de obtener storage                                                    |

Las respuestas servidas por el proxy, incluidos errores, HEAD y 416, llevan
`Cache-Control: private, no-store`, `CDN-Cache-Control: no-store`,
`Vercel-CDN-Cache-Control: no-store`, `Pragma: no-cache` y `Expires: 0`, mediante
`privateResourceResponse`. Se aplica también a vídeos públicos en esta ruta.
El redirect de playlist apunta solo al proxy relativo y conserva no-store.
Las políticas de otros recursos no se amplían en este incremento.

Los rangos inválidos se evalúan tras autorizar y consultar el tamaño: pueden
leer metadatos, pero no bytes. Las denegaciones de autorización verificadas
no obtienen acceso a storage, no leen metadatos, no listan y no firman objetos.

## Pruebas y comprobaciones ejecutadas

Entorno preparado existente: Node 24 y Bun 1.4.4; sin cambios de dependencias,
lockfiles, esquema o migraciones. No se arrancaron servidores, Docker ni
servicios externos. No se modificó el VPS.

**265 pruebas aprobadas en 13 archivos** con Vitest:

```bash
bun run --cwd apps/web test \
  __tests__/unit/mp4-playback-route.test.ts \
  __tests__/unit/s3-playback-stream.test.ts \
  __tests__/unit/share-playback.test.ts \
  __tests__/unit/segment-playlist-route.test.ts \
  __tests__/unit/playback-source.test.ts \
  __tests__/unit/share-player-expired-url.test.ts \
  __tests__/unit/private-resource-authorization.test.ts \
  __tests__/unit/storage-object-verification.test.ts \
  __tests__/unit/storage-object-response-headers.test.ts \
  __tests__/unit/media-capability.test.ts \
  __tests__/unit/media-extraction-capability.test.ts \
  __tests__/unit/media-client.test.ts \
  __tests__/unit/thumbnail-published-output.test.ts
```

La suite del proxy ejecuta el handler Effect HTTP real y `buildCanViewLoaded`,
con identidad, repositorios, DB y almacenamiento sustituidos por fixtures.
Comprueba propietario, miembro, anónimo, ajeno, token legacy firmado válido,
revocación de membresía, público a privado, contraseña cambiada, vídeo eliminado,
organización eliminada, otro ID, clave ajena/traversal/no MP4, HEAD, rangos,
200/206/416, If-Range, fallos DB/storage, ausencia de URLs de origen, cancelación
e interrupción. Distingue un stream admitido antes de revocar de la siguiente
petición Range denegada sin storage.

La suite S3 ejecuta el adaptador real con `client.send` simulado y un stream
Node real: verifica comando, IfMatch, señal, 200/206, cancelación y 416; el
firmador público está inutilizado en las pruebas de lectura. Drive tiene una
prueba del contrato de su interfaz, no una conexión al servicio real. Las
regresiones de playlist, miniaturas, tokens, reproductor y capacidades internas
siguen pasando. Son pruebas aisladas, no E2E de reproducción/búsqueda.

`bun run tsc-rs -p apps/web/tsconfig.json --noEmit`: aprobado sin errores;
persisten avisos/sugerencias de Effect del proyecto. Biome sobre los 11 archivos
TS modificados, Prettier sobre este documento y `git diff --check`: aprobados.

`bun run tsc-rs -p apps/media-server/tsconfig.json`: falla con los **mismos siete
errores preexistentes**, comparados con el informe previo sin diferencias:

| Archivo dentro de `apps/media-server/src/`                              | Errores                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `__tests__/lib/drive-resumable-upload.test.ts`, líneas 107, 124 y 141   | Tres TS2352: fixtures fetch sin `preconnect`   |
| `__tests__/lib/media-routes-real-world.integration.test.ts`, línea 1061 | TS2769: código de error incompatible           |
| `__tests__/lib/media-size.test.ts`, línea 34                            | TS2322: unión de cabeceras con undefined       |
| `lib/capcodec-encoder.ts`, líneas 337 y 344                             | Dos TS2345: input no reducido a ReadableStream |

## Garantías y riesgos pendientes

- Cada nuevo GET, HEAD o Range al proxy vuelve a consultar autorización. No se
  revoca retroactivamente un stream admitido, un buffer del navegador o una copia
  descargada. Una revocación concurrente después de autorizar puede dejar
  completar esa petición; las siguientes deben usar el estado ya confirmado.
- No se ha probado MySQL real, replicación/cachés de lectura ni concurrencia
  transaccional. La garantía requiere una fuente de permisos actualizada.
- No se ha probado S3/MinIO/CloudFront/Drive real, ACL/políticas de buckets,
  origen público ni invalidación de firmas previas. Enlaces directos antiguos
  y emisores no migrados siguen siendo un riesgo hasta el corte autorizado.
- S3 usa IfMatch para reducir carreras entre HEAD y GET; Drive no añade aquí
  una fijación de revisión equivalente. Reemplazos concurrentes y diferencias
  de metadatos se deben probar con proveedores reales.
- Falta E2E de búsqueda temporal, cookies/contraseñas, embeds, navegadores,
  desconexión real, CDN y recepción de bytes por Next en despliegue. Los tests
  de streams no certifican el buffering de un proxy de infraestructura.
- Pasar los bytes por la aplicación añade consultas y ancho de banda. Faltan
  medidas autorizadas de carga, latencia, cuotas y límites de abuso.
- La política existente conserva sus reglas de propietario y contraseña. No
  se añaden epochs, grants de invitados ni nueva lógica de revocación de tokens.

## Condiciones antes del incremento 5

Revisar y aprobar este commit y su alcance parcial. Preparar un entorno aislado
autorizado para MySQL y almacenamiento real, verificar reproducción y Range en
navegador y confirmar las políticas efectivas de origen/caché. Inventariar los
consumidores de thumbnail/GIF/VTT/comentarios antes de su migración, conservando
las capacidades internas y sin cerrar legacy prematuramente.

**Punto de parada:** incremento 4 terminado para revisión; el incremento 5 no
está implementado. PR #1 debe permanecer en borrador, sin merge a `main`,
despliegues ni migraciones aplicadas.
