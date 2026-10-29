# Fase 1.5B.6A — diseño de publicación HLS y recuperación legacy

**Propuesta para aprobación; no implementada.** Base:
`16d8391c25a4bbb86033e5d1df5cda00d044c96d`, rama `feature/screenly-phase-0`,
árbol inicialmente limpio. Solo se añaden caracterizaciones y este documento.
No se cambian escritores, esquemas, migraciones, dependencias o infraestructura.
No se implementa el proxy HLS ni se inicia 1.5B.7.

Se revisaron las instrucciones raíz/web y los documentos de revocación,
capacidades internas, MP4, derivados y auditoría HLS. La auditoría anterior
identificó la falta de una autoridad de publicación en el lector legacy custom;
este diseño distingue ese problema de la validez técnica de un archivo.

## 1. Productores y eventos reales

| Familia                      | Productor y evidencia concreta                                                                                                                                                       | Evento observable hoy                                                                                                                                                                     | Compatibilidad propuesta                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Windows Instant / GPUI       | `crates/recording/src/output_pipeline/win_segmented.rs::write_in_progress_manifest`, `finalize_manifest`; `apps/desktop-gpui/src/upload.rs::SegmentUploadManifest`, bucle de uploads | Cierre local y escritura atómica del manifiesto local; tras `transport.segment` correcto se llama `manifest.record`; después se sube el manifiesto remoto y finalmente `is_complete=true` | Adaptar anuncio existente a generación publicada verificada; mantener EVENT y prefijos contiguos                   |
| Otros muxers segmentados     | `crates/enc-ffmpeg/src/mux/segmented_stream.rs::write_in_progress_manifest`, `finalize_manifest`                                                                                     | Publicación local de fragmentos/manifiestos, validación final DASH y cierre; no equivale por sí sola a publicación remota                                                                 | Usar eventos cerrados del pipeline, no el simple fichero aparecido en disco                                        |
| Reintentos Windows           | `apps/desktop-gpui/src/upload/queue.rs::LiveBackend.transfer`, `crates/recording/src/upload_resume.rs`                                                                               | Reconstruye eventos locales verificables, autoriza manifiesto esperado, comprueba fragmentos completos antes de reintentar                                                                | Reutilizar identidad de intento; nunca mezclar segmentos de intentos distintos                                     |
| Commit de fuente desktop     | `lib/desktop-recording-source.ts::createSourcePlan`, `workflows/finalize-desktop-recording.ts::commitDesktopRecordingAttempt`                                                        | Snapshot/inventario con digest e identidades y persistencia de fuente por intento                                                                                                         | Fuente fiable para validar, no asumir que su commit ya publica cada URI HLS para espectadores                      |
| Grabación web actual         | `packages/recorder-core/src/instant-mp4-uploader.ts::finalize`, `workflows/process-video.ts`                                                                                         | Finaliza MP4/multipart, valida cuenta de bytes y dispara procesamiento; no produce necesariamente HLS                                                                                     | Mantener MP4; no convertir toda grabación web a HLS ni inferir HLS desde su phase                                  |
| Subida genérica / antigua    | `actions/video/upload.ts`, `api/upload/[...route]/signed.ts`                                                                                                                         | Targets de subida autorizados al propietario con metadata de duración/códec y restricciones de rutas                                                                                      | Subida correcta significa almacenado; necesitaría finalización explícita para anunciar HLS                         |
| `local` histórico            | `Video.getSource`: `combined-source/stream.m3u8`; lector `/api/playlist`                                                                                                             | Se consume manifiesto guardado y referencias TS; no se encontró su escritor histórico activo en los archivos TS/Rust buscados                                                             | Importar grafo solo tras verificarlo; no inventar el evento de cierre que falta                                    |
| `MediaConvert` histórico     | `Video.getSource`: `output/video_recording_000.m3u8`; `videos.jobStatus`, `skipProcessing`                                                                                           | Evidencia global de trabajo o bypass, no identidad de cada segmento                                                                                                                       | Usar evidencia del job como indicio y verificar artefactos; no aceptar `skipProcessing` como prueba                |
| Legacy custom                | `/api/playlist::getPlaylistResponse`, ramas master/video/audio                                                                                                                       | Lista `video/` y `audio/`, obtiene metadata y firma objetos; el listado actúa como selección implícita                                                                                    | No reconocer listado como publicación autorizada; inventario y reconstrucción controlada                           |
| Render farm                  | `apps/render-farm/src/hls.ts::checkSegmentReport`, `segmentKey`; `coordinator.ts::publishPlaylist`                                                                                   | Reporte validado contra chunk/dispatch; publica playlist del prefijo contiguo; keys por despacho evitan sobrescritura de un retry tardío                                                  | Adaptar reportes aceptados al registro de publicación; no exponer las firmas de 6 h que hoy escribe el coordinador |
| Importaciones / conversiones | `workflows/import-loom-video.ts`, `apps/media-server/src/loom-importer/`, `workflows/edit-video.ts`                                                                                  | Reciben o consumen HLS remoto y remuxean/renderizan salidas; aceptar una URL de entrada no publica sus URI en la biblioteca                                                               | Separar artefactos internos de salidas verificadas de Screenly; nunca proxy abierto de la URL importada            |

S3 y Drive son adaptadores de almacenamiento, no autoridades de publicación.
Drive puede ofrecer identidad mediante revisión/checksum/tamaño; ver
`Storage/recording-object-identity.ts::getGoogleDriveRecordingIdentity` y
`getRecordingObjectIdentity`. S3 ETag no es siempre hash de contenido, en especial
multipart. Reutilizar esas abstracciones con sus límites; no equiparar ETag a SHA256.

El render farm es una superficie adicional de HLS interno encontrada en esta
revisión; no se presupone que toda salida suya sea actualmente un vídeo de la
biblioteca ni se reemplazan sus URLs en 6A.

## 2. Qué significa publicado

Hoy no hay un único evento universal. Para Instant, la inclusión en un manifiesto
remoto tras upload correcto anuncia disponibilidad; el cierre final y el commit
de fuente dan garantías adicionales distintas. Para legacy custom, listar un
objeto lo selecciona sin acreditar intención de publicación por objeto.

**Definición propuesta:** un recurso está publicado cuando un coordinador de
confianza ha validado su pertenencia, completitud e identidad y ha confirmado
atómicamente una generación activa que lo referencia. No basta con un PUT, el
cierre local, la firma de upload, un HEAD satisfactorio o `is_complete=true`.
Este nuevo punto de commit sería una modificación futura, no una garantía actual.

| Dato actual                                | Lo que permite concluir                                              | Lo que no acredita                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Listado / tamaño / LastModified            | Existencia observada, candidatos para inventario                     | Intención, cierre, orden, pertenencia a un intento o ausencia de escrituras futuras      |
| duration / resolution / bandwidth / códecs | Pistas para validar o reconstruir                                    | Bytes decodificables o publicación; parte de la metadata viene del cliente               |
| `videoUploads.phase`, `videos.jobStatus`   | Estado global de UI/trabajo                                          | Inventario de segmentos, init correcto, identidad de objeto o garantía transaccional HLS |
| `isPublicShareVideoCandidateEligible`      | Filtra galería pública por phase/jobStatus/skipProcessing y permisos | No sustituye autorización de cada archivo ni hace al listado legacy un manifiesto        |
| Manifiesto Instant completo                | Estructura, índices contiguos y consistencia declarada de audio      | Existencia/identidad de bytes remotos por sí solo                                        |
| `manifestSha256`                           | Digest de los bytes exactos del manifiesto                           | Hash de segmentos o canonización semántica; espacios JSON cambian el digest              |
| Inventario committed e identidad de objeto | Vinculación verificable a una fuente/intento                         | Permiso vigente del espectador o anuncio de una salida nueva                             |

No existe un criterio global probado para distinguir abandonado de temporal
solo por antigüedad. No se borran ni publican objetos automáticamente por TTL.

## 3. Alternativas

| Alternativa             | Ventajas                                                                                                                   | Costes y límites                                                                                                                         | Decisión                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A. Manifiesto explícito | Inventario cerrado de claves, pistas, orden y duraciones; portable entre proveedores y apto para EVENT                     | PUT de objetos y publicación no son una transacción; manifiesto mutable/cliente no basta; requiere autoridad para activarlo              | Base para el plano de contenido, con generaciones inmutables                               |
| B. Registro DB          | Commit/CAS, estado, intento ganador, auditoría y coordinación de borrado; fácil impedir finalización de un worker obsoleto | DB y storage no comparten transacción; coste por segmento si se normaliza todo; requeriría aprobación de esquema                         | Usar un pequeño registro activo por vídeo y generaciones, no una fila por lectura/segmento |
| C. Manifiesto derivado  | Recupera grabaciones antiguas sin confiar solo en nombres; reutiliza playlists, fuente committed y pruebas multimedia      | Probar bytes íntegros no demuestra intención histórica; metadatos ambiguos o múltiples intentos impiden reconstrucción automática segura | Solo herramienta de validación/migración; no inferencia dinámica en cada GET               |

**Recomendación: A + B para nuevas publicaciones, C para admisión legacy.**
No se reutiliza silenciosamente `videoProcessingJobs.source` como estado viewer:
su finalidad y ciclo de vida son de procesamiento. Se deberá revisar si un
puntero reservado existente ofrece las garantías de exclusión y CAS antes de
optar por nueva entidad; si no, B requerirá diseño de esquema y aprobación
independiente. No se genera SQL en esta fase.

## 4. Arquitectura propuesta y orden del commit

Los siguientes son campos conceptuales de un contrato futuro, no nombres de
tablas, rutas ni JSON que ya existan:

- Generación: versión de contrato, vídeo/propietario, storage lógico, intento de
  producción, revisión monotónica, tipo EVENT/VOD, intención de audio, estado,
  digest del inventario y referencia a la generación precedente.
- Entradas: ID opaco, rol (master/variante/init/segmento), pista, secuencia,
  duración, tamaño, identidad/version/checksum del objeto y referencias a otras
  entradas. No contener firmas, credenciales o URLs externas.
- Registro activo: vídeo, generación/digest, revisión CAS, estado de admisión y
  diagnóstico. La autorización viewer se consulta aparte y nunca se congela
  dentro del manifiesto ni se copia como `public=true` a una generación.

Secuencia futura:

1. Reservar intento y namespace protegido; recibir bytes temporales. Todas las
   APIs de upload deberán impedir al cliente modificar los manifiestos/punteros
   reservados. No asumir que basta con que un nombre empiece por punto.
2. Cerrar y verificar cada segmento e init: tamaño no cero, contenedor completo,
   compatibilidad de pista/códec, secuencia/duración, audio requerido e identidad
   estable. Reutilizar validadores multimedia existentes donde sirvan.
3. Escribir entradas/objetos bajo claves inmutables de intento; verificar
   identidad tras copiar cuando sea necesario. Rechazar proveedor incapaz de
   dar identidad fiable o cambiar sus bytes; no degradar a una lectura insegura.
4. Escribir un manifiesto inmutable y verificar su digest. Solo después realizar
   CAS del registro activo, comprobando vídeo/organización no borrados e intento
   vigente. Fallar cerrado ante DB caída; nunca activar un snapshot huérfano.
5. EVENT puede activar sucesivas revisiones con prefijo contiguo. No reemplazar
   bytes ya referenciados, renumerar segmentos ni quitar audio para aparentar
   completitud. No requiere cerrar toda la grabación para publicar un prefijo
   validado. VOD final exige cierre y coherencia de todas las pistas.
6. Worker tardío, lease perdido, digest cambiado o finalización tras borrado:
   rechazar CAS; conservar objetos como huérfanos para recuperación/GC posterior.

El lector HLS futuro autorizará cada GET/HEAD/Range con política actual,
comprobará vídeo/organización y registro activo, resolverá IDs permitidos y leerá
bytes fijando identidad. Reescribirá todas las URI a mismo origen mediante un
parser acotado: líneas, variantes, audio y EXT-X-MAP; tags desconocidos con
referencias, cifrado/KEY, rutas absolutas, traversal o esquemas externos se
rechazarán hasta tener soporte explícito. No bastará un reemplazo de `.ts`.
No se aceptarán claves/buckets/URLs del cliente ni tokens de objeto como permiso.

Los manifiestos reescritos tendrán su propia longitud/digest, no el ETag del
original. El streaming de segmentos reutilizará `viewer-media.ts`, sus rangos,
If-Range, cancelación y no-store. La admisión requiere DB actualizada; las cachés
de inventarios pueden ser por digest inmutable, las de decisiones de permisos
no pueden ocultar revocaciones. Bytes ya admitidos/descargados no son revocables.

## 5. Estrategia legacy: inventario a recuperación

**No ejecutar estos pasos en esta fase.** Antes, autorizar entorno y credenciales
de solo lectura para inventario; cualquier escritura/activación es otra etapa.

1. Inventario paginado por vídeo, proveedor y tipo de fuente: roots conocidos,
   objetos, versiones, tamaños, job/phase, manifiestos e intentos existentes.
   Listado descubre candidatos; no concede lectura al público. Acotar bytes,
   profundidad, cantidad de objetos y coste de sondeo. No registrar firmas.
2. Validación: cerrar el grafo desde roots verificables sin egress arbitrario;
   comprobar cada referencia y bytes/metadata con identidad estable. Muestrear
   no basta para declarar completo. Detectar intentos mezclados, huecos, init
   incompatible, timestamps discontinuos, audio requerido ausente y mutaciones.
3. Clasificación persistida y auditada:
   - **Verificable:** manifiesto/source/job compatible y todos los objetos
     verificables; candidato a snapshot después de aprobación del procedimiento.
   - **Reconstruible:** artefactos íntegros y orden inequívoco, pero falta
     manifiesto fiable; reconstruir candidato offline y exigir validación de
     intención por propietario/operador, no autopublicar por bytes íntegros.
   - **En curso:** escritor activo conocido; esperar su cierre o adoptar un
     contrato EVENT explícito. No capturar un listado en movimiento como VOD.
   - **Ambiguo/incompleto:** múltiples intentos, huecos, identidad ausente o falta
     de pruebas; cuarentena lógica, sin servir en el proxy futuro.
   - **Huérfano/posiblemente abandonado:** sin vínculo suficiente; retener y
     escalar, sin equiparar antigüedad a autorización de borrado.
4. Reconstrucción: producir snapshot candidato separado, conservar evidencia,
   validar nuevamente identidades antes del CAS; nunca editar el original ni
   completar huecos inventando segmentos o duraciones.
5. Recuperación: preferir fuente local/committed y reupload por propietario,
   o remux/reconversión autorizada a nueva generación. Conservar original,
   diagnóstico y vínculo a la recuperación. Si no puede recuperarse audio
   esperado, informar pérdida; no presentar una versión silenciosa como íntegra.
6. Rollback: activar por CAS una generación anterior **aún validada y permitida**
   o pausar admisión. No reactivar firmas directas/listado legacy como fallback.
   Mantener lectores capaces de entender versiones activas; no purgar snapshots
   que un rollback soportado todavía necesite. Borrado/permisos actuales siguen
   prevaleciendo sobre cualquier generación histórica.

Cuarentena es estado lógico de admisión, no mover/eliminar objetos ahora.
Una transición a cuarentena puede interrumpir vídeos antiguos: comunicarla,
inventariar afectados y aprobar el rollout; no desplegar esa ruptura sin revisión.

## 6. Cambios futuros por componente

| Componente               | Cambio necesario tras aprobación                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escritores Windows/otros | Confirmar cierre/upload antes de anunciar; intento estable, claves inmutables y reintentos idempotentes; mantener copia local hasta receipt verificable                 |
| Web/multipart            | Mantener MP4 actual; si un proceso genera HLS, entrar por finalización verificadora, no anunciar por phase o filename                                                   |
| Workers/render farm      | Reportes ligados a job/attempt y autorización de servicio; publicar solo intento ganador tras verificación; no depender de una sesión viewer                            |
| Storage S3/Drive         | Identidades y lecturas condicionadas, límites y paginación; validar copias/revisiones; no firmar objetos para espectadores; no asumir atomicidad multiobjeto            |
| API                      | Coordinación de publicación separada de lectura; futuro proxy de IDs, no-store uniforme, 202/204/409 y errores saneados; límites de abuso                               |
| DB                       | Revisar registro/puntero CAS y tombstone; esquema solo si se aprueba explícitamente; no convertir jobs internos en grants de lectura                                    |
| Web player               | Seguir playlists del mismo origen; distinguir pending/incomplete/denied y no hacer fallback bearer; conservar EVENT/VOD y búsqueda                                      |
| Windows player/editor    | Separar reproducción local de recursos cloud; no aplicar proxy a archivos locales; comprobar consumidores reales antes de cambiar URL/auth; grabación permanece intacta |
| Móvil                    | Propagar identidad a master, variantes, init y segmentos; hoy `replaceAsync` no adjunta Bearer aunque thumbnails sí; necesita test nativo, no solo fetch API            |

## 7. Caracterización ejecutada y alcance de evidencia

Se añaden 10 casos en `hls-publication-characterization.test.ts` y dos casos
en `segment-playlist-route.test.ts`. Usan los helpers/handler existentes:

- Un manifiesto estructural válido produce readiness sin probar bytes remotos;
  el digest cambia con espacios JSON. Índices discontinuos/repetidos se rechazan.
- Early playback usa prefijo contiguo y espera audio observable.
- El generador legacy formatea una URL y añade VOD/ENDLIST sin validar publicación;
  conserva la sustitución histórica del host CDN.
- El handler real custom MediaConvert devuelve y firma un objeto listado incluso
  con nombre `abandoned.tmp`, sin leer el manifiesto Instant. El nombre es una
  fixture, no prueba de abandono real; demuestra ausencia de ese filtro.

**208 pruebas web aprobadas en 7 archivos**, con DB/storage simulados:

```bash
bun run --cwd apps/web test \
  __tests__/unit/hls-publication-characterization.test.ts \
  __tests__/unit/segment-playlist-route.test.ts \
  __tests__/unit/desktop-segments-manifest-contract.test.ts \
  __tests__/unit/early-segment-playback.test.ts \
  __tests__/unit/desktop-recording-source.test.ts \
  __tests__/unit/recording-output.test.ts \
  __tests__/unit/signed-upload-metadata.test.ts
bun test apps/render-farm/src/hls.test.ts
bun run tsc-rs -p apps/web/tsconfig.json --noEmit
```

Render farm: **14 pruebas existentes aprobadas**, incluidas validación de reportes
y claves por despacho. Typecheck web sin errores; Biome sobre ambos archivos
de test, Prettier sobre este documento y diff comprobados. Los siete errores
independientes del media server siguen documentados en 1.5B.6; no se modifican
sus archivos ni se afirma haberlos corregido. No se ejecutan compilaciones Rust
ni pruebas nativas, MySQL/S3/Drive real, E2E o sondas multimedia reales en 6A.

Estas caracterizaciones describen límites actuales: **no certifican el diseño
propuesto ni endurecen la reproducción existente**. No se llama a APIs de pago,
no se arrancan servicios y no se modifica el VPS.

## 8. Plan posterior por commits y condiciones de aprobación

1. Aprobar contrato de generación, intención de audio, familias soportadas,
   política de desconocidos y coste/latencia; agregar pruebas negativas del
   contrato sin activarlo.
2. Diseñar e implementar identidad de objetos y snapshots inmutables con pruebas
   de mutación/copia/retry. Separar validación de bytes de la autorización viewer.
3. Solo con aprobación de esquema si procede: registro activo y CAS; migración
   generada, revisión y pruebas transaccionales aisladas, nunca aplicada al VPS
   como parte del commit. Probar borrado concurrente e intento superseded.
4. Adaptar un escritor/coordinador por commit, con regresiones y receipts. No
   mezclar Windows, render farm y productores históricos en una única entrega.
5. Herramienta de inventario/reconstrucción dry-run y pruebas de clasificación,
   cuarentena y rollback. La activación/backfill requiere aprobación separada.
6. Implementar el proxy HLS y migrar lectores por familia con matriz de perfiles,
   revocación por petición, tags/URI manipuladas, Range/If-Range/HEAD, MIME,
   cancelación, estados progresivos y cero storage ante denegación.
7. Validación real autorizada: MySQL concurrente, S3/MinIO/Drive y CDN, navegador,
   Windows y móvil. Ensayar caída de DB/storage, rollback sin bearer fallback y
   abuso de recursos. No cerrar legacy ni purgar firmas hasta probar consumidores
   internos y aprobar explícitamente el corte operativo.

Antes de modificar producción se deben aprobar arquitectura, necesidad de DB,
impacto legacy y procedimiento de recuperación. Antes de rollout se requieren
las pruebas reales anteriores y criterios medibles de integridad, latencia y
revocación; las firmas viejas y copias descargadas son un riesgo independiente.

**Punto de parada:** 6A entrega diseño y caracterización para revisión. No autoriza
escritores nuevos, proxy, migraciones, despliegues ni implementación de 1.5B.7.
PR #1 sin merge ni cambio Draft/Ready; `main` intacta.
