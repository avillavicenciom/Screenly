# Screenly: entorno de desarrollo, fase 0

Este flujo prepara la revisión de arquitectura y las pruebas de TypeScript en el
checkout existente de `/workspace/Screenly`, en `feature/screenly-phase-0`.
Leer `AGENTS.md` y las instrucciones aplicables antes de trabajar. No crear otro
worktree, reiniciar servicios ni ejecutar servidores de desarrollo o Docker.

## Requisitos y archivos reproducibles

- Node.js 24; versión verificada: **24.19.0**. `apps/web` requiere Node 24.x.
- Bun **1.4.4**, fijado en `package.json` e instalado por el script de esta guía.
- Rust **1.88.0**, fijado en `rust-toolchain.toml` para el workspace principal.
  `apps/desktop-gpui/rust-toolchain.toml` selecciona `stable`; sus dependencias
  requieren al menos 1.89. Rust no se instaló ni validó en esta fase.
- Acceso HTTPS a npm y a los destinos de descarga de dependencias. Se conserva
  la verificación TLS y de integridad; no se necesitan credenciales privadas para
  las pruebas seleccionadas.

Los manifiestos `package.json` y `bun.lock` conservan las versiones resueltas del
workspace JavaScript. Los archivos `Cargo.toml`, `Cargo.lock` y los toolchains
existentes describen el entorno Rust. No modificar manifiestos, lockfiles ni
archivos generados como parte de esta preparación.

`scripts/cloud-environment-setup.sh` reproduce la instalación y las comprobaciones
de compilación y tipos. Instala Bun fuera del checkout, en `/workspace/.tools`,
y mantiene las cachés en `/workspace/.cache`. Necesita Node preinstalado.

```bash
cd /workspace/Screenly
bash scripts/cloud-environment-setup.sh
export PATH=/workspace/.tools/node_modules/.bin:$PATH
export BUN_INSTALL_CACHE_DIR=/workspace/.cache/bun
```

El borrador de configuración del entorno contiene `install_script` y `start_skill`.
Son configuración de la plataforma, no archivos Git. Guardar un borrador no lo
ejecuta ni publica una imagen. La publicación del entorno se realiza por separado
desde la configuración de la plataforma; los procesos no deben darse por
restaurados en futuras tareas.

## Validación realizada

Ejecutar desde el checkout existente, después de activar el PATH anterior:

```bash
cd /workspace/Screenly/packages/recorder-core
bun run test
bun run typecheck
cd /workspace/Screenly/apps/web
bun run test __tests__/unit/transcript-vtt.test.ts __tests__/unit/timeline-window.test.ts __tests__/unit/canonical-urls.test.ts
cd /workspace/Screenly/packages/web-domain
bun run build
```

Resultados del 26 de octubre de 2026:

- `recorder-core`: 7 archivos, **84 pruebas aprobadas**.
- Selección web: 3 archivos, **51 pruebas aprobadas**.
- Comprobación de tipos de `recorder-core`: correcta.
- Compilación de `web-domain`: correcta.
- Repetición de `bun install --frozen-lockfile`: correcta, sin cambios.

Las pruebas de recuperación y fallos de captura simulados pueden escribir errores
esperados en stderr; el resultado del runner determina si aprobaron.

## Alcance y seguridad

No se necesitan archivos `.env`, claves API, tokens ni contraseñas para este flujo.
No incluir secretos, cachés, `node_modules`, salidas de compilación ni perfiles
locales en commits. Los archivos privados deben permanecer fuera del control de
versiones; esta guía y el script no contienen valores de credenciales.

No se han validado el servidor Next.js completo, MySQL, MinIO, el servidor de
medios, las compilaciones nativas ni la captura real. Docker y la configuración
privada de servicios corresponden a ese flujo posterior. No se han iniciado
servicios, aplicado migraciones, modificado funcionalidades ni accedido al VPS.
Los comandos interactivos `env-setup` y `cap-setup` no son necesarios para estas
pruebas y no se ejecutan en esta fase.
