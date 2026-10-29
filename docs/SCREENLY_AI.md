# Screenly — inteligencia artificial

No se descargaron modelos, ejecutaron inferencias ni consumieron APIs de pago.
Esta evaluación separa integración existente, pruebas de lógica y propuestas.

## Implementación actual

| Función                     | Archivos y funciones                                                                                         | Estado                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Transcripción local         | `apps/desktop-gpui/src/transcription.rs::transcribe_blocking`, `process_with_whisper`, `get_whisper_context` | Whisper `whisper-rs` 0.11.0 existente; inferencia no probada         |
| Otros modelos locales       | `supports_parakeet`, `is_parakeet_model`, `download_parakeet_model`                                          | Parakeet y selección por idioma/plataforma; no validado              |
| Captions editables locales  | `derive_caption_track_segments`, `map_edited_time_to_source`, `apply_caption_result`                         | Código existente; cambios temporales requieren preservar fuente      |
| Transcripción web           | `lib/transcribe.ts::transcribeVideo`, `workflows/transcribe.ts::transcribeVideoWorkflow`                     | AssemblyAI; exige `ASSEMBLY_API_KEY`                                 |
| STT en curso                | `workflows/live-transcribe.ts`, `lib/live-transcribe-core.ts`                                                | Chunks AssemblyAI, promoción a canónico y fallback; lógica probada   |
| Texto canónico              | `workflows/transcribe.ts::saveTranscription`, `lib/edit-transcript-storage.ts`                               | VTT y transcript de palabras cifrado para edición                    |
| Títulos/resúmenes/capítulos | `workflows/generate-ai.ts::generateAiWorkflow`, `generateWithAi`, `saveResults`                              | Troceado, JSON y límites temporales; sin modelo ejecutado            |
| Búsqueda                    | `app/s/[videoId]/edit/TranscriptSidebar.tsx`                                                                 | Búsqueda dentro del transcript; 3 pruebas UI aprobadas               |
| SRT                         | `apps/desktop/src-tauri/src/captions.rs::export_captions_srt`                                                | Existe en cliente histórico; export uniforme GPUI/web no establecido |
| VTT                         | `transcription.vtt`, `lib/transcript-vtt.ts` y workflows                                                     | Consumido por web; 4 pruebas de normalización/actualización          |

No basta configurar un endpoint Whisper: el workflow web importa AssemblyAI,
usa sus estados y palabras y falla sin su clave. `ASSEMBLY_BASE_URL` cambia la
base del SDK, pero no adapta automáticamente otro protocolo de transcripción.

## Proveedores LLM existentes

`apps/web/lib/ai/provider.ts::{getConfiguredAiProviders,getAiProviderChain}`
admite Groq, OpenAI, Anthropic, gateway LLM AssemblyAI y `openai-compatible`.
`run.ts` ejecuta fallback y tratamiento de errores por rol (generación/chat).
Variables declaradas en `packages/env/server.ts`: `AI_PROVIDER`, `AI_BASE_URL`,
`AI_MODEL`, `AI_CHAT_MODEL`, `AI_STREAM_MODEL`, `AI_API_KEY` y claves de cada
proveedor. Son nombres de configuración; no se incluyen valores secretos.

La autodetección puede elegir proveedores externos presentes. Para garantizar
coste de API cero y privacidad, seleccionar explícitamente el proveedor local y
evitar credenciales/fallback externos; añadir después un modo estricto que
impida egress fuera del servicio autorizado. Configurar un proveedor compatible
no demuestra soporte real de JSON, streaming o herramientas de todos los modelos.

`generate-ai.ts` contiene `shouldReplaceVideoTitle`, `getAiLanguageInstruction`,
`clampChapters` y parseadores. Reutilizar conservación de títulos manuales,
idioma, timestamps y validación. No presentar un resumen plausible como garantía
de fidelidad: incorporar fixtures de alucinación y calidad en español.

## Whisper local: qué aprovechar

La ruta GPUI descarga modelos small/medium desde releases de
`CapSoftware/transcription-models`, cachea contextos y trabaja con timestamps de
palabras. `crates/utils` contiene soporte de captions locales y checks CPU.
También existe Parakeet; sus idiomas y plataforma se seleccionan en el módulo.
No es necesario desarrollar de cero captions nativos.

El descargador Whisper `write_whisper_parts` usa HTTPS y contabiliza bytes para progreso;
no se identificó verificación final de tamaño ni hash criptográfico fijado en esa
función. Elimina el archivo parcial si recibe un error. Añadir catálogo de
hashes confiables y descarga atómica como mejora de cadena de suministro,
sin desactivar verificaciones existentes. Comprobar licencias de cada modelo.

La generación de captions locales no demuestra subida del transcript canónico
ni resumen automático en la biblioteca web. Ese enlace debe especificarse y
probarse para evitar una segunda transcripción y inconsistencias tras editar.

## Propuesta sin APIs de pago

1. Extraer un contrato STT de servidor con audio de entrada, idioma, palabras
   `{text,startMs,endMs,confidence}` opcionalmente speaker y versión de motor.
   Conservar estados actuales, reintentos, cancelación y persistencia duradera.
2. Implementar un worker autoalojado con whisper.cpp o faster-whisper. Evaluar
   CPU cuantizada y GPU, idiomas y recursos en una fase autorizada posterior.
   Mapear sus resultados al transcript editable y VTT existentes; no sustituir
   timestamps de fuente por los de la timeline editada.
3. Usar el adaptador LLM compatible existente con un servidor local, por ejemplo
   Ollama/llama.cpp/vLLM según hardware. Evaluar un modelo instruct con soporte
   de español y licencia aceptable. No afirmar que todos son libres de
   restricciones o que el hardware es gratuito.
4. Producir título, resumen y capítulos desde el transcript; validar esquema,
   idioma, duración y referencias. Rechazar salida inválida conservando el vídeo.
5. Derivar VTT y SRT de una representación temporal común. Añadir exportación
   GPUI/web y política de autorización para ambos formatos.
6. Búsqueda inicial por texto con control de acceso y timestamps; añadir índice
   global por organización posteriormente. Embeddings/RAG son opcionales.

Cada trabajo debe ser idempotente por vídeo, versión de medio, modelo e idioma.
Aplicar límites de duración, concurrencia, disco y memoria; borrar temporales y
respetar eliminación del vídeo. Tratar transcript como datos no confiables ante
prompt injection; no permitir ejecución de herramientas por su contenido.

## Pruebas y aceptación futura

Ahora: `ai-provider` 31, `ai-run` 6, `summary-chapters` 4, `live-transcribe-core`
17, `transcript-vtt` 4, `edit-transcript` 25 y sidebar 3 aprobadas (incluidas en
las 278 web). Prueban selección, fallback, estructura y tiempos, no precisión STT.

Después: corpus consentido español/inglés con silencios, ruido, distintos
acentos y pausas; medir WER/CER, drift, latencia, RAM/VRAM y tiempo por minuto.
Verificar edición, reintentos y borrado sin llamadas externas; autorizar por igual
audio, transcript, resúmenes e índice. La elección final de modelo depende de
esas mediciones y del hardware disponible, aún no inspeccionado en el VPS.
