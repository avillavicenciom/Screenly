# Fase 1.5B.6B.1 — contratos HLS aislados

Base: `07d9e2051208d5ca944bf60b436ed60129e9d3c7`, rama
`feature/screenly-phase-0`, árbol inicialmente limpio. Implementación exclusiva
de contratos y validadores; **no activada ni conectada a reproducción**.

Se revisaron AGENTS raíz/web y los documentos de HLS, publicación 6A,
revocación, MP4 y derivados. `Video.SegmentManifest`,
`desktop-recording-verification.ts`, `desktop-recording-source.ts` y
`Storage/recording-object-identity.ts` ya modelan manifiestos de upload,
inventarios de fuente e identidades de lectura. No se modifican ni se usan como
si fueran generaciones publicadas: tienen contratos y garantías distintos.

## Arquitectura y campos

`apps/web/lib/hls-publication-contract.ts` es un módulo puro de validación y
hashing, sin servicios, IO de storage, llamadas HTTP, DB, variables de entorno o
efectos al importarlo. Usa Zod y `node:crypto` existentes. No hay exports añadidos
a barrels, endpoints o servicios. Los identificadores se serializan como strings
con restricciones propias del contrato, sin sustituir los tipos de dominio.

| Campo / tipo                | Significado                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `version: 1`                | Versión reconocida; campos extra y versiones desconocidas se rechazan                                  |
| `videoId`, `ownerId`        | ASCII alfanumérico/guion/underscore, 1–128 caracteres; no URLs                                         |
| `attemptId`, `generationId` | UUID del intento y generación; permanecen estables durante una serie EVENT                             |
| `revision`                  | Entero seguro positivo; las revisiones sucesivas incrementan exactamente uno                           |
| `previousDigest`            | Null en revisión 1; digest requerido desde revisión 2; la progresión verifica el vínculo exacto        |
| `mode`                      | EVENT o VOD; no hay estado implícito de autorización/publicación efectiva                              |
| `audioIntent`               | none, optional o required; required exige al menos una pista audio, none la prohíbe                    |
| `storageProvider`           | s3 o drive, uniforme en el inventario; no elige bucket ni integración                                  |
| `tracks`                    | ID, tipo video/audio, códec y variante; al menos una pista vídeo                                       |
| `masterId`, entrada master  | Referencia al único master y sus variantes                                                             |
| Entrada variant             | ID, pista, init y lista ordenada de IDs de segmentos; es lógica, no una URL ni objeto leído de storage |
| Entrada init                | ID, pista, códec, key, tamaño positivo e identidad                                                     |
| Entrada segment             | Los mismos campos de objeto, más secuencia desde 1 y duración positiva                                 |
| `HlsManifest`               | Envoltorio estricto `{ inventory, digest }`; digest SHA256 hexadecimal minúsculo                       |

Version 1 representa **fMP4**: init `.mp4` y segmentos `.m4s`; códecs explícitos
h264/hevc/av1 para vídeo y aac/opus para audio. No presume que una etiqueta de
códec pruebe compatibilidad de bytes. No modela aún MPEG-TS sin init, ADTS puro,
cifrado/KEY, byte ranges dentro de un único objeto, discontinuidades ni tags
arbitrarios. No es un parser/rewrite de playlists M3U8.

Las claves nuevas deben pertenecer exactamente a:

```text
ownerId/videoId/.recording/hls/attemptId/generationId/...
```

Es un namespace del contrato futuro, **no un escritor activado**. Rechaza
segmentos vacíos de ruta, `.`/`..`, percent-encoding, query, fragmento, URL,
caracteres ajenos a la allowlist y extensión incompatible. Las claves no son
parámetros de un endpoint viewer: no se introduce ninguno. Antes de activar
escritores se deberá comprobar que todos los targets de upload protejan el
namespace reservado; este módulo no cambia sus permisos.

## Validación estructural

`validateHlsInventory(unknown)` comprueba esquemas estrictos y:

- IDs únicos de entradas/pistas, claves únicas, un único master y una variante
  distinta por pista. Todas las entradas deben ser alcanzables.
- Cada variante pertenece a la pista que la referencia, usa init de esa pista
  y códec, y enumera segmentos contiguos 1..N sin repetidos ni desorden.
- Grafo cerrado master → variante → init/segmento: las referencias deben existir
  y tener el rol correcto. Esto impide ciclos sin aceptar aristas arbitrarias.
- Intención de audio y tipos de códec; no se inventa una pista silenciosa.
  optional puede tener audio o no; cambiar las pistas durante EVENT no está
  permitido por esta versión del validador de progresión.
- Tamaños enteros seguros estrictamente positivos para todos los objetos;
  duración finita entre 0 y 3600 segundos, excluyendo 0; total por pista hasta
  86400 segundos. Master/variantes lógicos no tienen un tamaño de archivo.
- Identidades del proveedor declarado y ausencia de referencias ambiguas:
  dos entradas no pueden elegir una misma key o el mismo fileId Drive.

Antes del schema hay un recorrido limitado para objetos JSON ordinarios:
profundidad 12, 250000 nodos, 10000 elementos por array, 32 pistas y 10000 entradas
totales. Presupuesto conservador de 4 MiB, con reserva de 1024 bytes para el
envoltorio; se comprueba también el tamaño de la representación del inventario.
Se rechazan ciclos JavaScript, getters sin ejecutarlos, prototipos no ordinarios,
arrays dispersos, símbolos y valores no JSON. Los límites no sustituyen el
control de tamaño **antes de parsear** una futura petición HTTP; tampoco ofrecen
aislamiento frente a objetos Proxy hostiles construidos dentro del proceso.

Los fallos usan `HlsContractError` genérico, sin eco de URLs, claves ni metadata.
No hay coerción de números, campos ignorados ni aceptación de versiones futuras.

## Determinismo, digest y progresión

- `canonicalHlsInventory`: valida, ordena propiedades por orden ASCII de claves
  y las colecciones de entradas/pistas por ID. Mantiene el orden de referencias
  de variantes y segmentos, que tiene significado. No depende de locale ni de
  espacios/orden de propiedades del JSON recibido.
- `digestHlsInventory`: SHA256 de esa representación UTF-8; excluye el campo
  digest del envoltorio, evitando autorreferencia.
- `sealHlsInventory`: genera el envoltorio de un inventario validado.
- `validateHlsManifest`: comprueba estructura y digest con comparación de buffers
  de longitud fija. Un digest recalculado por un atacante no acredita procedencia.
- `validateHlsProgression`: valida ambos envoltorios, exige origen EVENT,
  revisión siguiente y previousDigest correcto; fija vídeo, propietario, intento,
  generación, proveedor, intención de audio, pistas y master. Init y segmentos
  anteriores deben permanecer idénticos, incluyendo key, identidad, tamaño,
  códec, duración y secuencia. Solo permite añadir al final de cada variante;
  puede cerrar a VOD. Un VOD no se extiende.

Una generación conserva su UUID mientras aumenta su revisión; cada revisión es
un snapshot lógico nuevo. La función no ordena generaciones UUID distintas ni
elige un ganador: eso requerirá coordinación/registro CAS posterior. Permite
revisión sin segmentos nuevos, por ejemplo para cierre EVENT→VOD. No autoriza
eliminar prefijos antiguos de un EVENT.

Las funciones no mutan el input; Zod crea representaciones separadas. Los tipos
TypeScript no son permisos ni objetos JavaScript congelados. Cualquier dato
modificado debe volver a validarse antes de usarlo: la inmutabilidad comprobada
es la de snapshots/digests y de recursos anteriores entre revisiones, no una
garantía de almacenamiento WORM proporcionada por este módulo.

## Identidad: garantías y límites

| Proveedor | Evidencia exigida en v1                                                           | Verificación posterior necesaria                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3        | versionId explícito distinto de `null`, ETag entre comillas y SHA256 de contenido | Comprobar bucket real, versión, checksum y tamaño; leer la versión exacta y condicionar por identidad. ETag multipart no es SHA256 ni prueba de integridad por sí mismo           |
| Drive     | fileId, revisionId y SHA256; tamaño en la entrada                                 | Resolver pertenencia y revisión, verificar checksum/tamaño, disponibilidad y lectura de la revisión o condición equivalente; no inferir pinning solo desde el metadata almacenado |

La política S3 es deliberadamente estricta: buckets sin versionado o sin checksum
verificable no obtienen una identidad v1 por inventar campos. Requerirán otra
estrategia aprobada de snapshots/identidad antes de admitirlos. Las identidades
Drive existentes de `getGoogleDriveRecordingIdentity` no se reinterpretan como
esta estructura sin un adaptador y comprobaciones reales.

Un inventario válido acredita solamente coherencia de **declaraciones**. No
prueba bytes, existencia, estabilidad del proveedor, intención del propietario,
commit de publicación ni autorización vigente del espectador. El SHA256 aquí
no es firma/HMAC y no autentica al productor. No se crean credenciales, tokens
viewer, llamadas de lectura ni capacidades para workers.

## Compatibilidad legacy y riesgos

No se migran manifiestos actuales ni se convierte automáticamente
`SegmentManifest` en esta versión. No cambia el comportamiento de MPEG-TS,
MediaConvert, `local`, custom buckets, Drive, Windows, web o render farm. La
reconstrucción legacy sigue siendo una propuesta de 6A: fuentes ambiguas se
clasificarán, no se admitirán porque listObjects las encuentre.

Faltan adaptadores de formatos legacy, pruebas de bytes/códecs, validación real
de S3/Drive, control de escrituras inmutables, registro activo, CAS, publicación,
proxy HLS y clientes. El contrato no limita ancho de banda ni valida timeline
multimedia entre pistas; eso debe comprobarlo el verificador de artefactos.
No hay certificación de seguridad ni revocación HLS nueva en esta entrega.

## Pruebas y checks ejecutados

**282 pruebas aprobadas / 7 archivos**, incluidas **63 nuevas** de contratos:

```bash
bun run --cwd apps/web test \
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

Los casos cubren EVENT/VOD, audio, ambos proveedores, determinismo, digest,
secuencias, pertenencia, traversal, referencias externas/cíclicas/ausentes,
identidades ambiguas, límites, campos desconocidos, versiones y progresión.
Las pruebas de eliminación/reordenación y cambio de intento incluyen inventarios
válidos individualmente que deben ser rechazados al compararlos.

Typecheck web aprobado sin errores. El media server conserva exactamente los
siete errores previos, comparados sin diferencias: tres TS2352 en
`drive-resumable-upload.test.ts` (107/124/141), TS2769 en
`media-routes-real-world.integration.test.ts` (1061), TS2322 en `media-size.test.ts`
(34), dos TS2345 en `capcodec-encoder.ts` (337/344). No se tocan esos archivos.
Biome de los dos archivos TS, Prettier del documento y diff comprobados.

La búsqueda de imports `hls-publication-contract` en código de apps/packages
solo encuentra el nuevo test: no hay invocaciones productivas, registro de
rutas ni barrels modificados. No hay servicios iniciados, migraciones, llamadas
pagadas o cambios de infraestructura. No se ejecuta E2E ni storage real.

## Próximo incremento y parada

Revisar las restricciones de v1 —especialmente fMP4, versionado S3, audio y
límites— y aprobar pruebas aisladas de identidad/snapshot contra proveedores,
con su propia autorización de entorno. Cualquier adaptación de escritores,
registro CAS, esquema, proxy o publicación requiere un incremento aprobado
por separado. El contrato actual no obliga a desplegarlo para grabaciones legacy.

**Detenido tras 1.5B.6B.1 para revisión.** Commits separados de código/pruebas y
documentación; rama existente, sin merge ni cambio Draft/Ready del PR #1,
`main` intacta. Sin cambios de comportamiento productivo.
