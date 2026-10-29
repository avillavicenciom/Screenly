# Propuesta de laboratorio MySQL para autorización multimedia

Fecha: 2026-10-28. Base `47fa26d2c`, rama `feature/screenly-phase-0`.
Estado: diseño para aprobación; sin conexiones, SQL ejecutado, servicios,
provisión, cambios de esquema ni migraciones. No es un laboratorio operativo.

## Topología y versión propuestas

Una máquina de laboratorio dedicada, administrada por el responsable del
entorno, fuera del VPS y de la red/datos de producción. MySQL y la futura app de
pruebas deben compartir una red privada exclusiva; no publicar 3306 a Internet.
Si Codex necesita TCP remoto, su acceso y el destino exacto requieren aprobación
de red adicional: un secreto del proxy HTTP no establece acceso TCP MySQL.

Una base vacía exclusiva por ejecución, identificada en un manifiesto local del
operador; el nombre propuesto es `screenly_lab_<run>`, no un recurso existente.
Rechazar cualquier nombre/host que no coincida exactamente con lo aprobado,
aunque la credencial consiga conectar. No utilizar dumps ni réplicas de producción.

`packages/local-docker/docker-compose.yml::ps-mysql` declara `mysql:8.0`;
es la referencia histórica de compatibilidad del repositorio, no una imagen
aprobada para el laboratorio. Se propone **MySQL Community 8.4 LTS como candidata**,
sin afirmar compatibilidad comprobada. Antes de ejecutar, el operador debe
confirmar soporte vigente, versión de parche y digest inmutable. Un gate previo
al seed/E2E deberá contrastar esquema y consultas existentes con esa versión.
La ausencia de esa decisión o incompatibilidad bloquea las pruebas; no se utiliza
latest ni se aplican migraciones para hacer pasar el gate en esta tarea.

No copiar la configuración de desarrollo: permite root sin contraseña, host
root comodín y expone 3306. Proponer credenciales distintas por función,
administración inaccesible al runner y TLS verificado si la conexión cruza
máquinas. No desactivar verificación de certificados para conseguir conexión.

## Esquema y autenticación que realmente usa el código

La fuente es `packages/database/schema.ts`; `packages/database/index.ts::db`
crea y cachea un cliente Drizzle/mysql2 desde DATABASE_URL. La prueba futura
debe arrancar un proceso limpio con la URL de laboratorio antes de importar
ese módulo; no cambiar de base por caso dentro del mismo proceso cacheado.

El operador debe entregar un esquema compatible con el commit aprobado,
incluidos `video_viewer_grants` y `users.authSessionVersion`. Que esas
definiciones estén en TypeScript no prueba que existan en una DB real. Si faltan,
detenerse y solicitar un trabajo de preparación de esquema autorizado; aquí no
se genera ni aplica SQL, ni se ejecuta db:push o db:generate.

La web usa **JWT**, no sesiones de DB como mecanismo principal:
`packages/database/auth/auth-options.ts::authOptions` declara strategy jwt y
`decodeSessionToken` compara sessionVersion con users.authSessionVersion.
Poblar `sessions` no crea una sesión web válida. La tabla y el
`drizzle-adapter.ts::getSessionAndUser` existen, pero no sustituyen ese flujo.

La propuesta E2E principal es el flujo OTP real de NextAuth con usuarios de
laboratorio y su emisión normal de cookie JWT; usa un NEXTAUTH_SECRET exclusivo,
temporal y no versionado. `authOptions::sendVerificationRequest` permite un canal
de consola cuando el correo está deshabilitado, salvo la combinación production
y NEXT_PUBLIC_IS_CAP=true. Un futuro harness podría consumir ese canal en memoria,
sin persistir ni mostrar OTP, cookies o logs sensibles, pero requiere aprobación
del arranque aislado y revisión del mecanismo. No se necesita contratar correo
ni se activa ese flujo aquí. Revisar restricciones de dominios en
`auth/domain-utils.ts::isBlockedAccountEmail` antes de elegir correos ficticios.

Una cookie JWT fabricada/firmada por un test solo contaría como integración
autenticada; **no acredita login ni E2E de sesiones reales**. No se propone como
sustituto de OTP ni se añade un login productivo de tests. La tabla
verification_tokens y las escrituras del adapter forman parte del flujo OTP.

## Fixtures y relaciones necesarias

IDs generados por `packages/database/helpers.ts::nanoId` (15 caracteres) y
guardados en un manifiesto de ejecución fuera de Git. Los nombres siguientes
son alias lógicos, no IDs ni filas creadas. Correos sintéticos únicos por
ejecución, sin buzones personales, notificaciones ni servicios externos.

| Alias          | Filas y campos determinantes                                                                                 | Aislamiento de la autorización                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| owner          | users con id/email/authSessionVersion=0/activeOrganizationId; organizations con ownerId, tombstoneAt nulo    | Propietario de todos los vídeos del caso                                                      |
| member         | users distinto; organization_members con userId y organizationId; shared_videos con videoId y organizationId | Sin grant ni membresía de espacio alternativa                                                 |
| viewer         | users distinto; video_viewer_grants con videoId, email normalizado, invitedByUserId=owner, revokedAt nulo    | Sin organization_members o space_members que concedan acceso al vídeo                         |
| outsider       | users distinto, sin relaciones de acceso                                                                     | Sesión válida, permiso ausente                                                                |
| anonymous      | Sin cookie ni fila adicional                                                                                 | Público explícito permite; privado deniega                                                    |
| video-private  | videos con ownerId/orgId, public=false, source desktopMP4; claves de muestras declaradas, sin trabajos IA    | Versión base para miembros y grants                                                           |
| video-public   | Vídeo separado, public=true; organización sin restricción de dominio para este caso                          | Permite probar cambio a privado sin otra vía                                                  |
| video-password | Vídeo privado con password preparado por el mecanismo de hash real                                           | Miembro conserva membresía, pero la verificación anterior deja de valer al cambiar contraseña |
| space-member   | spaces + space_members + space_videos, sobre un vídeo de caso separado                                       | Verifica la otra vía de membresía y contraseñas heredadas                                     |
| comment-video  | comments canónico del vídeo, autor fixture y mediaMeta/keys coherentes                                       | Solo para ampliar después a medios/poster de comentarios                                      |

La membresía de organización por sí sola **no basta**:
`OrganisationsRepo.membershipForVideo` une organization_members con shared_videos.
`SpacesRepo.membershipForVideo` une space_members con space_videos.
`VideosRepo.hasViewerGrant` exige revokedAt nulo y email trim/lowercase.
La fixture debe probar estas consultas reales, no reemplazarlas por el mock
booleano de los tests actuales.

Password en videos/spaces no es contraseña MySQL. Prepararlo con el flujo
existente `apps/web/actions/videos/password.ts` y los helpers que usa, nunca
confundir el tipo llamado encryptedText con evidencia de cifrado automático.
`Video.verifyPasswordCandidates` compara candidatos verificados actuales;
el caso incluye invalidación del adjunto/cookie anterior. No publicar passwords
de muestra, hashes ni cookies de sesión en informes.

## Roles y permisos propuestos

La app tiene un único DATABASE_URL cacheado por proceso: no se puede fingir que
cada consulta cambia entre lector y escritor sin modificar el código productivo.
Separar procesos/credenciales para observación, app y operador de fixtures.

| Función                                         | Acceso mínimo inicial                                                                                                                                               | Exclusiones                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Observador de política                          | SELECT en users, organizations, videos, organization_members, shared_videos, video_viewer_grants, spaces, space_members, space_videos; comments solo para sus casos | Sin DDL, escritura, administración ni acceso a otras bases                                                                                     |
| Runtime app, perfil OTP con usuarios precreados | SELECT anterior más accounts y organization_invites; SELECT/INSERT/UPDATE/DELETE en verification_tokens; UPDATE en users según updateUser                           | No DML en permisos de vídeo, DDL ni administración. Sin INSERT de usuarios para signup no previsto ni escrituras accounts/sessions por defecto |
| Operador de fixtures externo                    | SELECT/INSERT/UPDATE/DELETE en tablas de fixtures de la DB exclusiva, incluidos IDs declarados de verification_tokens para limpieza                                 | Sin CREATE/ALTER/DROP/TRUNCATE, GRANT, FILE, SUPER, desactivar FK ni borrado global                                                            |
| Preparador de esquema                           | Operador humano separado, fuera del runner                                                                                                                          | Preparación pendiente de autorización; sus privilegios no se entregan a tests                                                                  |

El perfil runtime parte del callchain inspeccionado en
`auth/drizzle-adapter.ts`: getUserByEmail consulta users y hasLinkedAccount
(accounts), y puede consultar hasPendingProvisionedInvite
(organization_invites/organization_members); createVerificationToken lee e
inserta o actualiza verification_tokens, useVerificationToken consume por DELETE;
updateUser actualiza users. El callback jwt consulta users y la estrategia es JWT,
no la persistencia de sesiones. OAuth/SSO/createUser/linkAccount quedan fuera del
perfil inicial; si el harness realmente alcanza otra escritura, detenerlo para
revisar el alcance y los grants antes de ampliarlos.

updateUser llama `loops/queue.ts::enqueueLoopsSync`: proponer
LOOPS_SYNC_ENABLED distinto de true para que este laboratorio no escriba ni
procese loops_sync_jobs ni haga sincronización externa. Esa variable es
configuración futura, no modificada aquí. Si se solicita probar esa rama, sus
permisos y efectos se aprobarán aparte; no conceder privilegios de outbox ni
arrancar workers para completar un login.

MySQL no ofrece aislamiento por prefijo de filas mediante estos grants básicos.
La DB exclusiva es la frontera efectiva; el manifiesto de IDs añade trazabilidad,
no seguridad equivalente a row-level security. Lecturas de configuración de
storage y tablas adicionales para la app E2E se aprobarán separadamente; no
conceder SELECT global para evitar revisarlas.

El hash de contraseña de vídeo usa `crypto.ts::hashPassword` (PBKDF2) sin
DATABASE_ENCRYPTION_KEY. En cambio, el flujo E2E de contraseña utiliza
`apps/web/lib/password-cookie.ts::setVerifiedPasswordCookie` y lectura posterior,
con encrypt/decrypt; requiere una DATABASE_ENCRYPTION_KEY exclusiva del
laboratorio, igual que las configuraciones storage cifradas que se incluyan.
No exportar claves productivas ni registrar valores secretos o cookies.

## Secuencia futura de prueba y aceptación

1. Gate de solo lectura: comprobar identidad del destino aprobado, versión,
   esquema esperado y ausencia de datos ajenos; nunca descubrir bases para
   buscar una que funcione. Sin aprobación del destino, no conectar.
2. El operador autorizado prepara y confirma fixtures; registrar solo alias,
   commit, runId y conteos saneados. No imprimir URL con credenciales.
3. Ejecutar política/repositorios reales contra la DB, separados de E2E;
   admitir owner/member/viewer, denegar outsider/anónimo privado.
4. Retirar el grant con revokedAt o la relación de membresía exacta, confirmar
   COMMIT y observarlo con una consulta independiente antes de emitir una nueva
   solicitud. No inferir persistencia desde un cambio local o transacción abierta.
5. Repetir GET/HEAD/Range/If-Range para MP4/derivados en la futura app autorizada:
   404 vacío y sin operaciones de storage tras denegación. Registrar solo
   contadores y estados; demostrar cero IO requerirá instrumentación revisada.
6. Casos separados: public→private; password anterior; restricción de dominio;
   espacio; tombstone de organización; incremento authSessionVersion;
   rollback de mutación no confirmada. Fallos DB deben denegar, no conceder.
7. Control positivo: retirar una vía mientras otra siga vigente puede mantener
   acceso. No presentar ese resultado correcto como un fallo de revocación.

No hay una transacción conjunta DB-storage ni revocación por chunk. El criterio
es nueva admisión tras cambio confirmado; no recuperar bytes descargados ni
prometer detener streams admitidos antes del commit.

## Limpieza, recuperación y gate de aprobación

Conservar manifiesto de IDs antes de cualquier escritura futura. Limpiar en orden
inverso a dependencias, por igualdad de IDs y pertenencia a la DB aprobada, con
conteos esperados y FK activas; no TRUNCATE, DELETE sin filtro ni limpieza por edad.
No utilizar `agent-local-e2e.test.ts::seedDatabase`: vacía tablas globalmente.

Ante un fallo, pausar el runner y conservar evidencia saneada y las fixtures
aisladas para diagnóstico. El rollback de permisos solo restaura filas/valores
fixture declarados y requiere transacción confirmada; no restaurar una imagen de
producción ni cambiar permisos reales. La eliminación completa de la DB/VM es
operación del responsable, pendiente de autorización propia.

Para aprobar la ejecución faltan: responsable y máquina dedicada, versión/digest
con soporte confirmado, destino/DB exactos, mecanismo TCP/TLS, esquema compatible
ya preparado o trabajo específico autorizado, credenciales separadas, manifiesto
de fixtures, alcance escrito de mutaciones y limpieza y plazo de eliminación.

Resultado de esta entrega: inspección de código y plan, **cero pruebas MySQL
reales ejecutadas**. Las 636 pruebas offline y nueve Drive reales previas son
antecedentes; no acreditan este laboratorio ni persistencia de permisos.
