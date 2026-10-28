# Laboratorio HLS: publicación, retención y concurrencia

Fecha: 2026-10-28. Rama `feature/screenly-phase-0`, base `47fa26d2c`.
Estado: diseño y casos preparados para aprobación; no ejecución real ni cambios
productivos. Este documento no habilita el proxy, registros, escritores o GC.

## Fronteras actuales y prerrequisitos

| Componente            | Implementado y verificable en código                                                                                                                                 | Pendiente antes de probar publicación real                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Contrato fMP4 v1      | `hls-publication-contract.ts::validateHlsManifest`, `sealHlsInventory` y `validateHlsProgression`: grafo, digest, scope, identidades, EVENT append-only y cierre VOD | No autentica productor ni publica por sí mismo; no es parser/rewrite M3U8                    |
| Verificación de bytes | `hls-snapshot-verification.ts::prepareVerifiedHlsSnapshot`: HEAD, apertura fijada, SHA256 incremental y nueva observación; devuelve descriptor congelado en memoria  | Sin copia WORM, persistencia de receipts, registro activo ni CAS                             |
| S3                    | `hls-s3-verification-storage.ts::createHlsS3VerificationStorage`: bucket fijo, VersionId, IfMatch y SHA256 FULL_OBJECT                                               | Compatibilidad real del servicio, permisos y retención de versiones                          |
| Drive                 | `hls-drive-verification-storage.ts::createHlsDriveVerificationStorage`: mapping confiable, revisión exacta y comprobaciones de head/checksum/tamaño                  | Solo admite revisión asociable al head actual; no promete revisiones históricas ni retención |
| Autorización viewer   | `viewer-media.ts::authorizeViewerVideo` y `streamViewerObject` protegen MP4/derivados existentes                                                                     | No son un proxy HLS activo ni una transacción DB-storage                                     |
| Lectura HLS legacy    | `app/api/playlist/route.ts` aún firma init/segmentos y lista objetos en ramas legacy                                                                                 | No hay autoridad universal de publicación ni revocación por cada lectura al origen           |

Las rutas de código de la tabla están bajo `apps/web/lib/`, salvo la ruta API.
Los diseños previos recomiendan manifiesto explícito más registro activo y CAS,
con validación legacy separada. **Registro activo/CAS HLS no están implementados.**
No se presupone una tabla, endpoint o lease que no exista. Cualquier esquema
nuevo necesitará diseño y aprobación independiente; no se genera SQL aquí.

Secuencia de habilitación futura:

1. Aprobar identidad, alcance y recursos de laboratorio de los planes MySQL y
   almacenamiento. Preparar fixtures sintéticas y un inventario fuera de Git.
2. Verificar versiones/revisiones y bytes con los adaptadores aislados, sin
   exposición viewer ni anuncio de generación.
3. Diseñar y aprobar persistencia y CAS: intento vigente, digest esperado,
   tombstone, reintentos idempotentes y rechazo de worker obsoleto. Comprobar
   namespace reservado frente a targets de upload antes de modificar writers.
4. Solo tras aprobación de implementación, conectar publicación a la autoridad
   elegida y probar CAS con MySQL real de laboratorio.
5. Solo después implementar/autorizar proxy HLS por recurso y pruebas E2E. Debe
   reautorizar cada GET/HEAD/Range y reescribir las URI al mismo origen, sin
   fallback a firmas, latest o claves arbitrarias.
6. Ensayar retención, mutación y purga únicamente con alcance operativo separado.

## Fixtures y roles propuestos

Preparar, por ejecución, un conjunto nuevo de owner/video/attempt/generation
ficticios y manifest v1 sellado: VOD con vídeo/init/dos segmentos; VOD con audio
requerido; EVENT de prefijo contiguo con revisión siguiente y cierre VOD; objeto
huérfano no referenciado; y generación previa candidata a rollback. Los nombres
son etiquetas de casos, no recursos ya creados. Hashes, tamaños e identidades
se registran antes de los ensayos; las muestras no contendrán grabaciones reales.

El responsable del laboratorio mantiene tres capacidades distintas: administrador
de retención/ACL, escritor de fixtures desechables y lector de validación. El
lector no obtiene permisos de escritura, borrado, cambios de política ni acceso
a otros vídeos. La identidad de procesador no sustituye la del espectador.
Cambiar permisos de Screenly, ACL del proveedor y permisos del trabajador son
tres experimentos diferentes; no inferir uno a partir del resultado de otro.

La evidencia se conserva como caso, commit, barrera alcanzada, resultado,
conteo de operaciones y digest, con identificadores de recursos anonimizados.
No registrar cookies, Authorization, errores de proveedor sin sanear o URLs
firmadas. La cuenta lectora actual de Drive no autoriza estas mutaciones.

## Casos preparados; ninguno ejecutado por este documento

Las barreras son puntos de sincronización futuros de un harness de laboratorio:
antes de autorizar, después de autorizar, antes de abrir storage y después de
leer bytes. No se añade instrumentación productiva ni se usan sleeps para
suponer que ocurrió una carrera.

| Caso                                             | Preparación futura autorizada y barrera                                                                                                                                   | Criterio de aceptación                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HLC-01 permiso retirado antes de admitir         | Confirmar commit MySQL de retirada de membresía/grant y luego pedir GET/HEAD/Range                                                                                        | La nueva admisión deniega antes de acceso, HEAD, lectura o firma de storage; aislar vías alternativas válidas                                                                              |
| HLC-02 permiso retirado después de admitir       | Abrir stream, recibir primer chunk, confirmar retirada y pedir nueva Range                                                                                                | Nueva solicitud denegada; conservar evidencia de bytes anteriores y del stream ya admitido, sin prometer cancelación automática                                                            |
| HLC-03 retirada entre autorización y apertura    | Detener en barrera posterior a política, confirmar retirada y liberar apertura                                                                                            | Caracterizar la carrera actual: no hay atomicidad DB-storage. La garantía más fuerte necesita diseño e implementación aprobados, no una expectativa inventada de 404                       |
| HLC-04 S3 overwrite de latest                    | Con permiso de escritor, crear nueva versión de la misma key después del primer HEAD                                                                                      | Si versión fijada sigue disponible/autorizada, se verifican exclusivamente sus bytes, ETag, VersionId y SHA. No exigir fallo solo porque latest cambió ni aceptar mezcla con nueva versión |
| HLC-05 Drive head cambia                         | Revisión solicitada coincide con head inicial; escritor actualiza después de metadata o durante lectura                                                                   | Se rechaza al observar head distinto, sin cambiar a latest ni aceptar revisión histórica por conveniencia; nunca devolver snapshot parcial                                                 |
| HLC-06 contenido o identidad incoherente         | Declarar si se altera una expectativa local, se inyecta una respuesta en transporte de pruebas o una operación autorizada modifica una muestra remota entre observaciones | Error saneado y ningún descriptor exitoso; cancelar/liberar lector cuando corresponda y clasificar la evidencia según su origen, sin atribuir fallos inyectados al proveedor real          |
| HLC-07 versión/revisión desaparece o ACL deniega | Administrador autorizado actúa sobre una copia desechable en una barrera exacta                                                                                           | Denegación saneada, sin retry contra otra identidad ni ampliación de permisos; clasificar 403/404 reales sin asumir su causa por el código HTTP solo                                       |
| HLC-08 objeto existente pero no publicado        | Crear huérfano bajo scope de prueba sin incluirlo en generación activa futura                                                                                             | Futuro proxy no lo lee ni firma. Listado, HEAD o hash válido no le conceden publicación; bloqueado hasta tener autoridad y proxy                                                           |
| HLC-09 EVENT/VOD                                 | Validar prefijo contiguo, nueva revisión con previousDigest y cierre; variantes con audio esperado                                                                        | Append-only conserva identidades previas, no elimina/renumera segmentos; VOD no se extiende. El validador no demuestra disponibilidad remota                                               |
| HLC-10 CAS concurrente/worker tardío             | Dos publicadores futuros compiten con revisión esperada; uno pierde lease o vídeo se borra                                                                                | Solo ganador activa; stale worker no resucita generación ni vídeo. Bloqueado por registro/CAS ausente y su implementación no autorizada                                                    |
| HLC-11 formatos legacy                           | Conservar muestras separadas TS/local/MediaConvert y fMP4, más casos ambiguos                                                                                             | No presentar contrato fMP4 v1 como compatibilidad TS/cifrado/byteranges. Clasificar y rechazar o recuperar con autorización explícita                                                      |
| HLC-12 plazo y cancelación reales                | Lector de muestra desechable grande, timeout declarado y cancelación por consumidor                                                                                       | Medir latencia, bytes y cierre observado del transporte; separar cancelación local de cese remoto, sin presentar timer simulado como evidencia de sockets                                  |

Para evitar falsas conclusiones, el cambio de latest en S3 y el cambio de head en
Drive tienen resultados distintos: S3 fija una versión explícita; el adaptador
Drive exige que la revisión pedida siga siendo el head observable. Preservar
una revisión antigua en Drive no hace que el adaptador actual pueda verificarla.

En HLC-06, cambiar solo los valores esperados prueba rechazo de expectativas
incorrectas, no una carrera remota. Una respuesta alterada por proxy o transporte
de pruebas se registra como integración con fallos inyectados, no como corrupción
real del proveedor. Para atribuir un cambio observado a un ensayo remoto, registrar
la operación concreta autorizada sobre la muestra desechable, la identidad que
la ejecutó y las barreras alcanzadas. No provocar corrupción del servicio ni
ampliar permisos para fabricar ese resultado.

## Retención, recuperación y rollback

El operador debe declarar política y periodo de conservación, lifecycle, purga
de versiones y capacidad de restauración antes de aprobar HLC-07 o una prueba
de retención. Versionado y ETag no prueban WORM. La comprobación de bytes tampoco
garantiza que una versión siga disponible mañana. No activar Object Lock,
keepForever, políticas lifecycle o permisos adicionales desde esta preparación.

Primero medir lectura repetida de una copia estable durante el intervalo acordado.
La prueba de pérdida intencional requiere aprobación separada con listado exacto
de objetos/versiones, barrera, identidad, responsable y restauración posible.
No borrar originales ni snapshots necesarios para rollback; no clasificar
antigüedad como prueba suficiente de abandono o permiso de eliminación.

Ante fallo, detener la activación y conservar inventario/diagnóstico saneados.
Un descriptor parcial nunca se anuncia. Recuperación futura: revalidar una copia
o generar un nuevo intento autorizado, sin sobrescribir la evidencia anterior.
Rollback de publicación requerirá CAS hacia una generación anterior aún válida,
existente y permitida; si no lo es, pausar admisión. No volver a URLs bearer
legacy, latest, generaciones ambiguas ni saltarse el tombstone para restaurar
reproducción.

## Evidencia disponible y condiciones de aprobación

Pueden ejecutarse offline, sin servicios, las suites existentes de contratos,
snapshots y adaptadores: `hls-publication-contract.test.ts`,
`hls-snapshot-verification.test.ts`, `hls-s3-verification-storage.test.ts` y
`hls-drive-verification-storage.test.ts`, bajo `apps/web/__tests__/unit/`.
Ya contienen mutación entre observaciones, corrupción, binding cambiado, abort,
deadline y cierre de lector simulados. **No se ejecutan de nuevo en este documento.**

Las nueve pruebas reales Drive anteriores de
[SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md](SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md)
acreditan solo dos muestras y sus lecturas concretas; no son nuevas ejecuciones
ni acreditan retención, concurrencia con escritores, CAS o permisos viewer.
Los streams controlados y la regresión de derivados también son evidencia
distinta de una conexión remota concurrente.

Para aprobar ejecución real hace falta ficha firmada por el responsable con:
servicio/host y coste, propietario, fixtures y prefijos/versiones exactos,
credenciales y permisos mínimos, operaciones permitidas, presupuesto de bytes/
tiempo, método de sincronización, limpieza y rollback. Aprobar por separado
lecturas, escrituras de fixtures, cambios de permisos y purgas. Los casos que
necesiten funciones ausentes permanecen bloqueados hasta sus incrementos de
implementación; no se marcan aprobados porque la preparación documental pase.

**Resultado de esta entrega:** especificación de casos y revisión de código,
sin ejecutar ensayos reales, modificar esquemas/servicios, activar HLS o iniciar
el siguiente incremento. No se certifica seguridad completa.
