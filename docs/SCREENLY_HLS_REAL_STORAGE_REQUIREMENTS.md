# Requisitos de entorno para validar HLS con almacenamiento real

**Actualización posterior (2026-10-27):** ya se verificaron dos muestras Drive
con nueve casos reales de adaptador/motor; véase
[SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md](SCREENLY_HLS_DRIVE_LIVE_VALIDATION.md).
S3/MinIO, MySQL y E2E siguen pendientes. El diagnóstico siguiente corresponde
a la preparación previa a la entrega de credenciales y muestras.

**Estado: preparado el procedimiento; ejecución real bloqueada por falta de
recursos y credenciales de pruebas.** El usuario confirma que todavía no dispone
del entorno y solicita preparar sus requisitos. No se provisiona nada en esta
entrega. Rama `feature/screenly-phase-0`, base `5417a7768`.

## Evidencia del entorno actual

El checkout está limpio y los adaptadores están disponibles. Las variables que
apuntan a configuración/credenciales AWS y Google existen, pero los archivos
AWS no tienen secciones y el JSON de Google está vacío. No hay `.env` local,
bindings de secretos o requisitos runtime de storage en el borrador inspeccionado.
Se inspeccionaron nombres/presencia, no se imprimieron valores de secretos.

La política de red del borrador solo tiene presets de gestores de paquetes, sin
reglas específicas para el bucket ni Google Drive. Esto no prueba conectividad
ni autorización de almacenamiento. No se realizaron lecturas a buckets/Drive,
listados de cuentas ni búsquedas automáticas de recursos de producción.

El workflow offline funciona: **148 pruebas aprobadas en tres archivos**:

```bash
export PATH=/workspace/.tools/node_modules/.bin:$PATH
cd /workspace/Screenly
bun run --cwd apps/web test \
  __tests__/unit/hls-s3-verification-storage.test.ts \
  __tests__/unit/hls-drive-verification-storage.test.ts \
  __tests__/unit/hls-snapshot-verification.test.ts
```

Son simulaciones y streams locales, no pruebas reales de proveedor. No se inicia
MySQL, MinIO, Docker, servidores Next ni procesos del VPS. Para esta verificación
aislada de adaptadores no se necesita MySQL; transacciones/CAS y reproducción
E2E requerirán entornos adicionales y su propio alcance.

## 1. Recursos que debe preparar el responsable del entorno

| Proveedor               | Recurso mínimo                                                                  | Condiciones                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| S3 o MinIO ya operativo | Bucket exclusivo de pruebas, región y endpoint exactos, versionado habilitado   | Versiones explícitas, ETag y ChecksumSHA256 FULL_OBJECT observables; no mezclar con bucket productivo                      |
| Drive                   | Cuenta/integración de prueba y dos archivos binarios pequeños                   | Compartidos expresamente con la identidad de prueba; headRevisionId, SHA256, tamaño y trashed=false observables            |
| Ambos                   | Un init fMP4 y un segmento m4s no sensibles, junto con un manifiesto v1 sellado | Claves bajo owner/video/.recording/hls/attempt/generation; tamaño y hash conocidos, pista/códec coherentes con el contrato |

El responsable prepara las muestras antes de la validación. La cuenta que ejecuta
las pruebas no las crea, sobrescribe, publica ni borra. Una muestra versionada
puede servir para lecturas de éxito y fallos con valores esperados alterados,
sin mutar objetos reales. No subir grabaciones personales como fixture.

Un S3 compatible que no ofrezca FULL_OBJECT no se considera aprobado por tener
versionado o ETag multipart. Se registra incompatibilidad; no se reduce el
contrato para conseguir una prueba verde. Drive admite solo la revisión que
puede asociar al head actual; no se promete validar revisiones antiguas.

## 2. Datos no secretos y entrega de fixtures

Configurar o indicar los siguientes datos; los nombres SCREENLY son requisitos
del procedimiento, no variables ya consumidas por endpoints productivos:

| Nombre propuesto                     | Dato                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| SCREENLY_HLS_TEST_S3_BUCKET          | Bucket de prueba concreto                                                                              |
| SCREENLY_HLS_TEST_S3_REGION          | Región del servicio                                                                                    |
| SCREENLY_HLS_TEST_S3_ENDPOINT        | Endpoint HTTPS si es MinIO/S3 compatible; omitir para AWS estándar                                     |
| SCREENLY_HLS_TEST_AWS_PROFILE        | Perfil nativo o rol dedicado que debe usarse explícitamente                                            |
| SCREENLY_HLS_TEST_SCOPE_FILE         | Ruta local a un JSON con ownerId, videoId, attemptId, generationId, storageProvider y storageBindingId |
| SCREENLY_HLS_TEST_MANIFEST_FILE      | Ruta al HlsManifest v1 con inventario y digest válidos                                                 |
| SCREENLY_HLS_TEST_DRIVE_MAPPING_FILE | Ruta al mapping interno de cada key a su fileId de prueba                                              |

Preparar un juego de scope/manifiesto por proveedor, no combinar identidades de
S3 y Drive en el mismo inventario. Un identificador no secreto puede ser sensible
operativamente: guardar los archivos reales fuera del repositorio, no en Git.
No incluir Authorization, tokens, URLs firmadas, contraseñas o credenciales en
esos JSON. El mapping debe ser independiente del fileId solicitado por el
manifiesto y haber sido confirmado por el responsable del entorno.

## 3. Credenciales y permisos mínimos

**S3/MinIO:** perfil/rol nativo de pruebas con lectura de versiones de las claves
exactas. En AWS, revisar GetObjectVersion y los permisos necesarios para HEAD de
esas versiones/checksums. No conceder ListBucket, PutObject, DeleteObject,
DeleteObjectVersion ni administración. Si hay KMS, revisar separadamente los
permisos de checksum/descifrado estrictamente necesarios; preferir fixtures que
eviten introducir KMS como dependencia adicional del primer ensayo.

No usar la cadena de credenciales por defecto para descubrir cuentas. El SDK
debe cargar el perfil/rol de pruebas declarado explícitamente. Si solo existe
un mecanismo de secretos proxy HTTPS, **no utilizar sus placeholders como claves
crudas para SigV4**: la firma debe calcularse con credenciales nativas válidas.
Hay que confirmar un mecanismo seguro compatible de entrega de perfil/rol antes
de conectar; no almacenar ni pegar claves en este chat o en código.

**Drive:** acceso OAuth seguro limitado a las muestras. Preferir scope de solo
lectura si el mecanismo de integración lo permite y compartir únicamente los
archivos de prueba. La existencia de GOOGLE_APPLICATION_CREDENTIALS no equivale
a tener un token Drive con acceso efectivo; un service account puede necesitar
compartición expresa. No crear consentimiento OAuth o cuentas desde esta tarea.

Usar los mecanismos seguros de configuración del entorno para valores secretos.
No solicitarlos por chat ni copiar tokens a manifests, logs o scripts guardados.
No declarar un refresh flow hasta identificar qué mecanismo se utilizará.

## 4. Red y ejecución

Una vez conocidos los destinos, permitir solo:

- El hostname exacto del bucket virtual-hosted o endpoint S3/MinIO elegido;
  incluir el hostname regional que realmente construya el SDK.
- `www.googleapis.com` para metadata y bytes de revisión Drive.
- Un host OAuth adicional únicamente si se aprueba un flujo de renovación que
  lo necesite. No se añade como requisito implícito de cada lectura.

Preservar presets y reglas existentes; no habilitar `*`, todos los subdominios
AWS o redirects de descarga para eludir restricciones. No desactivar TLS. La
actualización de un borrador no aplica ni verifica la red del runtime.

No se propone iniciar MinIO local: AGENTS.md prohíbe servicios adicionales y el
usuario mantiene el VPS fuera de alcance. Si no hay un servicio de pruebas ya
disponible, su aprovisionamiento necesita un trabajo y autorización separados,
incluyendo coste, identidad del administrador y procedimiento de limpieza.

## 5. Comprobaciones antes de cualquier conexión real

1. Confirmar rama/HEAD y que los recursos están declarados exclusivamente de
   pruebas, con responsable, proveedor, host y claves/fileIds exactos.
2. Comprobar configuración de red y credencial seleccionada sin imprimir su
   valor ni permitir fallback al perfil por defecto/producción.
3. Validar offline estructura, digest, ámbito y límites del manifiesto; confirmar
   que el mapping Drive no deriva simplemente del propio manifiesto.
4. Verificar que el runner solo puede invocar HEAD/GET/metadata y no escribe,
   lista, cambia ACL, activa generaciones o modifica los originales.
5. Empezar con init/segmento pequeños y plazo/presupuesto reducidos. No ejecutar
   un inventario completo de la cuenta para buscar candidatos.

El runner de integración real todavía no está implementado: hay que concretarlo
con estos recursos y el mecanismo de credenciales, sin activar los adaptadores
en endpoints. Los unit tests actuales no se renombran ni presentan como live.

## 6. Matriz mínima de pruebas reales

| Caso                                           | Resultado necesario                                        | Operación sobre originales                    |
| ---------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| Versión/revisión, tamaño y SHA correctos       | Descriptor completo con bytes/hash comprobados             | Solo lectura                                  |
| Scope/key/fileId ajeno                         | Denegación antes de acceder al recurso no permitido        | No leer un recurso ajeno para demostrarlo     |
| Versión/revisión inexistente o distinta        | Fallo cerrado, sin latest fallback                         | Cambiar solo el input de prueba               |
| Digest/tamaño/checksum esperado alterado       | Rechazo y ningún snapshot parcial                          | Cambiar solo el input, no el objeto           |
| Credencial sin acceso a las muestras           | Rechazo saneado, sin ampliar permisos                      | Cuenta de prueba preparada por su responsable |
| Timeout, abort y consumidor cancelado          | Cese de operación local, cancelación y liberación de locks | Solo lectura                                  |
| S3 sin FULL_OBJECT o Drive sin head/SHA fiable | Incompatibilidad explícita                                 | No corregir metadata automáticamente          |

Registrar proveedor/escenario, commit, estado, conteos y tiempos; no registrar
headers de autorización, URLs firmadas, archivos de credenciales o errores SDK
en bruto. Reportar por separado aprobado, rechazado esperado, bloqueado y no
ejecutado. Si faltan casos/recursos, el conjunto no se declara aprobado.

Mutación concurrente real, retención/purga, eliminación, subida, denegación por
ACL modificada y restauración requieren autorización de escritura separada.
Cambiar una fixture no prueba una carrera real. Tampoco esta matriz demuestra
autorización viewer, MySQL/CAS, reproducción E2E o seguridad de infraestructura.

## Resultado de esta preparación

Se guardó un borrador del entorno con los siete nombres no secretos de la tabla
y un anexo a start_skill que conserva las instrucciones existentes, registra el
workflow offline verificado y sus gates de acceso real. No se modifica
install_script, la red ni los secretos. El guardado está confirmado y requiere
revisar/guardar los ajustes y publicar el entorno para activarlos; no ejecuta
comandos ni proporciona recursos, credenciales o conectividad al runtime actual.

Auditor independiente: confirma falta de targets reales y la separación entre
credenciales nativas SigV4 y secretos del proxy; revisa alcance de solo lectura.
No realizó llamadas autenticadas ni cambios. Formato y diff de este documento
se comprueban antes de publicarlo. Sin código productivo, schema, lockfiles,
servicios, migraciones, merge o cambio de estado del PR #1.

**Para desbloquear:** disponer de recursos exclusivos de prueba, muestras y
manifiestos, mecanismo seguro de credenciales nativas/OAuth y destinos de red
concretos. No hay ensayo real aprobado ni entorno real listo todavía.
