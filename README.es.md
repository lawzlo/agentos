# AgentOS

Idiomas: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS es un runtime local-first para agentes personales que operan navegadores y aplicaciones de escritorio en nombre del usuario. No es un sistema operativo bare-metal. Es una capa de agente que corre sobre macOS o Windows y mantiene tareas, workspaces, traces, aprendizaje y watch rules dentro de un solo runtime local.

## Despliegue recomendado

AgentOS es lo bastante potente como para operar navegadores, aplicaciones de escritorio, archivos locales y watch rules permanentes. Debe tratarse como un operador real, no como un script pequeño.

- Primer despliegue recomendado: una máquina dedicada, mini PC, VM o una cuenta separada del sistema operativo
- Evita conectarlo el primer día a tu perfil principal de navegador
- Empieza con apps de bajo riesgo y políticas de respuesta `draft-first` antes de ampliar la autonomía
- Mantén pagos, borrados, firmas y envíos de alto riesgo detrás de aprobación humana
- Ejecuta `doctor` antes de confiar en flujos always-on

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
- Por defecto `~/.agentos/`: base de datos local, logs, workspaces, artifacts y estado del daemon

## Inicio rápido

La mayoría de los usuarios deberían empezar con comandos CLI en lenguaje natural. No necesitas escribir JSON para empezar a usar AgentOS.

1. Instala dependencias, construye el runtime y expone el comando local `agentos`:

```bash
npm install
npm run cli:link
```

2. Ejecuta primero el chequeo de setup. Verifica daemon, navegador, configuración del modelo, sidecar nativo y packs disponibles:

```bash
agentos setup
```

3. Entra en la shell interactiva o ejecuta una primera tarea puntual:

```bash
agentos

agentos "Abrir example.com, hacer clic en More information y capturar una pantalla" --surface browser
```

4. Añade una primera watch rule permanente:

```bash
agentos watch add \
  "Vigila Slack y responde hilos no leídos de bajo riesgo con mi estilo" \
  --surface browser \
  --workspace personal-main
```

Por defecto escucha en `http://127.0.0.1:3017`. La consola web sigue disponible para trace y debug, pero la entrada principal es la CLI.

Si `agentos` todavía no está en tu PATH, ejecuta primero `npm run cli:link` desde el checkout fuente.

## Escenarios comunes para un agente personal

Estos son flujos reales para los que AgentOS está pensado. En condiciones normales el usuario no debería tener que escribir JSON a mano.

### 1. Investigación en navegador y resumen

```bash
agentos run \
  "Abrir el sitio objetivo, recopilar los puntos clave y guardar un resumen corto en el workspace" \
  --surface browser \
  --wait
```

### 2. Triaje de correo con drafts primero

```bash
agentos watch add \
  "Vigila mi correo, redacta respuestas para mensajes nuevos de clientes y deja las respuestas riesgosas para aprobación" \
  --surface browser \
  --workspace personal-main
```

### 3. Automatización de respuestas de bajo riesgo en Slack

```bash
agentos watch add \
  "Vigila Slack y responde hilos no leídos de bajo riesgo con mi estilo" \
  --surface browser \
  --workspace personal-main
```

### 4. Asistencia sobre WeChat desktop

```bash
agentos watch add \
  "Vigila WeChat desktop y redacta respuestas para mensajes no leídos de clientes" \
  --surface desktop \
  --workspace personal-main
```

### 5. Seguimiento de candidatos en BOSS

```bash
agentos watch add \
  "Vigila BOSS直聘, revisa candidatos nuevos y redacta seguimientos educados" \
  --surface browser \
  --workspace recruiting-main
```

### 6. Flujos con Google Drive y documentos

```bash
agentos run \
  "Abrir Google Drive, subir el archivo más reciente de Downloads y confirmar que la subida terminó" \
  --surface browser \
  --wait

agentos run \
  "Abrir Google Docs, actualizar el informe semanal y guardarlo" \
  --surface browser \
  --wait
```

### 7. Memoria diaria, digest y propuestas de seguimiento

```bash
agentos learn status
agentos memory search "pricing"
agentos digest run
agentos proposals ls
```

### 8. Enseñar un flujo repetido después de hacerlo una vez

```bash
agentos watch teach \
  <task-id> \
  "Sigue vigilando este buzón y procesa mensajes similares de la misma manera" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

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
agentos run \
  "Abrir example.com, hacer clic en More information y capturar una pantalla" \
  --surface browser \
  --wait
```

### 2. Ejecutar una tarea de escritorio

```bash
agentos run \
  "Abrir TextEdit, escribir una nota corta y esperar" \
  --surface desktop
```

### 3. Ver tareas y traces

```bash
agentos ps
agentos inspect <task-id>
agentos logs <task-id>
```

### 4. Pausar o tomar control de una tarea

```bash
agentos control <task-id> pause
agentos control <task-id> request_takeover
agentos control <task-id> return_to_agent --note "Ya corregí el foco de la ventana"
agentos control <task-id> stop
```

### 5. Crear una watch rule permanente

```bash
agentos watch add \
  "Vigila Slack y responde hilos no leídos de bajo riesgo con mi estilo" \
  --surface browser \
  --workspace personal-main
```

Inspeccionar salud de la regla:

```bash
agentos watch ls
agentos watch inspect <watch-id>
agentos watch health <watch-id>
agentos watch retry <watch-id>
```

### 6. Revisar o aprobar drafts

```bash
agentos drafts ls
agentos drafts inspect <draft-id>
agentos drafts approve <draft-id>
agentos drafts reject <draft-id> --reason "Necesita respuesta humana"
```

### 7. Enseñar una tarea completada como watch profile

```bash
agentos watch teach \
  <task-id> \
  "Sigue vigilando este buzón y procesa mensajes similares de la misma manera" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. Consultar aprendizaje y propuestas

```bash
agentos learn status
agentos learn sources ls
agentos memory search "renovación"
agentos digest run
agentos proposals ls
agentos proposals accept <proposal-id>
```

### 9. Reparar el setup o desinstalar la instalación local

```bash
agentos setup --fix --dry-run
agentos setup --fix
agentos uninstall --dry-run
agentos uninstall --purge
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
agentos memory search "pricing"
agentos proposals ls
agentos proposals accept <proposal-id>
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

- Por defecto, todo el estado local vive en `~/.agentos/`, salvo que definas `AGENTOS_DATA_DIR`
- Por defecto, el estado del daemon vive en `~/.agentos/daemon/`
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
agentos daemon restart
```

Preparar artifacts de release:

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

## Licencia

MIT. Consulta [LICENSE](./LICENSE).
