# Screenly: propuesta de ejecución del laboratorio aislado

Fecha: 2026-10-28. Rama `feature/screenly-phase-0`, base `47fa26d2c`.
**Entrega de diseño para revisión; no se ha creado un laboratorio operativo.**

## Decisión propuesta

Preparar una VM Linux dedicada en una máquina de pruebas controlada por el
responsable, fuera del VPS y de la red de producción. Es la opción preferida
si existe capacidad local: evita exigir AWS o contratar hosting. No se ha
confirmado que esa máquina exista ni que el alojamiento sea gratuito.

Propuesta de tamaño inicial: 4 vCPU, 16 GiB RAM y 60 GiB de disco disponible,
ajustable por el operador. Es una estimación para app, navegador y servicios,
no un mínimo medido ni una prueba de rendimiento. Antes de aprovisionar,
confirmar host físico, virtualización, capacidad, responsable y coste real.
Si no hay capacidad, presentar otra ubicación para aprobación; no contratarla.

Dentro de la VM: instancia Screenly de laboratorio al commit aprobado, MySQL
Community 8.4 LTS como candidata y servicio S3 compatible MinIO como candidato.
Cada imagen necesita patch/digest, procedencia y soporte revisados. La referencia
MySQL 8.0 del repositorio no prueba compatibilidad con 8.4; esa comprobación
precede a fixtures y E2E. La referencia MinIO fijada en el repo tampoco demuestra
SHA256 FULL_OBJECT. No se alteran imágenes, dependencias o infraestructura aquí.

El navegador y el futuro runner pueden ejecutarse dentro del laboratorio.
Codex no necesita acceso al VPS ni se supone que pueda alcanzar una VM privada.
Transferir código o resultados saneados no autoriza acceso remoto: cualquier
conexión nueva desde Codex requiere destino, red y credencial aprobados.

## Topología y aislamiento

| Componente propuesto   | Límite                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Host/VM de laboratorio | Sin datos, montajes, credenciales ni conectividad privilegiada de producción; sin VM ya creada                      |
| Web HTTPS              | Origen privado y certificado confiable para el navegador; origen exacto por confirmar; no desactivar Secure o CSRF  |
| MySQL                  | Red privada interna, sin puerto público; DB exclusiva por run, esquema compatible preparado por operador autorizado |
| MinIO candidato        | API privada con TLS y bucket/versiones de muestras; consola separada del runner; acceso anónimo denegado            |
| Runner/navegador       | Opt-in, destinos exactos y perfiles explícitos; no arranca automáticamente servicios ni descubre recursos           |
| Control de fixtures    | Identidad separada; escrituras por IDs/keys/versiones inventariados, solo después de aprobación                     |
| Evidencia              | Conteos, estados, hashes y tiempos; sin OTP, cookies, contraseñas, credenciales o URLs firmadas                     |

No copiar el compose de desarrollo de
`packages/local-docker/docker-compose.yml`: MySQL permite root vacío y expone
3306; MinIO tiene credenciales de desarrollo fijas y el bootstrap configura
GetObject anónimo. Son hallazgos del código inspeccionado, no afirmaciones sobre
el VPS ni sobre un servicio desplegado.

No activar los runners E2E existentes por su nombre: algunos arrancan procesos,
vacían tablas, suben objetos o llaman a IA. Se necesita un runner dedicado con
preflight, no un wrapper que active preparación destructiva global.

## Equipo y entregables preparados

| Responsable                | Entregable exclusivo                                                         | Resultado de la preparación                                             |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Subagente MySQL            | [SCREENLY_LAB_MYSQL_PLAN.md](SCREENLY_LAB_MYSQL_PLAN.md)                     | Tablas/joins reales, fixtures, roles y revocación persistida            |
| Subagente almacenamiento   | [SCREENLY_LAB_STORAGE_PLAN.md](SCREENLY_LAB_STORAGE_PLAN.md)                 | Proveedor candidato, identidades, compatibilidad, versiones y checksums |
| Subagente E2E              | [SCREENLY_LAB_E2E_PLAN.md](SCREENLY_LAB_E2E_PLAN.md)                         | Once casos especificados para login, reproducción y nuevas lecturas     |
| Subagente HLS/concurrencia | [SCREENLY_LAB_HLS_CONCURRENCY_PLAN.md](SCREENLY_LAB_HLS_CONCURRENCY_PLAN.md) | Doce casos especificados, barreras, retención y publicación futura      |
| Auditor independiente      | Revisión de los planes y de esta propuesta, sin editar                       | Revisa aislamiento, condiciones de ejecución y límites de evidencia     |
| Coordinador                | Este documento e integración Git                                             | Centraliza decisiones, comprobaciones, commits y actualización del PR   |

Los casos son especificaciones, **no tests ejecutables nuevos**. Cada editor
trabajó en su archivo, sin modificar código productivo. La autorización actual
cubre revisión de código, documentos y preparación de casos; no ejecución remota,
aprovisionamiento, DDL, DML, permisos o purgas.

## Orden y autorización por incremento

| Gate                      | Acción futura propuesta                                                                                       | Qué debe aprobarse antes                                                                                                                    | Evidencia requerida para avanzar                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A: ubicación y seguridad  | Concretar host, VM, red, imágenes y esquema                                                                   | Responsable, recursos exactos, coste y operaciones de preparación; todavía no servicios                                                     | Ficha de ejecución completa y revisión de las versiones/imagen/esquema                                         |
| B: preparación de MySQL   | Preparar la VM aprobada, aprovisionar/arrancar MySQL externo y después preparar esquema y fixtures sintéticas | Aprobar explícitamente VM, servicio y arranque, además de esquema/seed, cuenta de preparación, escrituras y limpieza; fuera de este entorno | Tablas/campos esperados y joins de membresía/grant comprobados; ningún runner ejecuta migraciones por fallback |
| C: almacenamiento lector  | Preparador sube nuevas muestras; lector verifica versiones exactas                                            | Bucket/keys/versiones, credenciales nativas, TLS; subida separada de la ejecución lectora                                                   | Acceso anónimo denegado y contrato FULL_OBJECT real en HEAD/GET; incompatibilidad bloquea                      |
| D: runner E2E             | Implementar runner y observabilidad, revisar offline y luego ejecutar                                         | Instancia HTTPS, navegador, OTP privado, sesiones y DML de revocación aprobados                                                             | Login real, commit confirmado antes de nueva solicitud y cero IO de storage correlacionado por petición        |
| E: retención/concurrencia | Mutar muestras desechables en barreras controladas                                                            | Operaciones exactas de escritura/ACL/purga, identidades separadas y recuperación                                                            | Resultado por proveedor, sin mezclar inyecciones con fallos reales ni latest con versión fijada                |
| F: HLS completo           | Diseñar/implementar registro de publicación, CAS y proxy por recurso                                          | Implementación productiva específica y cualquier esquema necesario                                                                          | Generaciones permitidas, URI internas y autorización por recurso; E2E HLS propio                               |

Aprobar un gate no autoriza los siguientes. Preparar un esquema de laboratorio
puede requerir DDL/migraciones, pero **esta entrega no las genera ni aplica**.
Crear servicios fuera de este entorno también requiere aprobación: AGENTS.md
sigue prohibiendo arrancarlos aquí.

## Condiciones que evitan conclusiones falsas

La sesión web actual es JWT y comprueba `users.authSessionVersion`; poblar
`sessions` o fabricar JWT no acredita el login real. La propuesta principal usa
NextAuth/OTP existente. La rama de OTP por consola solo sería admisible si el
harness captura un pipe privado en memoria antes de cualquier logging; si la
plataforma registra stdout antes, queda bloqueada. No cambiar NODE_ENV u otras
banderas para eludir restricciones. No se activa correo o SSO externo.

El acceso por organización necesita las relaciones reales con shared_videos;
un grant exige email normalizado y revokedAt nulo. El rol de runtime debe
permitir las escrituras de autenticación necesarias: un observador SELECT no
sustituye al proceso NextAuth. Los permisos mínimos se detallan en el plan MySQL.

Una clave S3 lectora puede generar firmas dentro de su alcance: no existe un
permiso IAM separado que garantice no-presign. Es una invariante del código
viewer/runner no invocar firmadores ni exponer credenciales o URLs de origen.
La identidad de usuario de Screenly no es la credencial del proveedor.

S3 puede seguir leyendo una versión fijada intacta aunque cambie latest; Drive
exige que la revisión solicitada siga asociada al head actual. Ninguno demuestra
retención por una sola lectura. Tampoco existe atomicidad entre autorización
viewer y apertura de storage: un permiso retirado tras admitir un stream no
implica retirada de sus bytes.

Registro activo/CAS y proxy HLS no están implementados en este incremento.
El listado legacy no acredita publicación. MP4, derivados y sus E2E futuros no
certifican la protección de enlaces HLS antiguos.

## Ficha necesaria antes de ejecutar

El responsable completa fuera de Git, sin incluir secretos en el chat:

- Host propietario y ubicación, capacidad, coste y fecha de apagado.
- Commit, origen HTTPS y certificados; versiones/digests elegidos.
- Identidad exacta de instancia/schema MySQL, compatibilidad y roles aprobados.
- Endpoint/bucket y namespace de storage; acceso privado y capacidades reales.
- Inventario por run: IDs válidos según esquema, keys, tamaños, hashes y versiones.
- Mecanismo de entrega segura de credenciales, login OTP y captura sin secretos.
- Comandos/operaciones permitidas, límite temporal y de bytes, responsable de limpieza.
- Evidencia de aislamiento, rollback y condiciones de parada.

No bastan un hostname local, un nombre con prefijo lab o una credencial que
consiga conectar para demostrar aislamiento. Cualquier discrepancia debe detener
el futuro preflight antes de mutar datos.

## Verificación de esta entrega y parada

Se revisó la presencia de requisitos: DATABASE_URL, MYSQL_URL y los nombres
de bucket/región/endpoint/perfil/scope/manifiesto de pruebas no están configurados
en esta sesión. No prueba ausencia de servicios externos; no se buscaron.
Un secreto Drive configurado tampoco acredita ahora acceso ni vigencia del token:
no se hizo ninguna petición al proveedor.

La evidencia anterior se conserva: 636 pruebas offline aprobadas y nueve live
omitidas en el incremento de derivados, y nueve casos reales Drive de una
entrega previa. **No se repiten ni se presentan como pruebas de este laboratorio.**

La comprobación de esta entrega se limita a formato Markdown, enlaces locales,
diff y auditoría de los documentos. No corresponde ejecutar typecheck, suites
de aplicación o tests reales por modificar únicamente documentación. No se
crean fixtures remotas ni runners, no se realizan conexiones a proveedores y no
se certifica seguridad. La publicación actual es exclusivamente documental en
la rama existente, con PR #1 en borrador y main intacta.

Resultado: cinco documentos con formato comprobado, siete enlaces locales
verificados y auditoría independiente sin bloqueos. Se aclararon la autorización
explícita de aprovisionar/arrancar MySQL, la protección de OTP, los roles runtime,
la capacidad de prefirmar con credenciales SigV4 y la separación de inyecciones
frente a mutaciones reales. Son resultados de revisión documental, no pruebas
de funcionamiento de los servicios propuestos.

**Siguiente decisión solicitada:** revisar esta propuesta y confirmar una
ubicación/responsable de laboratorio; después autorizar por separado la
preparación concreta de MySQL. Hasta entonces, todo ensayo real queda bloqueado.
