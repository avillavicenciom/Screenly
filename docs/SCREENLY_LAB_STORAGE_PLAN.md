# Laboratorio de almacenamiento: propuesta S3 compatible y límites Drive

Fecha: 2026-10-28. Base `47fa26d2c`, rama `feature/screenly-phase-0`.
Estado: diseño preparado; **sin servicio, bucket ni compatibilidad real aprobados**.
No se contrata AWS ni se inicia MinIO, Docker o infraestructura en esta entrega.

## Topología propuesta y decisión pendiente

Usar una VM o máquina de laboratorio dedicada, fuera del VPS de producción,
con almacenamiento y credenciales exclusivos. Puede compartir la red privada
del laboratorio MySQL/E2E, pero no volúmenes, identidades o datos productivos.
El responsable debe aprobar máquina, capacidad, responsable, coste si existe,
endpoint HTTPS y procedimiento de apagado/borrado antes de aprovisionar.
No se presupone que ese recurso ya exista ni que tenga coste cero.

MinIO es candidato porque evita exigir una cuenta AWS. La referencia encontrada
en `packages/local-docker/docker-compose.yml` fija
`pgsty/minio:RELEASE.2026-08-04T00-00-00Z` con digest
`sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372`.
Es evidencia de una versión declarada, **no de soporte FULL_OBJECT comprobado**.
Su origen, mantenimiento, licencia y compatibilidad deben revisarse al aprobar
la imagen concreta; no se propone usar `latest` ni cambiar el compose actual.

**No reutilizar el arranque del compose como laboratorio seguro.** Su servicio
`createbuckets` configura lectura anónima `s3:GetObject` de todos los objetos;
también utiliza credenciales de desarrollo fijas y publica puertos en el host.
Aquí solo se inspeccionó ese archivo. El futuro laboratorio necesita configuración
independiente, bucket privado y consola administrativa fuera del acceso viewer.

## Recursos, identidades y permisos separados

Los nombres siguientes son roles propuestos, no cuentas creadas ni bindings
existentes. Un bucket privado por ejecución o suite facilita aislamiento y
limpieza; el responsable debe confirmar sus identificadores fuera de Git.

| Rol                                 | Capacidad futura                                                                                                       | Exclusión                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Administrador de laboratorio        | Crear servicio/bucket privado, versionado, TLS y políticas; entregar inventario de capacidades                         | Credencial nunca entregada al runner ni al servidor viewer                                          |
| Preparador de fixtures              | Subir solo muestras nuevas bajo el namespace aprobado; registrar VersionId, ETag, tamaño y SHA local                   | Sin escritura sobre originales; sin permisos administrativos ni cambios ACL                         |
| Lector de verificación HLS          | HEAD/GET de versiones exactas de las claves inventariadas; permiso equivalente a GetObjectVersion y checksum requerido | Sin listado, subida, copia, borrado o administración; el runner no invoca firmadores ni expone URLs |
| Aplicación viewer de laboratorio    | Lectura de las claves sintéticas requeridas por MP4/derivados                                                          | Identidad distinta del usuario viewer; nunca comparte credenciales con el navegador                 |
| Operador de limpieza o concurrencia | Solo operaciones concretas aprobadas sobre muestras desechables de la ejecución                                        | Credencial separada; no habilitada en el primer ensayo lector                                       |

El lector HLS y el viewer no tienen el mismo contrato: el proxy existente puede
resolver una miniatura mediante `listObjects` después de autorizar. Preferir una
miniatura publicada con clave conocida; si se prueba descubrimiento, limitar
ListBucket al prefijo sintético correspondiente con una identidad viewer propia.
No ampliar el lector del adaptador HLS para satisfacer ese flujo distinto.

Las credenciales SigV4 deben ser nativas válidas, seleccionadas explícitamente
por perfil/rol de laboratorio. Los placeholders de secretos HTTPS de Codex no
sirven como access/secret keys para calcular una firma. No usar la cadena de
credenciales por defecto para descubrir recursos, ni publicar claves en `.env`,
scripts, manifiestos o logs. La entrega segura y su readiness son gates previos.

IAM no ofrece aquí un permiso independiente para impedir generar una URL
prefirmada: quien posee una clave SigV4 con lectura puede construir una URL
capability dentro de ese alcance. No invocar firmadores ni exponer esas URLs es
una invariante del código y del transporte del runner, no una garantía separada
de IAM. El navegador nunca recibe la clave lectora ni URLs prefirmadas; el origen
permanece privado. Los permisos acotados limitan el alcance de una credencial,
pero no prueban por sí solos esa separación de la vía viewer.

## Contrato existente que el proveedor debe demostrar

`apps/web/lib/hls-s3-verification-storage.ts::createHlsS3VerificationStorage`
usa `HeadObjectCommand` y `GetObjectCommand` con Bucket fijo, Key validada,
VersionId explícito, IfMatch y ChecksumMode ENABLED. No acepta VersionId `null`.
`observation` exige HTTP 200, longitud positiva segura, ausencia de delete marker
y ContentRange, identidad coincidente y ChecksumType **FULL_OBJECT** con
ChecksumSHA256 base64 canónico de 32 bytes.

`prepareVerifiedHlsSnapshot` en `apps/web/lib/hls-snapshot-verification.ts`
compara HEAD/GET/HEAD y calcula el SHA256 de los bytes. ETag no sustituye ese hash;
un ETag multipart puede admitirse únicamente con el resto de pruebas válidas.
No declarar compatible un checksum COMPOSITE, un campo inventado por el runner,
metadata de usuario que simule el checksum ni una respuesta sin ChecksumType.

La aceptación inicial necesita comprobar en **HEAD y GET de la versión exacta**
los campos reales que devuelve el SDK instalado. Si MinIO u otro candidato no
los ofrece, registrar incompatibilidad y detener la validación del adaptador.
No añadir una capa que falsifique FULL_OBJECT ni relajar producción para obtener
una prueba verde. Elegir otro proveedor o cambiar el contrato sería otro diseño
y requeriría aprobación. S3 compatible no equivale automáticamente a compatible
con este adaptador estricto.

Preferir muestras sin KMS externo para el primer ensayo. Si se requiere cifrado
con KMS, revisar permisos de checksum/descifrado y disponibilidad separadamente;
no conceder capacidades de administración por conveniencia. No se presupone
Object Lock, WORM o retención por tener versionado activado.

## Fixtures y transporte preparados conceptualmente

El paquete `docs/fixtures/screenly-hls-fixtures.zip` contiene init de 826 bytes
y segmento de 1151 bytes, con hashes independientes y una playlist local.
Se pueden reutilizar sus bytes sintéticos en un futuro bucket nuevo, pero subirlos
requiere autorización para el preparador. El ZIP no es un HlsManifest publicado.

El preparador deberá entregar scope, inventario v1 sellado y mapping independiente
de key a versión, fuera de Git, con namespace del contrato
`ownerId/videoId/.recording/hls/attemptId/generationId/`. No aceptar un manifiesto
que elija libremente un bucket o identidad ajena al inventario revisado.
Para el primer ensayo proponer dos objetos, 2048 bytes máximos por objeto,
4096 totales y plazo de 15 segundos, dentro de los límites existentes del motor.

E2E MP4/derivados necesita además un MP4 sintético completo y recursos publicados
con claves canónicas: miniatura JPEG/PNG, GIF, `transcription.vtt`,
`enhanced-audio.mp3` y medios/poster de comentario respaldados por su fila DB.
Sus rutas y validaciones se encuentran en `apps/web/lib/viewer-derivatives.ts`
(`derivativeResponse`, `resolveComment`, `resolveThumbnail`) y
`apps/web/lib/comment-media.ts`. No inventar una ruta SRT ni publicar archivos
internos de análisis. Preparar esos bytes y filas es un gate de escritura futuro.

El endpoint deberá usar TLS verificado y destino exacto permitido por la red del
runner; región, estilo de direccionamiento y hostname que construye el SDK deben
quedar acordados antes de conectar. No desactivar validación TLS, el proxy o la
política de egress para solucionar fallos. La consola y la API S3 son superficies
distintas: no abrir la consola a los usuarios de pruebas.

## Casos reales preparados, ninguno ejecutado aquí

| Caso                                                   | Evidencia exigida                                                                       | Operación futura                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Identidad y bytes correctos                            | Descriptor completo, tamaño/hash local y versión exacta; sin firmas o URLs en respuesta | Lector: HEAD/GET/HEAD                                                    |
| VersionId, ETag, tamaño o SHA esperado alterados       | Fallo cerrado, sin latest fallback ni snapshot parcial                                  | Solo cambiar input local; lectura acotada de muestras                    |
| Key/scope ajenos                                       | Rechazo antes de cualquier SDK send                                                     | Sin acceder al objeto ajeno                                              |
| Credencial lectora y acceso anónimo                    | Lector accede; solicitud anónima a la muestra privada falla                             | Solo lectura; política preparada por administrador                       |
| FULL_OBJECT ausente/COMPOSITE o proveedor incompatible | Incompatibilidad explícita; no normalizar respuesta para aparentar soporte              | Lectura de metadatos/bytes concretos                                     |
| Abort/cancelación/timeout                              | Cancelación local, limpieza y errores saneados; medir por separado cese remoto          | Solo lectura; muestra grande requiere aprobación de presupuesto          |
| Retirada de permiso viewer                             | Nueva GET/HEAD/Range al proxy denegada antes de storage                                 | Cambio de permisos MySQL de fixture autorizado, no cambio ACL del bucket |
| Mutación, retención, purga o ACL concurrentes          | Identidad consistente o rechazo; inventario de versiones antes/después y rollback       | Bloqueado hasta aprobar escritura/administración separadas               |

Una prueba de revocación de aplicación no prueba revocación de una firma directa
antigua. Tampoco un cambio de head acredita que sobreviva una revisión histórica.
Los borrados y las políticas lifecycle/retención deben revisarse en el plan de
concurrencia; no se activan automáticamente y pueden impedir el rollback.

## Aprobación y rollback del laboratorio

Antes del primer ensayo, aprobar responsable/máquina, proveedor e imagen exactos,
TLS/red, bucket privado y versionado, identidades y entrega de credenciales,
presupuesto/plazo, fixtures y versiones exactas, revisión del runner GET/HEAD-only
y procedimiento de limpieza. El runner S3 real todavía no está implementado.
No basta con aprobar un nombre de bucket o comprobar que abre su consola.

Separar dos autorizaciones: preparar recursos/fixtures, y ejecutar después una
suite lectora sobre el inventario confirmado. Una tercera aprobación cubre
mutación/ACL/retención y su limpieza. Detener nuevas ejecuciones, revocar solo las
credenciales del laboratorio y conservar evidencias saneadas permite rollback
operativo; no borrar versiones u objetos hasta autorizar la limpieza acotada.
No reactivar enlaces legacy ni alterar originales para recuperar una prueba.

Las **nueve pruebas Drive reales anteriores** son antecedentes de dos muestras
con revisión actual, descritos en `SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md`.
No se repiten aquí, no se renuevan credenciales y no acreditan S3/MinIO, permisos
viewer, retención histórica, concurrencia o seguridad HLS completa. Esta entrega
solo inspecciona código y prepara el diseño; no añade resultados de proveedor real.
