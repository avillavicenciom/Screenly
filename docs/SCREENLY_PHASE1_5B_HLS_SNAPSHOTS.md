# Fase 1.5B.6B.2 — verificación aislada y snapshots en memoria

Base: `af48dacef56c95af40cd6adb2e5af1473431fb6a`, rama
`feature/screenly-phase-0`, árbol inicialmente limpio. Se continúa con la fase
aprobada de identidades/snapshots, conservando fuera CAS, DB, escritores y proxy.
Se revisaron las instrucciones raíz/web y los contratos y diseño de publicación
anteriores. No hay cambios de comportamiento en endpoints productivos.

## Qué se implementa

`apps/web/lib/hls-snapshot-verification.ts::prepareVerifiedHlsSnapshot` es un
motor asíncrono **sin consumidores productivos**. Recibe un manifiesto sellado
v1, un contexto esperado del llamador y una interfaz de almacenamiento inyectada.
La interfaz no admite URLs ni firma objetos. En esta fase solo tiene una
implementación simulada en tests, con streams reales de Web Streams.

El resultado es un **descriptor verificado y congelado en memoria**, con el
manifiesto, binding lógico, receipts de objetos y total de bytes. No crea copias
físicas inmutables, no escribe manifiestos en un bucket ni persiste receipts.
No anuncia una generación, no hace CAS y no concede permisos de reproducción.

## Flujo y garantías locales

1. Valida estructura y digest con `validateHlsManifest` de 6B.1. La validación
   devuelve una copia; no se modifica ni congela el input del llamador.
2. Compara vídeo, propietario, intento, generación y proveedor con el contexto
   esperado. Exige coincidencia del binding lógico con el storage suministrado.
   El binding no viene de una ruta viewer ni selecciona un bucket por URL.
3. Rechaza tamaños/cantidades por encima del presupuesto antes de hacer IO.
   Solo procesa las entradas init/segment, no inventa objetos para las variantes
   lógicas ni lee recursos fuera del inventario validado.
4. Solicita HEAD con la identidad esperada y compara key, tamaño, proveedor y
   todos los campos de identidad. No acepta solo existencia o un ETag parecido.
5. Solicita lectura fijada a la misma identidad. Exige observación de identidad
   y tamaño de la respuesta antes de consumir su cuerpo.
6. Lee incrementalmente, cuenta bytes y calcula SHA256. Rechaza contenido
   cambiado, truncado o mayor que el tamaño declarado; no almacena el archivo
   completo ni devuelve sus bytes en el descriptor.
7. Vuelve a consultar la identidad después de terminar la lectura y comprueba
   el binding antes de nuevas operaciones y tras las observaciones relevantes.
   Solo al completar **todos** los objetos devuelve el descriptor congelado.

S3 compara versionId, ETag y SHA256; Drive compara fileId, revisionId y SHA256.
El hash se calcula también sobre los bytes recibidos: no basta con que HEAD
repita un checksum declarado. Los metadatos del proveedor siguen siendo una
observación a contrastar, no una autorización.

Una versión S3 antigua aún disponible puede verificarse si es exactamente la
versión declarada; cambiar el objeto latest no la convierte automáticamente en
otra versión. La interfaz HEAD debe observar la identidad solicitada, no sustituir
silenciosamente por latest. En Drive se necesita la misma precisión de revisión.

## Interfaces y responsabilidades del adaptador futuro

| Tipo                           | Responsabilidad                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `HlsVerificationScope`         | ownerId, videoId, attemptId, generationId, storageProvider y storageBindingId, obtenidos de contexto interno de confianza |
| `HlsVerificationStorage`       | Binding efectivo y funciones `head`/`open`; no métodos de escritura, listado o firma                                      |
| `HlsPinnedRead`                | Key validada, identidad esperada y AbortSignal; la señal no se congela                                                    |
| `HlsObjectObservation`         | Key lógica resuelta, tamaño e identidad real observada                                                                    |
| `HlsSnapshotVerificationError` | Código estable y mensaje saneado, sin causa, URL, token o cuerpo de error del proveedor                                   |

El adaptador deberá resolver **la key dentro del binding autorizado** y verificar
su asociación al objeto físico. No debe usar un fileId Drive aportado en el
manifiesto como autoridad para leer cualquier archivo de la integración, ni
devolver la identidad solicitada como si se hubiera observado realmente.
El llamador debe autenticar/autorizar el trabajo: el motor no evalúa usuarios.

No se conectan todavía adaptadores SDK/HTTP concretos. La inspección encontró
que `S3BucketAccess.getPlaybackObjectResponse` utiliza IfMatch, pero no es una
lectura fijada a versionId/checksum del nuevo contrato. Drive tiene interfaces
de identidad interna existentes, pero no se presupone que implementen la nueva
lectura exacta de revisión. Reutilizarlas sin adaptar y probar sus garantías
sería una degradación silenciosa. No se modifican en esta entrega.

## Límites y cancelación

Defaults y techos de esta fase: 256 MiB por objeto, 2 GiB totales, 1000 objetos y
30 segundos de IO por operación completa. Las opciones solo pueden reducir esos
techos y deben ser enteros positivos seguros. Son más restrictivos que el máximo
estructural del contrato; no se promete admitir aquí todo inventario v1 válido.
La validación/preflight ocurre antes de iniciar el reloj de IO y conserva sus
propios límites estructurales.

Se procesa un objeto a la vez. Se propaga AbortSignal a cada llamada; abortar o
agotar el plazo rechaza la operación, también si una promesa de HEAD no termina.
Se cancela el lector ante fallo y se libera su lock; una respuesta `open` que
llegue después de abortar se cancela al llegar. La limpieza se solicita sin
esperar indefinidamente a un adaptador que ignore cancelación. El adaptador real
deberá respetar la señal, retornar un body desbloqueado y acotar chunks/buffers.
Se rechazan chunks vacíos sin progreso; además del timer, se comprueba un
plazo monotónico entre lecturas para que una cadena de promesas inmediatas no
pueda impedir indefinidamente su aplicación.

Un fallo no devuelve un snapshot parcial. Los reintentos empiezan desde cero:
no se reutilizan bytes ni receipts fallidos, y no hay estado persistente que
permita confundir dos intentos. No se implementa reanudación/checkpoint de la
verificación ni un job duradero; quedan para una entrega posterior si se necesitan.

## Pruebas y evidencia

**327 pruebas aprobadas en ocho archivos**, incluidas **42 nuevas**:

```bash
bun run --cwd apps/web test \
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

Cobertura nueva: S3/Drive simulados, ámbito y digest inválidos sin IO, cambio de
key/tamaño/versión/revisión/ETag/checksum, mutación entre HEAD y GET o después de
leer, bytes corruptos/truncados/excedentes, objeto ausente, error de proveedor,
límites preflight, cancelación con reader.read pendiente, HEAD que no termina,
body tardío, cambio de binding y reintentos sin resultados parciales. También
comprueba congelación del resultado y que el input original permanece separado.

El test de lectura pendiente evita prefetch (`highWaterMark: 0`). Se añaden
regresiones para chunks vacíos y plazo monotónico vencido aun cuando las
promesas inmediatas retrasen los timers. La batería final de 42 casos nuevos
y las regresiones anteriores pasan.
Typecheck web sin errores. Biome de ambos archivos TS, Prettier del documento y
diff comprobados. El media server mantiene los mismos siete errores previos,
comparados sin diferencias: tres TS2352 en drive-resumable-upload.test.ts
(107/124/141), TS2769 en media-routes-real-world.integration.test.ts (1061),
TS2322 en media-size.test.ts (34) y dos TS2345 en capcodec-encoder.ts (337/344).

La búsqueda de imports de `hls-snapshot-verification` solo encuentra el test.
No hay nuevas dependencias, lockfiles, endpoints, servicios iniciados ni cambios
de permisos, esquema, migraciones, workers, captura o infraestructura. No se
invocan almacenamiento real, IA de pago, VPS o E2E.

## Corrección de limpieza tras auditoría

Se detectó que releaseLock estaba encadenado a la resolución de reader.cancel.
Si el adaptador dejaba pendiente su cancelación, la operación devolvía aborted
pero el body conservaba el lock. Se separan ambas acciones: se solicita cancelar
con rechazo manejado y se libera inmediatamente el lock, sin esperar al proveedor.
La cancelación no garantiza por sí sola que un socket de un adaptador defectuoso
termine; sí evita retener el bloqueo local por esperar su confirmación.

Dos regresiones comprueban cancelación que nunca resuelve tras contenido inválido
y abort durante reader.read pendiente. Antes: 42 casos pasan y esos dos fallan;
después: los 44 casos del motor pasan. No se conecta el motor a producción.

## Riesgos pendientes y siguiente paso recomendado

Un SHA256 correcto demuestra igualdad con la declaración validada, no que el
productor tuviera derecho a publicar esos bytes. La verificación no analiza el
contenedor fMP4, duración real, decodificabilidad, códecs ni sincronía de pistas.
Tampoco garantiza existencia futura, retención de versiones, ACL, WORM o
inmutabilidad física. Un snapshot puede dejar de ser legible después: el lector
futuro deberá fijar/revalidar identidad y fallar cerrado, nunca leer latest como
fallback. Hay carreras entre objetos; no existe una transacción multiobjeto.

Los adaptadores reales son una frontera de confianza pendiente. Los tests no
demuestran pinning S3/Drive real, cancelación de sockets, coste, rendimiento ni
políticas de buckets. No se declara seguridad certificada o readiness productiva.

Recomiendo revisar este motor y después implementar **adaptadores de lectura
fijada aislados**, con clientes inyectados y pruebas de comandos/observaciones,
sin conectarlos a reproducción. Para pruebas contra proveedores reales hará
falta un entorno explícitamente autorizado. La copia física de snapshots,
registro CAS, schema, publicación y proxy requieren alcance y aprobación propios.

**Punto de parada:** 1.5B.6B.2 entrega un motor inactivo y snapshots en memoria.
No activa el proxy HLS ni la publicación. PR #1 sin merge ni cambio Draft/Ready,
`main` intacta. Código/pruebas y documentación en commits separados.
