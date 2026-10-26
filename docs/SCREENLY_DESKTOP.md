# Screenly — escritorio Windows

Evidencia y fecha: ver `SCREENLY_ARCHITECTURE.md`. **C** indica código inspeccionado;
ninguna captura, ventana GPUI o compilación Windows se ejecutó en este entorno.

## Cliente vigente

`apps/desktop-gpui` es un workspace Rust independiente con binario `cap-gpui`.
`Cargo.toml` depende de GPUI, `gpui_platform` y `gpui_tokio` del fork Zed fijado a
una revisión. La UI se renderiza nativamente; no es una webview Tauri.

`scripts/bundle-gpui.mjs` y `.github/workflows/desktop-release.yml` empaquetan el
binario como Cap/Cap.exe. `tauri.conf.json` sirve al bundler y updater; su presencia
no convierte al cliente en una aplicación Tauri. La matriz incluye
`x86_64-pc-windows-msvc` en Windows 2022. Firma Windows y NSIS están definidos en
`scripts/windows-release-signing.ps1` y `packaging/windows/installer-hooks.nsh`.

Tauri histórico (`apps/desktop/src-tauri`, UI SolidStart) comparte crates,
formatos y ajustes; conservar bindings generados y compatibilidad de datos.
`scripts/dev-desktop.mjs` puede levantar ambos clientes durante desarrollo;
no se ejecutó por la prohibición de servidores de `AGENTS.md`.

## Captura y audio

| Función                 | Ruta concreta                                                                          | Evaluación                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Pantalla/ventana/región | `crates/recording/src/sources/screen_capture/mod.rs::ScreenCaptureTarget`              | C: `Display`, `Window`, `Area`, `CameraOnly`                                                   |
| Windows                 | `screen_capture/windows.rs::to_sources`, `crates/scap-direct3d/src/lib.rs::Capturer`   | C: Windows.Graphics.Capture, Direct3D11 y texturas                                             |
| Compatibilidad          | `scap-direct3d::is_supported`, `NewCapturerError`                                      | Exige Windows 10 1903/build 18362+ en esta ruta; Windows 10 completo no puede prometerse       |
| Monitores               | `screen_capture::list_displays`, `scap-targets`                                        | Selección de distintos monitores; target único no demuestra captura simultánea de todos        |
| Webcam                  | `apps/desktop-gpui/src/recording.rs::setup_camera`, `crates/camera*`                   | Cámara separada y preview; validar dispositivos, resoluciones y hotplug                        |
| Cámara flotante         | `apps/desktop-gpui/src/camera_window.rs`, `crates/recording/src/camera_placement.rs`   | UI y colocación implementadas; exclusión y composición Windows N                               |
| Micrófono               | `recording.rs::setup_microphone`, `crates/recording/src/sources/microphone.rs`         | CPAL y tratamiento de dispositivos                                                             |
| Sistema                 | `crates/scap-cpal/src/lib.rs`                                                          | Loopback WASAPI con keepalive de silencio; probar silencio, Bluetooth y cambios de dispositivo |
| Pausa/reanudación       | `ActiveRecording::pause_handle`, `resume_handle`; `instant_recording.rs::pause/resume` | Métodos presentes; sincronización real tras pausas N                                           |
| Inicio/finalización     | `recording.rs::start`, `finalize_studio`                                               | Instant y Studio tienen ciclos y persistencia distintos                                        |

No interpretar selección de pantalla como soporte de escritorio virtual completo.
Validar cambios de DPI, monitor principal, HDR, minimización, permisos, contenido
protegido y conexión/desconexión de pantallas. Hardware y drivers son parte de la
matriz de aceptación.

## Formatos y rendimiento

`crates/recording/src/capture_pipeline.rs` selecciona Direct3D en Windows y
codificación H.264 con rutas Media Foundation/FFmpeg. `crates/enc-mediafoundation`,
`enc-ffmpeg`, `cap-muxer` y `mediafoundation-ffmpeg` contienen la infraestructura;
audio AAC y salidas MP4/fMP4 aparecen en los pipelines. Studio conserva pistas y
metadatos de proyecto para edición; Instant prioriza envío progresivo y segmentos.

`crates/rendering` y `rendering-skia` componen frames y efectos;
`apps/desktop-gpui/kernels` separa bucles de píxeles del código UI.
La ruta `crates/render-farm` acelera exportación remota con GPU, no es un requisito
de grabación local. No se midieron CPU, GPU, memoria, FPS, latencia ni drift;
las cifras históricas del README no son resultados de esta auditoría.

## Editor y publicación

- `apps/desktop-gpui/src/editor_window.rs` carga `cap_editor::EditorInstance`,
  transporta frames, playback y timeline. `preflight` trata proyectos ilegibles.
- `editor_edits.rs` y `project_save.rs::PendingProjectSave` gestionan edición,
  undo y persistencia. `crates/project/src/configuration.rs` modela cámara,
  cursor, audio, zoom, captions y timeline; `crates/project/src/cursor.rs`
  conserva eventos. Los efectos requieren que la captura haya registrado datos.
- `editor_export.rs::start_export` → `crates/export/src/mp4.rs` implementa MP4;
  existen módulos GIF y MOV. No se verificó decodificación del archivo final.
- `upload.rs::upload_exported_video` y `prepare_instant_upload` unen exportación
  local y biblioteca remota. El backend decide la publicación; no borrar el
  original local antes de confirmar persistencia remota.
- `library.rs::list_recordings`, `known_recordings_dirs` y `list_screenshots`
  leen el disco. `find_incomplete_recordings` y `recover_incomplete_recording`
  conectan con `crates/recording/src/recovery.rs::{inspect_recording,recover}`.
  Hay remux y validación para proyectos fragmentados; no garantiza recuperar
  bytes nunca escritos o medios dañados.

Los comentarios iniciales de `editor_window.rs` describen hitos antiguos y
controles entonces deshabilitados. El archivo actual contiene más controles;
no inferir estado de una funcionalidad solo desde esos comentarios.

## IA local y distribución propia

`transcription.rs::transcribe_blocking` usa Whisper/Parakeet; ver `SCREENLY_AI.md`.
La biblioteca de proyectos y sus subtítulos locales no se sincronizan por sí
solos con la transcripción canónica del backend.

Antes de distribuir Screenly, revisar `apps/desktop-gpui/tauri.conf.json`:
identidad `so.cap.desktop`, endpoint de actualizaciones CrabNebula de Cap y claves
de verificación pertenecen al producto original. Screenly necesita identidad,
canal de actualización y firmas propios, sin reutilizar credenciales upstream.
`src/updates.rs`/`installer.rs` verifican actualizaciones con minisign; conservar
esa verificación. Auditar también URLs de sesión, telemetría y descargas.

## Qué falta verificar

Preparar, con aprobación posterior, una máquina Windows 10 compatible y otra 11:
instalación/actualización, pantalla/ventana/región, monitor alternativo, webcam,
micrófono+loopback, pausa prolongada, suspensión, cierre forzado, recuperación,
exportación y publicación privada. Medir A/V sync, consumo y FPS en sesiones
largas con Intel/AMD/NVIDIA. Rust, FFmpeg nativo y toolchain GPUI necesitan una
compilación real antes de declarar listo este cliente. Las pruebas TS de esta
fase no validan estas capacidades nativas.
