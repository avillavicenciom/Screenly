# Laboratorio Drive: acceso real y preparación de muestras

Fecha: 2026-10-27. Rama `feature/screenly-phase-0`, base `94fda0f0f`.
Continuación de `SCREENLY_HLS_REAL_STORAGE_REQUIREMENTS.md`; su diagnóstico de
ausencia de credenciales describe el estado anterior, no el observado aquí.

## Resultado real y límites

Tras publicar la configuración del entorno de Codex, un GET autenticado de
metadatos de la carpeta de pruebas devolvió **HTTP 200**. Se comprobó que es una
carpeta Drive no eliminada. Un listado limitado a sus hijos directos, con
`trashed = false` y máximo 20 elementos, devolvió **cero archivos** y ninguna
página adicional. No se buscó contenido fuera de esa carpeta.

La identidad y la carpeta se entregan mediante variables del entorno, y el token
mediante `SCREENLY_HLS_TEST_DRIVE_ACCESS_TOKEN`, restringido al dominio
`www.googleapis.com`. No se registran valores de credenciales ni identificadores
de recursos reales en este documento. Las lecturas no crean, suben, eliminan ni
modifican objetos o permisos. La cuenta de servicio se mantiene como lectora.

Los intentos anteriores devolvían 401. El primer 200 desde Codex se observó
después de publicar la configuración. Esto no prueba por sí solo la causa exacta
de los 401 ni que el token se renueve automáticamente: es temporal y puede
caducar antes de la siguiente prueba.

La configuración publicada reporta acceso de red **sin restricción de destinos**;
no debe confundirse con la restricción de entrega del secreto a Google. No se
modificó la red durante esta validación. Se recomienda revisar en la interfaz si
pueden conservarse los presets necesarios y limitarse los destinos adicionales
a `www.googleapis.com`, según el procedimiento anterior.

**No se ha validado todavía el adaptador contra bytes reales de Drive.** Tampoco
se ha validado reproducción HLS, autorización viewer, retención de revisiones,
S3/MinIO, MySQL, mutación concurrente ni E2E. El proxy y la publicación siguen
inactivos. Acceder a una carpeta no demuestra que las revisiones de sus archivos
sean descargables o cumplan los requisitos de identidad del adaptador.

## Muestra sintética preparada

Se generó fuera del repositorio un vídeo azul H.264 de un segundo, 160×90,
10 fotogramas, sin audio ni datos personales, usando FFmpeg 7.1.5. El paquete
[`screenly-hls-fixtures.zip`](fixtures/screenly-hls-fixtures.zip) se conserva en
`docs/fixtures/` para descargarlo desde GitHub; el enlace inicial al workspace no
permitía descargarlo desde el chat. No es una dependencia. Contiene init, un segmento fMP4, playlist local,
metadatos y las instrucciones de subida.

| Archivo           | Bytes | SHA256 de la muestra entregada                                     |
| ----------------- | ----: | ------------------------------------------------------------------ |
| `init.mp4`        |   826 | `96c57394149a06bd56a7e7510561bddd41d5e3e3341822e4328b9f6f8cb007e2` |
| `segment_000.m4s` |  1151 | `89a500a7fee616f091278abb7f15b88225dc6a860b902dbcad744a2fc1febdc4` |
| `index.m3u8`      |   173 | `5899dd2ddae809fccad0f5a652a11008019533dea75255a0dc8171d1fc18ef5b` |

La playlist incluye `EXT-X-MAP`, un segmento y `EXT-X-ENDLIST`, con referencias
locales, sin URLs de almacenamiento. `fixture-metadata.json` permite conservar
hashes y tamaños independientes antes de subirlos. **No es un HlsManifest v1 ni
una autorización de publicación.** El hash valida bytes; no acredita derechos
de publicación ni sustituye la autorización del espectador.

Receta ejecutada, desde un directorio de salida vacío:

```bash
ffmpeg -hide_banner -loglevel error -nostdin -n \
  -f lavfi -i color=c=blue:s=160x90:r=10 -t 1 -an \
  -c:v libx264 -pix_fmt yuv420p -g 10 -sc_threshold 0 \
  -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename segment_%03d.m4s index.m3u8
ffmpeg -hide_banner -loglevel error -nostdin -i index.m3u8 -f null -
ffprobe -v error -count_frames \
  -show_entries stream=codec_name,width,height,nb_read_frames \
  -show_entries format=duration -of json index.m3u8
```

La decodificación completa terminó sin errores; ffprobe confirmó H.264, 160×90,
10 fotogramas y duración 1.000000 s. No se promete identidad binaria entre
versiones diferentes de FFmpeg/libx264: una nueva generación exige registrar sus
propios hashes, nunca aceptar un hash diferente del esperado tras la subida.

## Próximo paso con intervención del responsable

1. Descargar y extraer el paquete. Subir **los dos archivos individuales**
   `init.mp4` y `segment_000.m4s` a la carpeta privada de laboratorio ya compartida.
   No sustituir archivos existentes ni subir grabaciones personales. No basta
   con subir el ZIP: el adaptador necesita dos archivos binarios independientes.
2. Confirmar la subida. Mediante inventario acotado de esa carpeta se podrán
   identificar los dos fileIds, sin buscarlos en el resto de la cuenta. Verificar
   nombres, pertenencia a la carpeta, tamaño y SHA contra la evidencia local.
   Rechazar duplicados o discrepancias; no elegir arbitrariamente el primer
   archivo. Guardar el mapping de confianza fuera de Git.
3. Comprobar que Drive expone `headRevisionId`, `sha256Checksum`, `size`, MIME y
   `trashed=false`. Preparar scope y manifiesto v1 con las identidades observadas
   y hashes locales, sellándolo con `sealHlsInventory` de
   `apps/web/lib/hls-publication-contract.ts`. La elección del fileId debe venir
   del mapping revisado, no del manifiesto que se verifica.
4. Preparar y revisar un runner optativo de solo lectura, con presupuesto y
   plazo limitados. Debe usar
   `createHlsDriveVerificationStorage` de
   `apps/web/lib/hls-drive-verification-storage.ts` y
   `prepareVerifiedHlsSnapshot` de
   `apps/web/lib/hls-snapshot-verification.ts`, sin activar endpoints. No hay
   runner live incorporado por esta entrega.
5. Ejecutar el caso correcto y los negativos modificando solo las expectativas
   locales: SHA/tamaño/revisión alterados, key ajena antes de IO y cancelación.
   Registrar resultados reales y fallos saneados. No reducir validaciones de
   Content-Length, revisión o checksum para conseguir que un proveedor pase.

Si la API de revisión exige otros permisos, redirige o no expone la identidad
requerida, registrar la incompatibilidad y detenerse. No recurrir al contenido
latest, ampliar scopes o modificar objetos automáticamente. Las pruebas de ACL
modificada, borrado y concurrencia con escritores necesitan alcance separado.

## Regresión y restricciones

Se ejecutó la regresión offline de los adaptadores S3/Drive y del motor indicada
en el documento de requisitos: **148 pruebas aprobadas en tres archivos**
(Drive 51, S3 53, motor 44). Son pruebas simuladas, separadas del GET y del
listado reales; sus resultados no certifican Drive ni la seguridad del sistema.

No hay cambios productivos, dependencias, lockfiles, schema, migraciones,
servidores o contenedores. No se modifica el VPS ni `main`. El PR #1 permanece
en borrador, sin merge ni despliegue. El paso bloqueante es la entrega de las
dos muestras a Drive por su responsable, antes de iniciar validación de bytes.
