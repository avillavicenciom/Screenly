# Validación incremental: revocación de nuevas lecturas viewer

Fecha: 2026-10-27. Rama `feature/screenly-phase-0`, base `99972bda7`.
Árbol inicialmente limpio. Primer incremento del seguimiento de E2E, revocación,
retención/concurrencia, MySQL y S3/MinIO. Se detiene aquí para revisión.

## Alcance y criterios de aceptación

Se seleccionó la revocación en **`/api/playback/mp4`**, ya implementado con la
frontera compartida `apps/web/lib/viewer-media.ts`. Permite comprobar un contrato
relevante sin iniciar servicios o cambiar código productivo. No se implementa
ni activa el proxy HLS.

Criterios: admitir con permisos vigentes, retirar una vía de autorización y
repetir la solicitud; denegarla con 404 vacío antes de adquirir acceso a storage
o invocar HEAD, lectura, firma o listado; conservar las políticas privadas de
caché; distinguir nuevas lecturas de los bytes ya recibidos y streams admitidos.

## Código ejercitado y cobertura

Solo se modifica `apps/web/__tests__/unit/mp4-playback-route.test.ts`. El handler
GET/HEAD real de `apps/web/app/api/playback/mp4/route.ts` usa
`authorizeViewerVideo` antes de `Storage.getAccessForVideo` y
`streamViewerObject`. La política real `buildCanViewLoaded`, en
`packages/web-backend/src/Videos/VideosPolicy.ts`, se aplica mediante
`Policy.withPublicPolicy`. Se conserva el adaptador HTTP Effect real dentro
del proceso; repositorios de permisos, sesión, DB y almacenamiento se simulan.

El mock incorpora un grant explícito mutable para un espectador sin membresía
alternativa. No se sustituye la política por un booleano de éxito del handler.

| Cambio entre solicitudes                            | GET     | HEAD    | Range   | If-Range coincidente | If-Range obsoleto |
| --------------------------------------------------- | ------- | ------- | ------- | -------------------- | ----------------- |
| Retirada de membresía                               | 200→404 | 200→404 | 206→404 | 206→404              | 200→404           |
| Retirada de grant explícito                         | 200→404 | 200→404 | 206→404 | 206→404              | 200→404           |
| Público pasa a privado, visitante anónimo           | 200→404 | 200→404 | 206→404 | 206→404              | 200→404           |
| Contraseña cambia; verificación anterior conservada | 200→404 | 200→404 | 206→404 | 206→404              | 200→404           |

Cada uno de esos veinte casos comprueba el cuerpo previo, las cabeceras y la
denegación posterior vacía. Tras limpiar contadores del primer acceso, exige
cero llamadas a `access`, `head`, `read`, `sign` y `list`.
Incluso If-Range obsoleto se deniega antes de comprobar el objeto completo.
La contraseña se prueba con un miembro que conserva su membresía pero no una
verificación vigente. Cada vía está aislada: retirar un grant no implica
denegación si existiera otra vía válida de autorización.

El helper comprueba Cache-Control privado sin almacenamiento, ambas directivas
CDN no-store, Pragma, Expires y ausencia de Location en admitidos y denegados.

Un caso adicional recibe `01234` de un stream controlado, retira la membresía,
obtiene 404 en una nueva Range y recibe `56789` por el stream admitido previamente.
No se observa cancelación del stream original. Es una caracterización del límite
actual, no una prueba de sockets ni una garantía de detener lecturas en curso.

Tres casos anteriores se sustituyen por la matriz ampliada. El archivo pasa de
33 a **51 pruebas**, un incremento neto de 18, conservando la cobertura previa.

## Resultados

| Comprobación                                                                                                        | Resultado de esta entrega                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| MP4: admisión, revocación y streaming                                                                               | 51/51 aprobadas                                           |
| Regresión conjunta: MP4, derivados, playlist, contratos, motor, S3/Drive, capacidades internas y manifiesto desktop | 451/451 aprobadas en diez archivos                        |
| Runner Drive live sin opt-in                                                                                        | 9 omitidas deliberadamente; ninguna conexión real         |
| Auditor independiente: MP4, derivados y playlist                                                                    | 218/218 aprobadas                                         |
| Typecheck web                                                                                                       | Salida 0, sin errores; 56 avisos y 118 sugerencias Effect |
| Biome del test, Prettier del documento y diff                                                                       | Comprobados antes de publicar                             |

Los mensajes ERROR de escenarios negativos de playlist son esperados; no son
casos fallidos. Los diagnósticos Effect no se ocultan ni equivalen a errores
TypeScript. No se ejecutó typecheck del media server: no se modifica ese módulo.
No se añadieron dependencias, lockfiles, schemas ni migraciones.

Comprobación principal reproducible:

```bash
export PATH=/workspace/.tools/node_modules/.bin:$PATH
bun run --cwd apps/web test \
  __tests__/unit/mp4-playback-route.test.ts \
  __tests__/unit/viewer-derivatives.test.ts \
  __tests__/unit/segment-playlist-route.test.ts
bun run tsc-rs -p apps/web/tsconfig.json --noEmit
```

La regresión de 451 añade hls-drive-verification-storage,
hls-s3-verification-storage, hls-snapshot-verification, hls-publication-contract,
hls-publication-characterization, media-extraction-capability y
desktop-segments-manifest-contract, todos bajo `__tests__/unit/*.test.ts`.
Se incluye también `__tests__/integration/hls-drive-real-storage.test.ts`,
que omite sus nueve casos cuando no se activa explícitamente.

## Qué sigue bloqueado o sin ejecutar

| Área                        | Evidencia disponible                                                                   | Requisito pendiente                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Revocación viewer MP4       | Handler y política reales; DB/storage simulados                                        | Sesiones, permisos persistidos, instancia y almacenamiento reales                                                                |
| Drive                       | Nueve casos reales previos en SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md; no repetidos aquí | Retención histórica, ACL/mutación concurrentes y transferencias grandes                                                          |
| HLS                         | Auditoría, contratos y adaptadores aislados                                            | Publicación persistida segura y autorización por recurso antes de E2E HLS completo                                               |
| E2E reproducción            | No ejecutado                                                                           | Instancia de prueba autorizada, navegador, usuarios propietario/miembro/grant/anónimo, vídeos sintéticos y rutas activas         |
| MySQL                       | No ejecutado; sin conexión exclusiva declarada                                         | Servicio/esquema de laboratorio ya preparados, credencial acotada, fixtures aisladas y limpieza aprobada                         |
| S3/MinIO                    | Adaptador simulado; sin destino de laboratorio declarado                               | Bucket versionado, endpoint/región, claves/versiones exactas y SHA256 FULL_OBJECT; identidad lectora nativa compatible con SigV4 |
| Retención/concurrencia real | Simulaciones previas y stream local aquí                                               | Política de retención comprobable, identidades separadas y autorización de escritura/ACL sobre muestras desechables              |

Solo se comprobó presencia de nombres de configuración, sin leer credenciales:
DATABASE_URL, MYSQL_URL y los requisitos de bucket/perfil/scope/manifiesto S3
no están disponibles en la sesión. No demuestra que no exista un servicio
externo; no se descubrieron cuentas ni recursos para buscarlo.

**No activar automáticamente CAP_AGENT_E2E=1.** El runner existente
`apps/web/__tests__/e2e/agent-local-e2e.test.ts` usa createServer y spawn;
`seedDatabase` ejecuta TRUNCATE TABLE y DELETE y desactiva temporalmente foreign
keys. También utiliza PutObjectCommand. Su existencia no autoriza estas
operaciones. Su reutilización exige aislamiento efectivo y aprobación específica.
No se inició ningún servicio ni se modificaron recursos para estas pruebas.

## Riesgo HLS y siguiente incremento

Esta entrega **no prueba revocación HLS ni acredita E2E**. En
`apps/web/app/api/playlist/route.ts`, desktopSegments sigue firmando init y
segmentos con getSignedObjectUrl; ramas legacy siguen listando y firmando objetos.
Una URL de origen emitida puede conservar capacidad de lectura hasta expirar,
aunque una nueva solicitud a Screenly sea denegada. La matriz MP4 no se extrapola
a esa vía. No se permite fallback a enlaces directos para un futuro proxy.

Se recomienda extender después la matriz de grant explícito y revocación entre
solicitudes a los endpoints de derivados existentes. Con un entorno dedicado
aprobado, contrastar sesiones y permisos persistidos en MySQL y preparar E2E
MP4/derivados sin limpiezas destructivas globales. La protección HLS sigue
condicionada al diseño de publicación y al proxy aún sin activar.

No hay cambios productivos, servicios, permisos de recursos, infraestructura o
VPS. Pruebas y documentación se publican en commits separados; main permanece
intacta y PR #1 en borrador. Se detiene al finalizar este incremento para revisión.
