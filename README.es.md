# AgentOS

Idiomas: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS es un runtime local-first para agentes personales que operan navegadores y aplicaciones de escritorio en nombre del usuario. No es un sistema operativo bare-metal. Es una capa de agente que corre sobre macOS o Windows y mantiene tareas, workspaces, traces, aprendizaje y watch rules dentro de un solo runtime local.

## Qué hace AgentOS

- Ejecuta un daemon local y una CLI para tareas, watch rules, takeover y diagnóstico
- Opera superficies de navegador y escritorio con un `WorldState` compartido
- Convierte objetivos en lenguaje natural en acciones de UI ejecutables
- Guarda traces, artifacts, workspaces, skills, watch profiles y credenciales de forma local
- Aprende de resultados de tareas, detecciones de watch, correcciones manuales y archivos locales seleccionados
- Genera propuestas de tareas a partir de lo aprendido, sin ejecutarlas automáticamente por defecto

## Capacidades actuales

- Control plane local HTTP + WebSocket
- CLI `agentos` para daemon, tareas, drafts, watch rules, búsqueda en memoria y propuestas
- Cadena de ejecución con `Sentinel`, `Planner`, `Operator`, `Verifier` y `Recovery`
- Workspace de navegador administrado con Playwright
- Runtime nativo de escritorio mediante Rust sidecar
- Acciones target-based como `clickTarget`, `typeIntoTarget`, `waitForTarget` y `extractFromTarget`
- Workspace profiles persistentes, watch rules y flujo de drafts con aprobación
- Learning loop local con observations, entities, knowledge chunks, daily digests y proposals
- Persistencia local sobre SQLite

## Estructura del repositorio

- `src/`: runtime, server, adapters, services y schemas
- `bin/`: entrada CLI y subcomandos
- `rust/agentos-native/`: Rust native sidecar
- `public/`: consola local opcional para debug
- `test/`: pruebas de integración y runtime
- `.agentos/`: base de datos local, logs, workspaces, artifacts y estado del daemon

## Inicio rápido

Instala dependencias, construye el runtime TypeScript y arranca el daemon:

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

Verifica el estado:

```bash
node dist/bin/agentos.js daemon status --json
node dist/bin/agentos.js doctor --json
node dist/bin/agentos.js version --json
```

Por defecto escucha en `http://127.0.0.1:3017`. La consola web sigue disponible para trace y debug, pero la entrada principal es la CLI.

## Requisitos de build

Comprobación de tipos:

```bash
npm run typecheck
```

Build a `dist/`:

```bash
npm run build:ts
```

Build del sidecar Rust:

```bash
npm run native:build
```

Notas:

- Para compilar el sidecar Rust necesitas `cargo`
- `dist/` es salida generada y no debe ir a git
- Si falla la detección del navegador, usa `AGENTOS_BROWSER_EXECUTABLE`
- Si quieres ver el navegador en ejecución, usa `AGENTOS_HEADLESS=false`

## Modelo principal del runtime

AgentOS gira en torno a estos objetos:

- `Task`: unidad de trabajo puntual
- `Workspace`: estado persistente de navegador o aplicación
- `Watch rule`: regla permanente que detecta novedades y crea tareas o drafts
- `Draft`: acción pendiente de aprobación
- `Skill`: workflow reutilizable aprendido
- `Learning source`: entrada de aprendizaje, por ejemplo archivos, eventos de watch, resultados de tareas o correcciones manuales
- `Proposal`: tarea sugerida por la capa de aprendizaje

## Flujos CLI comunes

### 1. Ejecutar una tarea de navegador

```bash
node dist/bin/agentos.js run \
  "Abrir example.com, hacer clic en More information y capturar una pantalla" \
  --surface browser \
  --wait
```

### 2. Ejecutar una tarea de escritorio

```bash
node dist/bin/agentos.js run \
  "Abrir TextEdit, escribir una nota corta y esperar" \
  --surface desktop
```

### 3. Ver tareas y traces

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

### 4. Pausar o tomar control de una tarea

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "Ya corregí el foco de la ventana"
node dist/bin/agentos.js control <task-id> stop
```

### 5. Crear una watch rule permanente

```bash
node dist/bin/agentos.js watch add \
  "Vigila Slack y responde hilos no leídos de bajo riesgo con mi estilo" \
  --surface browser \
  --workspace personal-main
```

Inspeccionar salud de la regla:

```bash
node dist/bin/agentos.js watch ls
node dist/bin/agentos.js watch inspect <watch-id>
node dist/bin/agentos.js watch health <watch-id>
node dist/bin/agentos.js watch retry <watch-id>
```

### 6. Revisar o aprobar drafts

```bash
node dist/bin/agentos.js drafts ls
node dist/bin/agentos.js drafts inspect <draft-id>
node dist/bin/agentos.js drafts approve <draft-id>
node dist/bin/agentos.js drafts reject <draft-id> --reason "Necesita respuesta humana"
```

### 7. Enseñar una tarea completada como watch profile

```bash
node dist/bin/agentos.js watch teach \
  <task-id> \
  "Sigue vigilando este buzón y procesa mensajes similares de la misma manera" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. Consultar aprendizaje y propuestas

```bash
node dist/bin/agentos.js learn status
node dist/bin/agentos.js learn sources ls
node dist/bin/agentos.js memory search "renovación"
node dist/bin/agentos.js digest run
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## Learning loop

AgentOS ya incluye una capa de aprendizaje continuo local.

Comportamiento por defecto:

- escanea metadata de archivos en un rango amplio del entorno del usuario
- lee contenido de forma selectiva en directorios gestionados y archivos de texto relevantes
- aprende de detecciones de watch, resultados de tareas y correcciones manuales
- guarda memoria estructurada y conocimiento buscable de forma local
- crea proposals silenciosas, sin ejecutar acciones automáticamente por defecto

Tipos de fuentes de aprendizaje:

- `filesystem-metadata`
- `filesystem-content`
- `watch-events`
- `task-results`
- `user-corrections`

Uso típico:

```bash
node dist/bin/agentos.js memory search "pricing"
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## Ejemplos JSON

### Ejemplo: tarea target-based en navegador

```json
{
  "goal": "Completar el formulario y capturar el resultado",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "steps": [
    {
      "label": "Abrir la página",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "Escribir el correo",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": {
        "targetQuery": "email",
        "text": "tan@example.com",
        "clear": true
      }
    },
    {
      "label": "Enviar el formulario",
      "surface": "browser",
      "action": "clickTarget",
      "params": { "targetQuery": "submit" }
    },
    {
      "label": "Capturar el estado final",
      "surface": "browser",
      "action": "capture",
      "params": { "label": "done" }
    }
  ]
}
```

### Ejemplo: tarea de escritorio

```json
{
  "goal": "Abrir TextEdit y escribir una nota",
  "preferredSurface": "desktop",
  "inputs": {
    "desktopApp": "TextEdit",
    "typeText": "Nota diaria escrita por AgentOS"
  },
  "steps": [
    {
      "label": "Abrir TextEdit",
      "surface": "desktop",
      "action": "openApp",
      "params": { "name": "TextEdit" }
    },
    {
      "label": "Esperar al editor",
      "surface": "desktop",
      "action": "waitForText",
      "params": { "text": "TextEdit", "timeoutMs": 5000 }
    },
    {
      "label": "Escribir la nota",
      "surface": "desktop",
      "action": "type",
      "params": { "text": "Nota diaria escrita por AgentOS" }
    }
  ]
}
```

### Ejemplo: payload de watch rule

```json
{
  "goal": "Vigila Slack y responde hilos no leídos de bajo riesgo con mi estilo",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "livePack": "slack-browser",
  "pollIntervalMs": 15000
}
```

### Ejemplo: payload de control de tarea

```json
{
  "action": "request_takeover"
}
```

Acciones de control soportadas:

- `pause`
- `resume`
- `request_takeover`
- `return_to_agent`
- `stop`

## Notas de runtime

- Todo el estado local vive en `.agentos/`
- El estado del daemon vive en `.agentos/daemon/`
- La automatización del navegador requiere un ejecutable compatible con Chrome
- El navegador se ejecuta en modo headless por defecto
- En macOS puede ser necesario conceder permisos de Accessibility y Screen Recording
- En Windows la automatización de escritorio usa PowerShell / Win32 a través del sidecar
- Live packs integrados actualmente:
  - `slack-browser`
  - `slack-desktop`
  - `wechat-desktop`
  - `generic-mail-desktop`
  - `generic-desktop`
- Los datos de aprendizaje, digests y proposals permanecen de forma local

## Resumen de API

Sistema:

- `GET /health`
- `GET /doctor`
- `POST /doctor/bundle`
- `GET /version`
- `GET /daemon/status`

Tareas:

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/control`
- `POST /tasks/:id/teach-steps`
- `GET /traces/:id`
- `POST /events`
- `GET /events`
- `POST /policy/evaluate`

Watch y drafts:

- `GET /packs`
- `GET /watches`
- `POST /watches`
- `POST /watches/from-task`
- `GET /watches/:id`
- `GET /watches/:id/health`
- `POST /watches/:id/enable`
- `POST /watches/:id/disable`
- `POST /watches/:id/retry`
- `DELETE /watches/:id`
- `GET /drafts`
- `GET /drafts/:id`
- `POST /drafts/:id/approve`
- `POST /drafts/:id/reject`

Skills, workspace y vault:

- `GET /skills`
- `POST /skills/from-task`
- `GET /skills/:name`
- `PUT /skills/:name`
- `GET /workspace-profiles`
- `PUT /workspace-profiles/:name`
- `GET /vault/secrets`
- `PUT /vault/secrets/:key`
- `GET /vault/secrets/:key`

Learning:

- `GET /learning/status`
- `GET /learning/sources`
- `GET /memory/search`
- `GET /memory/entities/:id`
- `GET /digests`
- `POST /digests/run`
- `GET /proposals`
- `POST /proposals/:id/accept`
- `POST /proposals/:id/reject`

## Desarrollo y releases

Ejecutar toda la suite:

```bash
npm test
```

Reiniciar el daemon tras un build local:

```bash
node dist/bin/agentos.js daemon restart
```

Preparar artifacts de release:

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

## Licencia

MIT. Consulta [LICENSE](./LICENSE).
