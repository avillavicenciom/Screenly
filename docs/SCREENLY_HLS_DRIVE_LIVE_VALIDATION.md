# Validación real y aislada de revisiones Drive

Fecha: 2026-10-27. Rama `feature/screenly-phase-0`, base `ae5be198a`.
Alcance: pruebas optativas y documentación. No se modifica código productivo.

## Preparación e identidad

El responsable subió `init.mp4` y `segment_000.m4s` del paquete sintético de
`docs/fixtures/screenly-hls-fixtures.zip` a la carpeta privada de laboratorio.
Un inventario acotado a sus hijos directos, máximo 20 resultados y sin papelera,
encontró exactamente una coincidencia para cada nombre, sin página pendiente.
Se comprobó pertenencia a la carpeta, `trashed=false`, tamaño, SHA256 y presencia
de `headRevisionId`. No se buscó contenido fuera de esa carpeta.

Los tamaños y hashes coinciden con los registrados **antes de subir** en
`SCREENLY_HLS_DRIVE_LAB.md`: init 826 bytes, segmento 1151 bytes. Drive reporta
respectivamente `video/mp4` y `application/octet-stream`, ambos admitidos por el
adaptador. Se conservó el mapping de confianza con fileId/revisionId fuera de
Git; no se publican identificadores reales ni credenciales.

El inventario solo prepara la asociación entre las dos muestras declaradas y
sus identificadores. No constituye prueba de publicación ni sustituye la lectura
de bytes, hashes, revisiones o permisos. No se usa `listObjects` ni se activa una
generación HLS a partir de un listado.

## Runner optativo

`apps/web/__tests__/integration/hls-drive-real-storage.test.ts` se omite por
defecto. Solo se ejecuta con `SCREENLY_HLS_DRIVE_LIVE=1` y requiere mapping local
y el secreto `SCREENLY_HLS_TEST_DRIVE_ACCESS_TOKEN` configurado de forma segura.
La presencia de credenciales por sí sola no activa ninguna conexión.

El mapping es un array de dos objetos estrictos con `name`, `size`, `sha256`,
`fileId`, `revisionId` y `mimeType`. Se leen como máximo 64 KiB más un byte de
control, con UTF-8 estricto y errores genéricos. Nombres únicos, hashes y tamaños
deben coincidir con las muestras locales fijadas en el test, y los dos fileIds
deben ser distintos. Los identificadores deben proceder del inventario revisado;
el runner no lista archivos ni revalida `parents`.

El scope usa identificadores ficticios de laboratorio, independientes de la DB.
El manifiesto VOD v1 se sella con `sealHlsInventory`; nunca se guarda como una
generación activa ni se entrega a espectadores.

El transporte inyectado permite exclusivamente GET al origen fijo
`https://www.googleapis.com` y las rutas de metadatos o revisión exacta de los
dos archivos del mapping. Rechaza redirects, otros métodos y más de 12 peticiones
por caso. Conserva la señal, `cache: no-store`, Accept y Accept-Encoding del
adaptador. El caso completo tiene plazo de 15 s, dos objetos, máximo 2048 bytes
por objeto y 4096 en total. Se mantiene TLS y el proxy del entorno.

```bash
export PATH=/workspace/.tools/node_modules/.bin:$PATH
NODE_USE_ENV_PROXY=1 \
SCREENLY_HLS_DRIVE_LIVE=1 \
SCREENLY_HLS_TEST_DRIVE_MAPPING_FILE=/ruta/privada/mapping.json \
bun run --cwd apps/web test \
  __tests__/integration/hls-drive-real-storage.test.ts
```

`NODE_USE_ENV_PROXY=1` permite al fetch de Node 24 usar el proxy heredado. Antes
de repetir una conexión se debe comprobar la política y la disponibilidad actual
de la credencial; estar configurada no garantiza autorización del proveedor.

## Compatibilidad del secreto del entorno

La primera ejecución tuvo **4 casos aprobados y 5 fallidos**: los casos con IO
fallaron antes de enviar peticiones, en la comprobación sintáctica del token de
`fetchFixed` en `apps/web/lib/hls-drive-verification-storage.ts`. El secreto de
red puede entregarse como marcador del proxy, no como OAuth utilizable por el
código local. No se imprimió ni inspeccionó su contenido para diagnosticarlo.

La corrección se limita al transporte del test: `getAccessToken` entrega un
marcador fijo no secreto y el fetch inyectado exige ese Authorization exacto.
Solo después de validar origen, ruta, método y presupuesto sustituye el header
por el secreto del entorno, para su entrega mediante el proxy. No se cambia ni
se relaja la validación del adaptador, no hay fallback a otra credencial, latest,
URL firmada o endpoint productivo.

Por tanto, la prueba valida adaptador y motor **con este transporte de confianza**;
no valida el cargador OAuth productivo ni demuestra compatibilidad directa entre
la validación sintáctica del adaptador y todos los mecanismos de secretos de
Codex. Una futura integración debe resolver explícitamente esa frontera.

## Resultados observados

**9 casos aprobados con Drive real**, ejecución inicialmente completa en 4,45 s;
repetición final tras acotar y sanear el lector del mapping: **9/9 en 6,23 s**.
La preparación del inventario es independiente de estos conteos.

| Caso                                                | Resultado observado                                                              |                 HTTP del caso |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------: |
| Manifiesto correcto, init y segmento                | Descriptor congelado; 1977 bytes leídos y SHA256 recalculado; revisiones exactas | 10 GET: 8 metadatos y 2 media |
| Revisión esperada incorrecta                        | `object-changed` contra el head observado, sin lectura media                     |            1 GET de metadatos |
| SHA256 esperado incorrecto                          | `object-changed`, sin lectura media                                              |            1 GET de metadatos |
| Tamaño esperado incorrecto                          | `object-changed`, ningún snapshot devuelto                                       |            1 GET de metadatos |
| Key de otro vídeo                                   | `scope-mismatch` antes de IO                                                     |                             0 |
| FileId diferente del mapping                        | `scope-mismatch` antes de IO                                                     |                             0 |
| Digest del contrato incorrecto                      | `invalid-contract` antes de IO                                                   |                             0 |
| Señal abortada antes de abrir                       | `aborted` antes de IO                                                            |                             0 |
| Cancelación por consumidor de revisión real abierta | Cancelación local completada y lock liberado                                     |  3 GET: 2 metadatos y 1 media |

`head` significa consulta GET de metadatos, no HEAD HTTP. El caso completo usa
`createHlsDriveVerificationStorage` y `prepareVerifiedHlsSnapshot` sin reemplazar
las respuestas del proveedor por fixtures. La revisión incorrecta se compara
contra metadatos reales: no afirma haber descargado una revisión histórica o
haber probado un 404 real de revisiones.

Regresión offline: **148 pruebas aprobadas en tres archivos**, y las **9 live
omitidas** sin opt-in. Un auditor independiente ejecutó 95 casos (Drive 51 y
motor 44), comprobó la omisión del runner sin opt-in y revisó el transporte y
el lector acotado del mapping; no realizó conexiones remotas.

Typecheck web: `bun run tsc-rs -p apps/web/tsconfig.json --noEmit` terminó con
código 0; emitió advertencias y sugerencias Effect en archivos ajenos a este
incremento. Se verifica Biome del test, Prettier de los documentos y `git diff
--check`. No se ejecuta el typecheck del media server: no se modificó ese módulo.

## Límites y pasos pendientes

- Solo dos muestras pequeñas de un único Drive; no Shared Drives, cuotas,
  latencias sostenidas, retención, revisiones antiguas o purgadas.
- La cancelación de 826 bytes no demuestra cese de transferencia remota a mitad
  de un objeto grande ni comportamiento del socket bajo presión. La cancelación
  y los timeouts simulados siguen siendo evidencia distinta.
- No se modificaron ACL ni credenciales para probar denegación real, ni se
  escribieron objetos durante una lectura para provocar carreras. Esos ensayos
  requieren identidades y alcance adicionales.
- No se prueba autorización viewer, revocación de membresía, endpoints HLS,
  caché/Range, reproducción web/Windows, MySQL/CAS, S3/MinIO o E2E. El snapshot
  sigue en memoria; no hay persistencia WORM ni publicación autorizada.
- Los tokens temporales pueden caducar. Un 401 futuro no debe provocar fallback
  ni ampliación automática de permisos.

El resultado retira el bloqueo de falta de evidencia real **para estas lecturas
Drive concretas**. No certifica seguridad ni habilita uso real de Screenly.
La siguiente implementación debe revisarse como incremento separado: completar
la matriz pendiente y diseñar la persistencia/publicación, sin activar el proxy
antes de aprobar sus condiciones de autorización y revocación.

No hay cambios productivos, dependencias, lockfiles, schemas, migraciones,
servicios, infraestructura o VPS. `main` intacta, PR #1 en borrador, sin merge.
