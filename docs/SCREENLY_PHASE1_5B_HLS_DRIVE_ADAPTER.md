# Adaptador Drive aislado para verificación HLS

Base: `8dc07826118044e99ec3f584a37e2b556e98f170`, rama
`feature/screenly-phase-0`, árbol inicialmente limpio. Continuación autorizada
del trabajo pendiente con implementador y auditor independientes; coordinación,
validación conjunta y publicación centralizadas. No se activa el proxy HLS ni
la publicación; no se modifican writers, workers, DB, infraestructura o permisos.

## Capacidad soportada y límites de identidad

El código existente en `packages/web-backend/src/Storage/GoogleDrive.ts`,
`getGoogleDriveRecordingResponse` y `getGoogleDriveRecordingDownload`, utiliza
metadatos de files.get y lectura de revisión mediante:

```text
https://www.googleapis.com/drive/v3/files/{fileId}/revisions/{revisionId}?alt=media
```

El contrato HLS v1 requiere fileId, revisionId, SHA256 y tamaño. Los metadatos de
archivo observados incluyen headRevisionId, sha256Checksum y size. No se inventa
un SHA256 de revisión a partir de lo solicitado por el manifiesto.

Se admite solo la revisión solicitada que coincide con el headRevisionId
observado y cuyo hash/tamaño se pueden comprobar. El adaptador vuelve a observar
los metadatos alrededor de la apertura; el motor también lo hace después de leer
los bytes y calcula SHA256 efectivo. Si cambia el head, falta identidad fiable o
no se puede asociar una revisión histórica con el SHA256, se rechaza. No hay
fallback a latest, URL firmada, webContentLink o contenido de otra revisión.

Es una restricción deliberada: una revisión anterior puede seguir existiendo en
Drive y, aun así, no ser admisible aquí. El adaptador no establece retención
keepForever, copia revisiones ni demuestra que Drive las conservará en el futuro.

Referencias públicas para contrastar antes de una integración real:

- https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions
- https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions/get

Los intentos de leer estas páginas y el discovery público desde este entorno
devolvieron HTTP 403. No se presentan como documentación remota verificada. La
base comprobada es el código existente y los tests con fixtures; hacen falta
verificación de API real y entorno autorizado antes de cualquier activación.

## Fronteras de confianza

`apps/web/lib/hls-drive-verification-storage.ts::createHlsDriveVerificationStorage`
implementa la interfaz existente. Depende de transporte,
carga de credencial y resolver lógico inyectados, no de configuración productiva.
El cliente no elige fileId para conseguir acceso: primero se valida la key bajo
el prefijo exacto de vídeo/propietario/intento/generación y un resolver interno
de confianza la asocia al fileId dentro del binding. Debe coincidir además con
la identidad del inventario; una asociación ausente o distinta no permite leer.

El binding no sustituye la autorización de un trabajo o espectador. El llamador
futuro deberá autenticar y resolver el storage real del vídeo antes de usarlo.
No hay ruta viewer, parámetros arbitrarios de bucket/origen ni nuevas capacidades.

Las peticiones se construyen contra el origen fijo de Google Drive, sin usar
URLs de metadatos o respuestas para redirigir credenciales. Redirects se rechazan
sin seguirlos. No se devuelve autorización, token, mensaje de proveedor o URL de
origen en observaciones/errores del adaptador.

## Lectura y composición

La operación `head` de la interfaz es una consulta de **metadatos por GET** a
Drive, no una afirmación de que la API tenga HEAD HTTP para estos campos.
`open` solicita bytes de la revisión explícita y devuelve un stream y observación
comprobada. El motor conserva límites totales, plazo, lectura incremental,
hash efectivo, comprobación posterior y creación del descriptor congelado.

Se exige metadata binaria con id, headRevisionId, SHA256, tamaño positivo seguro
y trashed=false. MIME admitidos: video/mp4, audio/mp4, video/iso.segment,
audio/iso.segment y application/octet-stream. La lectura exige Content-Length
exacto y Content-Type coherente (o application/octet-stream), sin Content-Range
ni codificación de contenido. Los metadatos tienen límite de 64 KiB y decodificación
UTF-8 estricta, rechazando chunks vacíos que no avanzan el presupuesto.

Los archivos nativos de Google Docs no son fMP4 binario; no se exportan ni se
convierten automáticamente. Respuestas parciales, contenido no esperado,
identidad incompleta o cuerpo ausente deben fallar cerrado. Cancelación y limpieza
de recursos no deben esperar indefinidamente la confirmación del proveedor.

Los metadatos se consumen con un límite explícito; no se debe convertir una
respuesta ilimitada en JSON. El contenido multimedia no se acumula completo.
Se preserva la separación entre verificación de declaraciones, bytes, existencia,
estabilidad de revisiones, intención de publicación y autorización actual.

## Pruebas y auditoría

**433 pruebas aprobadas en diez archivos**, incluidas **51 del adaptador Drive**.
El auditor ejecutó independientemente 95 casos (51 Drive +44 motor), sin
hallazgos bloqueantes finales. Detectó un bucle de metadata sin progreso con
chunks vacíos; se corrigió y añadió la regresión antes de integrar.

```bash
bun run --cwd apps/web test \
  __tests__/unit/hls-drive-verification-storage.test.ts \
  __tests__/unit/hls-s3-verification-storage.test.ts \
  __tests__/unit/hls-snapshot-verification.test.ts \
  __tests__/unit/hls-publication-contract.test.ts \
  __tests__/unit/hls-publication-characterization.test.ts \
  __tests__/unit/segment-playlist-route.test.ts \
  __tests__/unit/mp4-playback-route.test.ts \
  __tests__/unit/viewer-derivatives.test.ts \
  __tests__/unit/media-extraction-capability.test.ts \
  __tests__/unit/desktop-segments-manifest-contract.test.ts
bun run tsc-rs -p apps/web/tsconfig.json --noEmit
bun run tsc-rs -p apps/media-server/tsconfig.json
```

Se verifican key/scope/identidad antes de IO, mapping ausente o ajeno, URL y
headers efectivos, redirects, cambio de revisión/checksum/tamaño, trashed,
Google Docs, contenido no esperado/parcial, JSON inválido/UTF-8/tamaño/chunks,
abort, timeout, body tardío, cancelación que no termina y composición con el motor.
Un rechazo del adaptador dentro del motor se normaliza a storage-unavailable;
no se modifica esa semántica ni se permite continuar la verificación. El caso
de mutación posterior a los bytes comprueba el cuarto GET de metadatos y falla
cerrado; las pruebas directas del adaptador conservan object-changed.

Typecheck web final aprobado. La fixture deliberadamente malformada requiere
una frontera unknown para probar rechazos runtime sin any ni supresiones.
Biome, Prettier y diff comprobados. El typecheck independiente del media server
sigue dando siete errores preexistentes, sin tocar sus archivos: tres TS2352 en
drive-resumable-upload.test.ts (107/124/141), TS2769 en
media-routes-real-world.integration.test.ts (1061), TS2322 en media-size.test.ts
(34), dos TS2345 en capcodec-encoder.ts (337/344).

Las llamadas Drive se sustituyen por fixtures con tokens ficticios. No hay
storage real, E2E, servicios iniciados ni API de pago. La búsqueda de imports
solo encuentra el test: no hay integración productiva. Solo se publican dos
archivos TS nuevos y este documento, en commits separados de código y documentación.

## Riesgos pendientes y parada

Sin prueba real de API, OAuth/scopes, Shared Drives, permisos, retención,
revisiones purgadas, buffering, latencia, coste o sockets. El resolver y fetch
inyectados son de confianza; un transporte malicioso puede falsificar metadatos,
por lo que los tests no certifican el servicio. Incluso un hash válido no prueba
que el productor tuviera derecho a publicar ni que el fMP4 sea decodificable.

Los snapshots continúan en memoria. No hay copia WORM, registro activo, CAS,
migraciones, publicación, cambio de URLs legacy ni protección HLS activada por
añadir este adaptador. Un fallo de revisión debe denegar, nunca cambiar a otra
lectura para mantener playback a costa de identidad.

Una verificación completa del motor realiza cuatro consultas de metadatos y
una lectura media por objeto, además de resoluciones internas de binding. No se
ha medido latencia/cuota real; el techo de 30 segundos del motor puede limitar
inventarios grandes. No se relaja ni se añade caché de identidad para ocultarlo.

El siguiente paso requiere revisión y un entorno autorizado para contrastar
lecturas fijadas S3/Drive reales. Persistencia, CAS y adaptación de escritores
se propondrán como incrementos separados. No se cambia Draft/Ready del PR #1,
no se fusiona `main`, no se modifica el VPS ni se realiza despliegue.
