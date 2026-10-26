# Fase 1 — creación privada de vídeos

Primer incremento autorizado tras la auditoría. Mantener PR #1 en borrador;
sin merge, despliegue, instaladores ni servicios de IA externos.

## Cambios separados

1. `getNewVideoPublic` conserva la validación de organización y devuelve privado
   incluso con la variable legacy `CAP_VIDEOS_DEFAULT_PUBLIC=true`. Esa variable
   permanece reconocida por compatibilidad, pero no publica nuevos vídeos.
2. `VideosRepo.create` fuerza `public: false` al insertar. La duplicación de la
   biblioteca y el workflow de agentes tampoco heredan visibilidad pública del
   original. El replay de una copia existente no cambia su visibilidad.
3. `schema.ts` cambia únicamente el default SQL de `videos.public` a false.
   Migración generada por Drizzle: `0051_mushy_sharon_carter.sql`, snapshot y
   entrada nueva del journal. No hay UPDATE de vídeos existentes.

El helper cubre creadores desktop, web, móvil, importación de archivos/Loom y
API v1 que lo invocan. La capa repositorio protege también llamadas directas
que traigan `public: true`. Compartir después de crear sigue siendo una acción
explícita y autorizada; no se bloquea ni se altera la visibilidad histórica.

## Verificación

Antes de las correcciones, las regresiones fallaron por obtener true en lugar de
false para el default legacy, la inserción directa y las dos duplicaciones.
Después: **281 pruebas aprobadas en 10 archivos**, con DB, storage y red simulados.
Incluyen visibilidad, atomicidad, copias, publicación explícita, autorización,
creación desktop, preparación de grabación, importación Loom y contratos API.

Desde `apps/web`, con Bun 1.4.4 en PATH:

```bash
bun run test __tests__/unit/video-sharing-default.test.ts __tests__/unit/desktop-video-create.test.ts __tests__/unit/recording-prepare.test.ts __tests__/unit/share-cap-authorization.test.ts __tests__/unit/videos-policy.test.ts __tests__/unit/video-create-atomicity.test.ts __tests__/unit/recording-storage-lifecycle.test.ts __tests__/unit/agent-duplicate-privacy.test.ts __tests__/unit/loom-import.test.ts __tests__/unit/agent-api-contract.test.ts
```

La generación se ejecutó con una URL local sin credenciales usada únicamente
para satisfacer la configuración de Drizzle. No abrió conexión a MySQL. Una
segunda generación no detectó cambios. Se compararon los snapshots como JSON:
solo cambia el default de `videos.public`, además de los IDs del snapshot.
Las entradas anteriores del journal permanecen idénticas.

`bun run typecheck` completo aprobó (generación de tipos Next y `tsc-rs -b`),
con avisos de serialización de clases de proveedores IA durante la generación
de workflows, sin errores. No inicia servicios ni consume esos proveedores.

Biome revisó los archivos TS/JSON modificados; advierte de un `as any`
preexistente en `VideosRepo.ts`, fuera de las líneas cambiadas. Markdown se
comprueba con Prettier y el diff con Git. Manifiestos y lockfiles intactos.

## Límites y siguiente tarea

La migración **no está aplicada** a ninguna base de datos. Su ejecución y la
validación real MySQL quedan pendientes de una tarea autorizada con un entorno
aislado. Tampoco se han verificado S3/CDN reales, Windows ni E2E de navegador.
Esto no certifica que la instalación actual sea privada o esté lista para uso.

El cambio se refiere a la biblioteca `videos`. La API comercial embebida utiliza
otra tabla, `developer_videos`, y su propio modelo de claves/enlaces: no debe
activarse para Screenly sin una revisión específica de privacidad. No se han
activado integraciones ni alterado esa API en este incremento.

Próxima tarea propuesta: probar que un vídeo privado nuevo no expone metadatos,
miniaturas, MP4/HLS ni transcript a un anónimo, y que propietario y destinatarios
autorizados mantienen acceso. Separar esos cambios por endpoint y conservar el
comportamiento de publicación explícita.

## Segundo incremento: autorización en endpoints

Se añade una matriz de cuatro perfiles: anónimo, propietario, miembro autorizado
por una compartición de organización y usuario autenticado sin permiso. La
política real `buildCanViewLoaded` decide; no se sustituye por un booleano que
repita el resultado esperado. Sesiones, repositorios y storage son fixtures.

- `/api/storage/object`: GET de MP4, bytes de miniatura, manifest HLS, segmento
  HLS y VTT; HEAD de MP4. Se exige 404 sin leer, consultar metadatos de storage
  ni firmar URLs para los dos perfiles sin acceso; propietario/miembro reciben
  200 y los bytes esperados.
- `/api/thumbnail`: emisión de URL firmada solo tras política aprobada. Una
  denegación no consulta la fila del vídeo ni firma objetos.
- `/api/playlist`: master, vídeo y audio HLS. La denegación devuelve 401 sin
  leer el manifest almacenado ni firmar segmentos; los autorizados reciben 200
  con contenido M3U8.

Los tests llaman los handlers HTTP reales sin escuchar puertos. En el límite
`Videos.getByIdForViewing` el fixture aplica la política real con repositorios
simulados: no valida la implementación completa del servicio ni la sesión real.
La batería conjunta de políticas, descargas, objetos, thumbnails y playlists
aprobó 170 pruebas en siete archivos. La matriz añade 32 casos (28 de recursos y
cuatro parametrizados de playlists, cada uno recorre tres playlists).
El typecheck completo y Biome de los dos archivos de pruebas aprobaron; el
Markdown se verificó con Prettier.

No se ha cambiado lógica de aplicación. Quedan pendientes E2E, S3/CDN reales,
revocación/caché y todos los endpoints alternativos. Estos casos simulan solicitudes
sin tokens firmados válidos: una URL firmada es una credencial bearer y merece
pruebas separadas de alcance, caducidad y revocación. El VTT visible y el transcript
editable privado son recursos distintos; los tests existentes mantienen el rechazo
del JSON editable en el proxy genérico.

No se aplica la migración, no se despliega ni se certifica privacidad en producción.
