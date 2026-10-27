# Adaptador S3 aislado y auditoría de cancelación HLS

Continuación de 1.5B.6B.2 sobre
`3a1d105b9ee7bdc145b063a272d3566307a18ad2`, en `feature/screenly-phase-0`.
El usuario autorizó coordinación, implementador S3 y auditor independiente.
No se activa reproducción, publicación, CAS ni escritura de snapshots.

## Separación de tareas y revisión

- Coordinación: corrección del lock pendiente del motor, integración, documentación
  y comprobaciones conjuntas.
- Implementador: solo el adaptador S3 nuevo y su suite de pruebas; sin cambios a
  proveedores productivos, servicios, workers o rutas.
- Auditor: revisión de solo lectura, pruebas independientes y hallazgos remitidos
  al coordinador antes de integrar; sin editar el código revisado.

Los agentes comparten workspace y se asignaron archivos separados. Solo el
coordinador crea commits y publica. Esta organización no amplía autorización de
infraestructura, credenciales, esquema o despliegue.

La corrección previa solicita `reader.cancel()` con rechazo manejado y libera
inmediatamente el lock sin esperar su confirmación. Dos regresiones fallaban con
el código anterior y pasan tras corregirlo: cancelación que no termina después
de contenido inválido y después de abortar un reader.read pendiente. El auditor
repitió los 44 tests y comprobó cancelación rechazada con lock liberado y sin
unhandledRejection. Detalles en `SCREENLY_PHASE1_5B_HLS_SNAPSHOTS.md`.

## Arquitectura del adaptador

`apps/web/lib/hls-s3-verification-storage.ts::createHlsS3VerificationStorage`
implementa `HlsVerificationStorage` mediante un cliente AWS SDK inyectado.
Captura bucket y contexto de confianza, copia/congela el scope y devuelve una
interfaz congelada de solo `head` y `open`.

No contiene configuración de credenciales, variables de entorno, selección de
bucket por espectador ni llamadas de firma, listado, copia o escritura. No se
registra en el backend ni se exporta desde barrels. El cliente y binding deben
ser resueltos por un llamador interno autorizado en una integración futura.

Cada petición comprueba señal, proveedor S3, identidad v1 y key de hasta 1024
caracteres, bajo el prefijo exacto de propietario/vídeo/intento/generación del
contrato. Rechaza traversal, esquemas externos, query/fragmentos, claves ajenas,
versionId `null` e identidades incompletas antes de llamar al SDK.

| Operación | Parámetros enviados                                                                                               | Respuesta exigida                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| HEAD      | HeadObjectCommand con Bucket fijo, Key validada, VersionId explícito, IfMatch y ChecksumMode ENABLED; abortSignal | HTTP 200, sin delete marker/rango, longitud positiva segura y metadatos de identidad reales |
| GET       | GetObjectCommand con los mismos parámetros y sin Range/PartNumber                                                 | HTTP 200 completo, body y las mismas comprobaciones de identidad                            |

La observación devuelta usa VersionId, ETag, tamaño y checksum **del resultado
SDK**. No se copia la identidad esperada como si se hubiera observado. Una
identidad distinta se rechaza; la longitud observada se devuelve para que el
motor la compare con el tamaño del inventario.

## Checksum y compatibilidad

Se exige `ChecksumType=FULL_OBJECT` y ChecksumSHA256 base64 canónico de 32 bytes.
El digest se convierte a hex y se compara con el SHA256 del contrato. Faltas,
codificaciones ambiguas, padding no canónico y COMPOSITE se rechazan.

ETag no se interpreta como hash íntegro: puede ser multipart. Una respuesta con
ETag multipart y checksum FULL_OBJECT fiable puede admitirse; un checksum
compuesto no se equipara a SHA256 de bytes. El motor vuelve a calcular el hash
del contenido recibido; los headers por sí solos no prueban esos bytes.

Esta política es estricta: proveedores S3 compatibles, buckets sin versionado,
objetos antiguos o configuraciones sin checksum FULL_OBJECT pueden no servir.
No hay fallback a latest, ETag solo, checksum compuesto ni URL firmada. Tampoco
se añaden cabeceras/checksums a objetos existentes para aparentar compatibilidad.
Se admiten nombres convencionales de bucket; no se declara soporte de access
point ARN, directorios S3 ni todas las variantes de endpoint del SDK.

## Streaming y errores

El body SDK se convierte con transformToWebStream, sin arrayBuffer, texto ni
acumulación del objeto completo. Un wrapper transmite con backpressure y
sanea errores del stream. Cancelar el consumidor o la señal cancela el origen,
libera el lock local y elimina el listener; no espera indefinidamente una
confirmación del proveedor.

Respuestas parciales, delete markers, identidad/checksum inválidos o errores de
conversión destruyen/cancelan el body cuando está disponible. Si el SDK devuelve
un GET después de abortar, se descarta en vez de entregar bytes. Los errores no
exponen mensajes de AWS, URLs, claves de credenciales ni respuestas de origen.
No se añaden credenciales al manifiesto o a receipts.

Los deadlines, límites de tamaño total, hash efectivo, preflight y comprobación
HEAD/GET/HEAD completos siguen perteneciendo al motor. El adaptador no es un
endpoint viewer ni implementa Range HLS; su GET es de verificación completa de
un objeto identificado. No se reutiliza como ruta pública automáticamente.

## Validación y pruebas

**382 pruebas aprobadas en nueve archivos**, incluidas 53 del adaptador S3.
El auditor ejecutó independientemente 97 casos (53 S3 y 44 motor) y no encontró
hallazgos bloqueantes. La corrección de cancelación también pasó una prueba
adicional con cancelación rechazada, lock liberado y cero unhandledRejection.

```bash
bun run --cwd apps/web test \
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

SDK send está simulado; se usan comandos reales y streams locales Node/Web.
Se comprueban parámetros, observaciones reales, checksums ambiguos, metadata
alterada, respuestas parciales, body ausente o tardío, límites de key, errores,
cancelación que no termina y composición con el motor. El caso de bytes corruptos
falla aunque los headers repitan el SHA256 esperado: el motor calcula el hash.
No hay conexión a S3/MinIO/Drive ni servicios compartidos.

El typecheck conjunto detectó un problema de la fixture: las firmas de streams
Node y DOM difieren en los tipos instalados. Se corrigió con un puente de stream
explícito tipado y sin any/supresiones; no cambia código del adaptador. Typecheck
web final aprobado sin errores. Biome, formato y diff aprobados. El media server
conserva los siete errores previos: tres TS2352 en drive-resumable-upload.test.ts
(107/124/141), TS2769 en media-routes-real-world.integration.test.ts (1061),
TS2322 en media-size.test.ts (34), dos TS2345 en capcodec-encoder.ts (337/344).

La búsqueda de imports del adaptador solo encuentra el nuevo test. Solo se añaden
el módulo, su test y este documento, además de la corrección aislada del lector y
su documentación en commits anteriores. Sin dependencias, lockfiles, schema,
migraciones, cambios de workers o servicios.

## Riesgos y siguiente paso

Estas pruebas no comprueban IAM, ACL, permisos KMS, retención de versiones,
políticas del bucket, soporte de checksum de un proveedor real, sockets o coste.
El cliente SDK inyectado es una frontera de confianza: no se protege frente a
un cliente malicioso que falsifique resultados o cambie internamente su endpoint.
El binding debe resolver el almacenamiento real del vídeo; el validador no
autentica usuarios ni otorga intención de publicación.

Un snapshot sigue siendo un descriptor verificado en memoria, no una copia WORM
ni una prueba de disponibilidad futura. La verificación completa de bytes no
valida fMP4, códecs ni timeline. La vía de workers y la reproducción actual
permanecen sin cambios; sus URLs legacy no se invalidan por añadir este módulo.

Tras revisar esta entrega, el siguiente candidato es un adaptador Drive aislado
con garantías explícitas de revisión. Storage real necesita entorno autorizado.
Persistencia, CAS, escritores, migraciones, proxy HLS y rollout continúan fuera
de alcance y necesitan aprobación propia. `main` y estado Draft/Ready del PR #1
permanecen intactos; no se fusiona ni despliega.
