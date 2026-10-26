# Fase 1.4 — corrección de caché privada

Este incremento corrige los tres huecos de caché identificados en fase 1.3.
No cambia autorización, firma, TTL ni revocación de tokens. Sin migraciones,
servicios compartidos, APIs de pago, despliegue o modificaciones del VPS.

## Rutas y consumidores trazados antes del cambio

| Ruta                  | Consumidores identificados                                                                                               | Respuestas afectadas                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `/api/video/preview`  | `components/VideoThumbnail.tsx`, `VideoPreviewGif.tsx`, `lib/video-share-clipboard.ts`, `lib/share-video-metadata.ts`    | Redirect GIF y fallback OG; errores GET/HEAD                          |
| `/api/thumbnail`      | `app/s/[videoId]/edit/EditVideoClient.tsx`, `CallToActionDialog.tsx`                                                     | JSON con URL firmada, ausencia/denegación y errores; HEAD explícito   |
| `/api/storage/object` | `packages/web-backend/src/Storage/index.ts::createDriveObjectUrl`, `lib/comment-media.ts`, descargas internas multimedia | Bytes, HEAD, redirects hacia storage, errores y descriptores internos |

Se consultaron `AGENTS.md`, las instrucciones web y la documentación de Route
Handlers de Next instalada antes de modificar las rutas.

## Política aplicada

`apps/web/lib/private-resource-response.ts::privateResourceResponse` normaliza
las respuestas de los tres handlers, incluidos los retornos anticipados:

```http
Cache-Control: private, no-store
CDN-Cache-Control: no-store
Vercel-CDN-Cache-Control: no-store
Pragma: no-cache
Expires: 0
```

Se clonan cabeceras, porque `Response.redirect` tiene cabeceras inmutables.
Se conserva status, Location, Content-Type, rangos, longitudes, ETag, cabeceras
CORS y Vary existentes. HEAD conserva metadatos y status sin devolver cuerpo.
El helper no procesa ni materializa los bytes de streaming.

No se infiere caché pública solo desde `video.public`: hay restricciones
heredadas y estas respuestas entregan capacidades firmadas. Por eso estos tres
endpoints usan no-store incluso al acceder a un vídeo público; su acceso anónimo
permitido sigue funcionando. El coste es volver a resolver esos enlaces.
No se cambian políticas de assets públicos, OG, CDN de destino ni otras rutas.

## Regresiones y validación

- Antes del cambio: 28 casos fallidos en la matriz ampliada por cabeceras ausentes,
  caché pública y HEAD de thumbnail no exportado; 35 casos aprobados.
- Después: 164 pruebas aprobadas en ocho archivos, incluida la matriz ampliada
  de 66 casos de autorización/ciclo/caché. Casos negativos son resultados
  esperados, no pruebas omitidas.
- GET/HEAD autorizado y denegado, parámetros ausentes, fallos de storage,
  fallback OG y acceso anónimo público mantienen sus status y tienen no-store.
- La suite de contenido del proxy exige también no-store para tipos MIME,
  adjuntos, byte ranges 206 y HEAD. La suite de verificación interna exige
  no-store en respuestas de éxito y error, incluyendo autenticación interna,
  identidad de objetos y conflictos. Se preservan los contratos de descarga.
- Typecheck completo (`next typegen` y `tsc-rs -b`) y Biome sobre archivos TS
  modificados; documentación con Prettier y `git diff --check`.

Desde la raíz, con Bun 1.4.4 en PATH:

```bash
bun run --cwd apps/web test __tests__/unit/private-resource-authorization.test.ts __tests__/unit/storage-object-route.test.ts __tests__/unit/storage-object-verification.test.ts __tests__/unit/storage-object-response-headers.test.ts __tests__/unit/thumbnail-published-output.test.ts __tests__/unit/segment-playlist-route.test.ts __tests__/unit/video-preview-gif.test.ts __tests__/unit/comment-media-token.test.ts
bun run typecheck
```

Las pruebas usan handlers reales y fixtures de servicios/storage; no escuchan
puertos ni contactan S3/MySQL. La comprobación de UI GIF y de contratos multimedia
no sustituye reproducción E2E en navegador o validación de almacenamiento real.

## Riesgos y tareas pendientes

Los tokens bearer antiguos siguen siendo válidos hasta su caducidad aunque se
retire una membresía. No-store no revoca enlaces, no elimina copias descargadas
y no purga cachés previas. Tras un despliegue futuro autorizado habrá que tratar
cachés existentes y verificar que navegador/CDN/proxy obedecen estas cabeceras.
La política de los objetos S3/CDN de destino y los permisos efectivos de buckets
continúan sin comprobarse. Rutas alternativas de móvil, agentes, SDK y acciones
requieren cobertura adicional. No se declara Screenly listo para uso real.

La fase 1.3 se conserva como evidencia histórica: sus observaciones de caché
describen el código anterior a este incremento. El comportamiento de revocación
que describe sigue vigente. PR #1 debe permanecer en borrador y sin fusionar.
