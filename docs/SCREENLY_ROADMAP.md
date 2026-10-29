# Screenly — decisiones y plan de desarrollo

La fase 0 cambia únicamente documentación. No iniciar fase 1 hasta aprobación
del usuario. La estimación de esfuerzo depende de compilar y medir Windows;
no se prometen fechas ni rendimiento sin esa evidencia.

## Decisiones recomendadas

1. Mantener GPUI/Rust como cliente nativo. No reiniciar una implementación Tauri
   completa sin una causa técnica demostrada.
2. Mantener Next.js, backend Effect, MySQL y S3 como biblioteca compartida;
   reutilizar el grabador web y sus paquetes de captura/recuperación.
3. Privacidad por defecto y autorización uniforme en objetos y derivados.
4. Reutilizar Whisper nativo y añadir STT de servidor autoalojado; utilizar el
   adaptador LLM compatible existente con política sin proveedores de pago.
5. Conservar fuentes originales y edición no destructiva. Mantener idempotencia,
   integridad y recuperación antes de optimizar rendimiento o añadir integraciones.

## Problemas técnicos y orden de resolución

| Problema                                   | Impacto                                            | Tratamiento                                                                  |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Defaults públicos heredados                | Incompatible con biblioteca privada                | Primer cambio funcional acotado con pruebas de creación y autorización       |
| Avisos en dependencias                     | Riesgo antes de exposición                         | Triage por versión/alcanzabilidad y actualización separada                   |
| Toolchain `stable` GPUI y dos workspaces   | Reproducción nativa variable                       | Fijar versión exacta validada, conservar locks, compilar Windows             |
| Identidad, updater y endpoints upstream    | Distribución Screenly incorrecta                   | Canal propio, firmas, revisión de URLs y telemetría                          |
| Entitlements Free/Pro heredados            | Disponibilidad distinta según cuenta/configuración | Definir política Screenly y probar cuotas sin contratar servicios            |
| Múltiples API y clientes históricos        | Autorización y mantenimiento dispersos             | Inventario por endpoint; conservar compatibilidad mientras se reduce alcance |
| AssemblyAI acoplado a STT web              | No satisface IA autoalojada                        | Contrato de transcripción y adaptador local                                  |
| Captions locales y canónicos distintos     | Duplicación e inconsistencias de tiempo            | Import/export común y versión de medio/transcript                            |
| SRT solo identificado en Tauri histórico   | Paridad incompleta                                 | Exportadores desde representación temporal compartida                        |
| Multimonitor y rendimiento no certificados | Expectativas Windows inciertas                     | Matriz de hardware, DPI, audio y carga; no afirmar captura simultánea        |
| AGPL y modelos                             | Condiciona distribución privada/comercial          | Decisión legal y SBOM antes de distribución                                  |

## Fases y criterios de salida

| Fase                            | Entregables                                                                                             | Aceptación                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0 — Auditoría                   | Estos seis documentos, pruebas específicas y riesgos                                                    | 426 casos aprobados; límites y tareas pendientes explícitos                                                                |
| 1 — Base privada y reproducible | Defaults privados en todos los creadores, pruebas de política, triage de dependencias, baseline Windows | Nuevos vídeos no públicos sin elección explícita; sin acceso anónimo a contenido/derivados; compilación Windows registrada |
| 2 — MVP Windows/web             | Captura pantalla/ventana/monitor, webcam, micrófono+sistema, pausa, recuperación, subida y biblioteca   | Windows 10 compatible/11 y Chrome/Edge completan flujo privado; original preservado ante cortes                            |
| 3 — IA autoalojada              | Worker STT, VTT/SRT, títulos/resúmenes/capítulos con modelo local                                       | Sin egress de pago; español/inglés medidos, reintentos y permisos probados                                                 |
| 4 — Edición y colaboración      | Trim/zoom/cursor/exportación, transcript remapeado, comentarios y búsqueda                              | MP4 decodificable y A/V sincronizado; búsquedas y enlaces respetan organización                                            |
| 5 — Distribución y operación    | Instalador/actualizador Screenly firmado, backups, retención, observabilidad, pruebas de carga          | Restauración probada, eliminación completa, avisos críticos tratados y obligaciones legales resueltas                      |

La validación Windows y la revisión de privacidad comienzan antes de añadir IA.
No introducir render farm GPU hasta justificarla con carga. La transcripción
autoalojada no exige construir un editor nuevo ni un motor de grabación nuevo.

## Primera tarea de implementación propuesta

**Vídeos privados por defecto, con creación centralizada y regresiones.**

Antes de editar, trazar todos los insert/update de `videos` (web recorder,
desktop Instant/Studio, importación, SDK, API de agentes y duplicación) y usos de
`getNewVideoPublic`. Mantener las reglas de organización y evitar que una omisión
recaiga en `videos.public = true`.

Entregable posterior: una decisión de visibilidad explícita reutilizada por los
creadores, configuración self-host segura y pruebas de acceso para propietario,
miembro, invitado y anónimo, incluidas miniaturas, VTT, MP4/HLS y metadatos.
Si requiere schema, seguir `db:generate` y flujo de migración del repo, sin
escribir SQL generado a mano. No cambiar retroactivamente vídeos públicos ni
aplicar migraciones al VPS sin una tarea y autorización específicas.

Criterio: vídeo nuevo privado salvo elección autorizada, propietario conserva
acceso, membresías/grants se mantienen, anónimo recibe denegación y los enlaces
existentes siguen la política definida. Esto es una recomendación; **no se ha
implementado en esta fase**.

## Puertas de validación posteriores

- Windows: build MSVC y GPUI fijado, instalación limpia/actualización firmada,
  monitor secundario y DPI mixto, AMD/Intel/NVIDIA, loopback y Bluetooth, sesión
  larga y recuperación de cierre forzado.
- Navegador: permisos reales, micrófono/sistema, superficie elegida, fallback,
  cuota IndexedDB y recuperación, cierre de pestaña y cancelación de uploads.
- Backend: MySQL/S3 aislados para E2E, autorización de todos los derivados,
  expiración/revocación de URLs, cola idempotente y eliminación de medios/IA.
- IA: calidad con corpus consentido, tiempos y recursos medidos; comprobar
  timestamps tras edición y ausencia de tráfico hacia proveedores de pago.
- Seguridad: SBOM JS/Rust/nativos/modelos, triage de advisories, permisos de
  credenciales y revisión legal AGPL antes de distribución.

## Estado de publicación y control de alcance

Los documentos pertenecen a `feature/screenly-phase-0`, destinada al PR #1 hacia
`main`. Mantenerlo en borrador y no fusionarlo. La API GitHub devolvió `Forbidden`
al intentar consultar su estado en esta auditoría: el estado Draft informado por
el usuario no pudo verificarse remotamente. El push de la rama no debe cambiar
ese estado. Publicar documentación no publica el entorno ni despliega producto.

Se respetan `AGENTS.md`: sin servidores, Docker, cambios de app, archivos
generados, manifiestos, lockfiles o migraciones. Rust/clippy y typecheck global
no son gates adecuados para cambios solo Markdown. Biome 2.2 no procesa estos
Markdown; se comprueban con Prettier y `git diff --check`.
