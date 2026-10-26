# Fase 1.3 — enlaces privados, caducidad y caché

Revisión y pruebas aisladas del 26 de octubre de 2026. Sin modificar lógica de
aplicación, aplicar migraciones, conectar MySQL/S3/MinIO, desplegar, iniciar
servicios o cambiar el estado del PR #1. No certifica privacidad en producción.

## Resultado ejecutivo

**La revocación inmediata de un enlace antiguo no está garantizada.** La pérdida
de membresía bloquea una petición normal, pero un token de objeto válido permite
seguir leyendo bytes sin sesión hasta que caduque. Además hay respuestas con URLs
privadas que no prohíben caché, y el redirect de preview declara caché pública.
Las pruebas caracterizan esos riesgos; que aprueben no significa que los riesgos
estén resueltos ni que el comportamiento actual sea el objetivo de seguridad.

## Caducidad observada

| Vía                            | Duración por defecto                                         | Evidencia y límites                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token del proxy de objetos     | 3600 segundos                                                | `Storage/SignedObject.ts::createStorageObjectToken`; reloj simulado verifica validez antes y rechazo después                                        |
| S3 GET firmado                 | 3600 segundos                                                | `S3Buckets/S3BucketAccess.ts`; firma AWS local con credenciales ficticias, `X-Amz-Expires=3600`; override de 60 segundos probado                    |
| CloudFront firmado             | 3600 segundos en el proveedor                                | `S3Buckets/index.ts`; `cloudfront-signed-url.ts` incluye deadline en policy; tests existentes verifican alcance exacto de objeto, sin contactar CDN |
| Google Drive servido por proxy | 3600 segundos normalmente; ruta interna usa 7200 por defecto | `Storage/index.ts::createDriveObjectUrl` y wrappers de URLs; lectura estática                                                                       |
| Multimedia interno (GET/PUT)   | 10800 segundos                                               | `api/upload/[...route]/multipart.ts` usa overrides de tres horas; inspección estática                                                               |
| Preview GIF                    | Firma solicitada por 3600 segundos                           | `/api/video/preview`; el redirect puede cachearse 300 segundos                                                                                      |

Los callers pueden sobrescribir TTL. No todos los enlaces tienen la misma vida;
la duración efectiva S3 también depende de credenciales temporales, reloj y
políticas del proveedor, no comprobadas aquí. El token propio acepta el milisegundo
exacto `expiresAt` porque verifica `< Date.now()`, no `<=`; prueba de
caracterización incluida. Eliminarlo del navegador no revoca otras copias.

## Revocación y conocimiento del identificador

En `/api/storage/object`, un token verificado que coincide con `videoId` y `key`
usa `getTokenVideo`/`VideosRepo.getById`. No llama a la política del espectador.
Sin token válido usa `getPolicyVideo`/`Videos.getByIdForViewing`.

La prueba recorre: miembro permitido → membresía revocada → URL normal 404 →
misma URL con token previamente emitido y sin sesión 200 → pasada una hora 404.
La política real `buildCanViewLoaded` decide la membresía; repositorios, sesión y
almacenamiento son fixtures. No se presenta como revocación contra un proveedor.

Conocer el ID sin credencial no basta en los handlers cubiertos. Modificar firma,
clave o ID tampoco autoriza otro objeto: las pruebas esperan denegación y cero
lecturas. Los bytes descargados antes de revocar permisos no pueden recuperarse
ni hacerse desaparecer del equipo receptor mediante caducidad o no-store.

S3/CloudFront son capacidades bearer independientes de la sesión. Cambiar roles
en MySQL no consulta ni invalida sus firmas ya entregadas. Acortar TTL reduce la
ventana; no ofrece revocación inmediata. Para ese requisito conviene entregar
recursos privados por un proxy que revalide autorización o usar capacidades
revocables con versión/registro y control en cada lectura. Separar tokens de
usuarios de credenciales internas antes de modificar el bypass: el procesamiento
multimedia utiliza URLs firmadas y podría romperse.

## Caché: cabeceras comprobadas y huecos

| Respuesta                               | Resultado                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Bytes del proxy de objetos              | `CACHE_CONTROL_HEADERS` real incluye `no-store, no-cache, must-revalidate, proxy-revalidate`, Pragma y Expires; probado |
| Playlists                               | Usan `CACHE_CONTROL_HEADERS` en las ramas inspeccionadas; permisos cubiertos por las pruebas anteriores                 |
| `/api/video/preview` 302 autorizado     | **`public, max-age=300`**, confirmado por prueba; no adecuado para un redirect dependiente de permisos                  |
| `/api/thumbnail` JSON con URL firmada   | Sin Cache-Control explícito, confirmado con helpers reales                                                              |
| Proxy de objetos que redirige a storage | `Response.redirect` sin Cache-Control explícito, confirmado                                                             |

No se ha demostrado que una CDN concreta haya filtrado respuestas; se ha
demostrado qué cabeceras emiten los handlers. No-store instruye a caches
conformes; no evita copias deliberadas. Cachear un redirect puede evitar volver
a consultar permisos mientras entrega una capacidad aún válida. Las cabeceras
del destino S3/CDN, su configuración y cualquier caché previa son desconocidas.

## Almacenamiento: configuración declarada frente a permisos efectivos

`infra/sst.config.ts` crea `RecordingsBucket` y CORS y declara un rol Vercel con
`s3:*` sobre bucket/objetos. No demuestra ACL, Block Public Access ni política
efectiva de la instalación Screenly. CORS no sustituye autenticación ni una ACL.
`docker-compose.yml` crea el bucket MinIO; tampoco acredita permisos del VPS.
No se han leído credenciales ni utilizado las claves ficticias de tests en red.

Pendiente en entorno autorizado: GET/HEAD anónimos sin firma deben fallar para
MP4, HLS, segmentos, miniaturas y VTT; comprobar ACL, políticas, acceso público,
CDN/origin, credenciales con mínimo privilegio, TTL real, expiración y respuestas
tras revocar membresías. Verificar también objetos existentes y URLs antiguas.
No cambiar políticas del bucket real a partir de una inferencia del repositorio.

## Cobertura y rutas alternativas

| Ruta/familia                                                                  | Estado de esta revisión                                                                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/storage/object` GET/HEAD                                                | Pruebas aisladas de perfiles y ahora ciclo real de token; incluye archivos MP4/HLS/VTT y miniatura                                                       |
| `/api/thumbnail`                                                              | Matriz de perfiles y cabeceras reales de respuesta; storage simulado                                                                                     |
| `/api/playlist`                                                               | Pruebas existentes de master/vídeo/audio, readiness y redirección MP4; sin proveedor real                                                                |
| `/api/video/preview` GET/HEAD                                                 | GET autorizado y caché caracterizados; HEAD comparte handler; matriz completa propia pendiente                                                           |
| `/api/video/og`                                                               | Delega a `actions/videos/get-og-image.tsx`; código devuelve imagen locked/password antes de buscar thumbnail privado; no se certifica aquí con test HTTP |
| `/api/video/transcribe/status`                                                | Inspección: exige sesión y `VideosPolicy.canView`; entrega estado, no VTT; matriz HTTP específica pendiente                                              |
| API móvil y API v1                                                            | Emiten o consumen URLs/transcripts en rutas propias; inspección estática, no cubiertas completamente por este incremento                                 |
| API de agentes/MCP, SDK comercial, comentarios con medios y rutas de acciones | Superficies adicionales a incluir en inventario y regresiones; sin afirmar cobertura exhaustiva                                                          |

`/api/download` entrega instaladores según plataforma, no el vídeo privado:
no debe confundirse con descargas multimedia. Los tests de utilidad de thumbnail
OG no certifican la autorización del endpoint OG. El JSON editable cifrado de
transcript sigue siendo distinto del VTT público para espectadores autorizados.

## Evidencia reproducible

Desde `apps/web`, Bun 1.4.4:

```bash
bun run test __tests__/unit/private-resource-authorization.test.ts __tests__/unit/s3-bucket-access.test.ts __tests__/unit/cloudfront-signed-url.test.ts __tests__/unit/storage-object-response-headers.test.ts __tests__/unit/storage-object-verification.test.ts __tests__/unit/segment-playlist-route.test.ts
```

Resultado: **128 pruebas aprobadas en seis archivos**. La selección anterior con
`og-thumbnail` también aprobó (132 casos antes de añadir dos casos de caché);
no se suman ambas ejecuciones. Diez casos nuevos de ciclo/caché elevan la matriz
de recursos de 28 a 38; S3 añade aserciones de TTL a un caso existente.
No se han ejecutado E2E ni pruebas reales MySQL/storage. Biome revisa tests,
Prettier la documentación y el typecheck completo aprobó para el incremento.

## Siguientes incrementos recomendados

1. Corregir cabeceras de preview, thumbnail y redirects privados a
   `private, no-store`, con regresiones que esperen el comportamiento seguro.
2. Definir revocación inmediata para espectadores y separar capacidades internas;
   probar retiro de permisos, cambios de contraseña, borrado y tokens antiguos.
3. Completar matrices de endpoints alternativos y validación real de
   almacenamiento/CDN en entorno autorizado. No aplicar migración ni desplegar
   mientras estas verificaciones sigan pendientes.
