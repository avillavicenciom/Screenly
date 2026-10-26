# Fase 1.5B — incrementos 1, 2 y 3

Implementación limitada aprobada tras 1.5A. No se implementan el proxy de
reproducción, grants de invitados, epochs ni registro de capacidades revocables.
No se modifican endpoints de espectadores, DB, migraciones, dependencias o
lockfiles. No se despliegan servicios ni se modifica el VPS.

## Incremento 1: contratos sin activación

`apps/media-server/src/lib/media-capability-contract.ts` distingue principal de
visualización, propietario, miembro, subida, procesamiento y administración.
El contrato runtime admite solo una operación interna: `audio.extract`, POST
`/audio/extract`, issuer `screenly-web`, audience `screenly-media-server` y
purpose `processing`. Requiere trabajo, intento UUID, vídeo, propietario, digest
del input, jti y tiempos acotados. Campos extra y propósitos incompatibles se
rechazan. No concede ningún permiso de espectador.

La garantía futura de revalidar la siguiente petición de reproducción sigue
siendo un contrato pendiente de los incrementos 4–8, no una capacidad activada
por declarar estos tipos. No se elimina la compatibilidad legacy.

## Incremento 2: firma y validación separadas

`media-capability.ts` firma con HMAC-SHA256 y prefijo/dominio
`screenly-processing-v1`, con clave inyectada de al menos 32 bytes. No importa
NextAuth ni utiliza su secreto. Verifica forma estricta, codificación canónica,
longitud, firma constante, método/path, job/attempt, vídeo/propietario y digest
SHA256 de la URL exacta. La URL, que puede contener una firma de storage, no se
incluye dentro del token. El digest identifica la URL, **no los bytes del vídeo**.

La ventana de admisión es de cinco minutos. El instante exacto `now >= expiresAt`
se rechaza; tampoco se aceptan tokens emitidos en el futuro. Los relojes deben
estar sincronizados. No se corta una extracción admitida por superar esos cinco
minutos: no es un límite de duración del stream ni una implementación de
revocación en vuelo. jti identifica emisiones, pero no hay registro anti-replay.

Los tests demuestran rechazo de tokens de viewer en el verificador interno y
del token interno en el verificador viewer, incluso con igual clave de fixture.
Se mantiene separación de dominio además de requerir claves operativas distintas.
Upload y reupload siguen intactos y sus regresiones pasan.

## Incremento 3: primer consumidor, extracción normal para transcripción

Flujo preparado:

1. `workflows/transcribe.ts::extractAudio` aporta job de transcripción e intento
   UUID al cliente solo para la extracción normal `audio-temp.mp3`.
2. `lib/transcription-media-authorization.ts` vuelve a consultar en DB el vídeo,
   propietario, organización, estado `PROCESSING` y organización sin tombstone;
   compara la fuente vigente. No consulta permisos de un espectador.
3. `lib/media-client.ts::extractAudioViaMediaServer` revalida antes de cada intento
   de red y firma una capacidad nueva. El request no lleva el secret legacy y
   rechaza redirects para no reenviar capacidades a otro destino.
4. `media-server/src/routes/audio.ts` comprueba la capacidad antes de consultar,
   extraer o transmitir audio. Si el header está presente y es inválido, no
   recurre al secret legacy aunque también se haya enviado. Otra operación no
   acepta esta credencial. Ausencia del header conserva la autenticación antigua.
5. Respuestas retryables conservan backoff, cancelan el cuerpo descartado y
   provocan revalidación/emisión fresca. Si la autoridad ya no permite renovar,
   se falla antes de otra petición. Un 401 no provoca retry o downgrade legacy.

La revalidación actual usa el estado ya existente de la transcripción. `jobId`
y `attemptId` son bindings criptográficos/correlación, **no una lease durable**.
No distinguen dos ejecuciones concurrentes con la misma fuente y estado ni
invalidan anticipadamente un token ya emitido. Si un trabajo vuelve a PROCESSING,
se necesita el futuro registro de intentos para distinguir una ejecución vieja.
Un receptor aislado no vuelve a consultar MySQL: confía en la capacidad admitida
hasta su expiración. Ninguna de estas limitaciones se presenta como resuelta.

La membresía de un espectador no decide el trabajo interno. Cancelar la
transcripción, eliminar el vídeo, cambiar propietario/organización/fuente o
tombstonear la organización impide nuevas emisiones cuando la consulta ya
refleja el cambio. Existe carrera entre consulta, firma y admisión y no se cancela
una extracción ya abierta. Los segmentos, backfill del transcript editable,
probe/check, mux y generación de thumbnails conservan sus rutas anteriores;
no se ha extendido la migración a todos los workers sin revisión del primer caso.

## Configuración y compatibilidad

La vía nueva requiere `MEDIA_INTERNAL_CAPABILITY_SECRET` en el proceso web y en
el media server. Usar un valor aleatorio seguro de al menos 32 bytes, diferente
de `NEXTAUTH_SECRET` y `MEDIA_SERVER_WEBHOOK_SECRET`, guardado en configuración
segura, nunca en chat o Git. Se declaró opcional en `packages/env/server.ts`.

No se introducen valores reales ni se activa esa configuración durante la tarea.
Sin clave, el cliente conserva su autenticación anterior. Otros consumidores sin
contexto de trabajo también conservan legacy. Con emisión nueva configurada pero
receptor sin clave o con clave distinta, se deniega; no hay fallback automático.
La clave webhook sigue siendo necesaria para probes/callbacks y consumidores no
migrados. El header nuevo no autoriza endpoints de visualización o administración.

Los módulos compartidos se ubican bajo `apps/media-server/src/lib` para que el
Dockerfile independiente los incluya con su COPY existente; web los importa
directamente. No se añade un paquete ni cambia la instalación. No se construyó
ni publicó una imagen, y no se verificó el despliegue de ambos extremos.

## Pruebas y comprobaciones

Resultados finales distintos, sin sumar repeticiones:

- Web: **195 aprobadas en 10 archivos**. Contratos, firmas, separación viewer,
  bindings, TTL, emisión/renovación, fallos, cancelación antes de retry y regresión
  de clientes, upload/reupload, espectadores y lógica de transcripción.
- Media server, nueva ruta con capacidad: **16 aprobadas en un archivo**.
  Hono in-process sin socket: éxito con audio simulado, body/header inválidos,
  objeto/attempt/job cambiado, expiración, clave ausente, no downgrade, compatibilidad
  legacy, rechazo en otra operación, error de decoder y ausencia de audio.
- Media server, batería legacy de audio en proceso separado: **14 aprobadas**.
- Total: **225 pruebas aprobadas**, sin fallos ni omisiones en esas selecciones.
- Typecheck completo de raíz (`next typegen` y `tsc-rs -b`): aprobado.
- Typecheck independiente del media server: **no aprobado**, siete errores
  preexistentes. Se reprodujeron exactamente sobre una copia de fuentes de HEAD
  del incremento 2 fuera del checkout, con los mismos módulos instalados y sin
  otro worktree. Afectan `drive-resumable-upload.test.ts` (tres),
  `media-routes-real-world.integration.test.ts`, `media-size.test.ts` y
  `capcodec-encoder.ts` (dos). No aparecen diagnósticos nuevos en este incremento.
  No se corrigen archivos ajenos al alcance para ocultar ese límite.
- Biome sobre TS modificado, Prettier sobre documentación y Git diff comprobado.

Comandos reproducibles con Bun 1.4.4 en PATH, desde la raíz:

```bash
bun run --cwd apps/web test __tests__/unit/media-extraction-capability.test.ts __tests__/unit/transcription-media-authorization.test.ts __tests__/unit/media-client.test.ts __tests__/unit/media-capability-contract.test.ts __tests__/unit/media-capability.test.ts __tests__/unit/desktop-reupload-token.test.ts __tests__/unit/comment-media-token.test.ts __tests__/unit/private-resource-authorization.test.ts __tests__/unit/live-transcribe-core.test.ts __tests__/unit/queue-video-transcription.test.ts
bun test --cwd apps/media-server src/__tests__/routes/audio-capability.test.ts
bun test --cwd apps/media-server src/__tests__/routes/audio.test.ts
bun run typecheck
bun run tsc-rs -p apps/media-server/tsconfig.json
```

Mocks/fixtures sustituyen storage, DB, HTTP y extracción; no se invocan FFmpeg
real, MySQL/S3, endpoints de IA, Docker ni servidores compartidos. La prueba SQL
comprueba los predicados del emisor, no transacciones contra MySQL real.

## Punto de parada y revisión

Completados únicamente los incrementos 1–3 como código y pruebas. Falta activar
y validar la configuración en un entorno autorizado. No hay registro revocable
de jobs ni eliminación del secret legacy global; quedan para incrementos
posteriores y su autorización. No se promete revocación de URLs antiguas ni
protección adicional del espectador: sus endpoints y tokens no han cambiado.

No continuar con el incremento 4 ni el proxy de reproducción antes de la revisión
del usuario. El PR #1 permanece sin fusionar; no se solicita ni ejecuta cambio
de Draft a Ready. `main` y la migración pendiente permanecen intactos.
