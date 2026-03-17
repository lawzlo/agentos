# AgentOS

Idiomas: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS es un control plane local-first para agentes autónomos que operan navegadores y aplicaciones de escritorio en nombre del usuario. No es un sistema operativo bare-metal; es una agent operating layer que corre sobre macOS o Windows y reúne task intake, workspaces, traces, artifacts, policy y watch rules persistentes en un runtime local.

## Qué está implementado

- Control plane local HTTP + WebSocket
- CLI `agentos` para daemon, tareas, takeover, watch rules y skills
- Pipeline multi-agent con `Sentinel`, `Planner`, `Operator`, `Verifier` y `Recovery`
- `WorldState` compartido para navegador y escritorio
- Grounding de objetivos en lenguaje natural hacia UI targets ejecutables
- Acciones target-based como `clickTarget`, `typeIntoTarget` y `waitForTarget`
- Workspace de navegador administrado con Playwright
- Abstracción de superficie de escritorio para macOS y Windows
- Rust sidecar para capacidades nativas
- Skill registry local, workspace profiles, watch rules y credential vault
- Teach recording, teach mode y watch teach
- Persistencia en SQLite

## Inicio rápido

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

El daemon escucha en `http://localhost:3017`. La consola web sigue disponible para trace/debug, pero la entrada principal es la CLI.

## TypeScript y Rust

- `TypeScript` es ahora la fuente principal del runtime en `src/`, `bin/`, `public/` y `test/`
- `Rust` cubre la parte native / runtime-heavy en [`rust/agentos-native`](./rust/agentos-native)
- La ruta nativa de macOS usa el Rust sidecar y un native bridge embebido
- El bridge de Windows cubre captura, descubrimiento de ventanas, input injection y OCR / text lookup

Comandos útiles:

```bash
npm run typecheck
npm run build:ts
npm run native:build
```

## Uso CLI

Iniciar o inspeccionar el daemon:

```bash
node dist/bin/agentos.js daemon start
node dist/bin/agentos.js daemon status
```

Ejecutar una tarea puntual:

```bash
node dist/bin/agentos.js run "打开 example.com，点击 More information，然后截图" --surface browser
```

Listar tareas o inspeccionar un trace:

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

Pausar o tomar control de una tarea:

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "I fixed the window focus"
```

Crear una watch rule permanente:

```bash
node dist/bin/agentos.js watch add "一直盯 Slack，有新消息就按我的风格回复" --skill slack-reply --workspace personal-main
node dist/bin/agentos.js watch ls
```

Enseñar una tarea completada como watch profile reutilizable:

```bash
node dist/bin/agentos.js watch teach <task-id> "一直盯这个收件箱，看到同类消息就按刚才的流程处理" --pack generic-mail-desktop --workspace personal-main
```

## Notas de runtime

- Todo el estado local vive bajo `.agentos/`
- El estado del daemon vive bajo `.agentos/daemon/`
- La automatización del navegador requiere un ejecutable compatible con Chrome
- Las watch rules de escritorio ahora soportan context extraction, backoff / retry metadata y teach-based live hints
- Cuando una tarea termina, AgentOS genera automáticamente un teach recording reutilizable por skills y watch profiles

## API

- `GET /daemon/status`
- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/control`
- `POST /tasks/:id/teach-steps`
- `POST /events`
- `GET /events`
- `GET /traces/:id`
- `POST /policy/evaluate`
- `GET /connectors`
- `GET /watches`
- `POST /watches`
- `POST /watches/from-task`
- `GET /watches/:id`
- `POST /watches/:id/enable`
- `POST /watches/:id/disable`
- `DELETE /watches/:id`
- `GET /skills`
- `POST /skills/from-task`
- `GET /skills/:name`
- `PUT /skills/:name`
- `GET /workspace-profiles`
- `PUT /workspace-profiles/:name`
- `GET /vault/secrets`
- `PUT /vault/secrets/:key`
- `GET /vault/secrets/:key`
- `GET /health`
- `GET /ws`

## Ejemplo: target-based task

```json
{
  "goal": "Fill the target page and capture the result",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "steps": [
    {
      "label": "Open target page",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "Type into the email field",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": { "targetQuery": "email", "text": "tan@example.com", "clear": true }
    },
    {
      "label": "Click submit",
      "surface": "browser",
      "action": "clickTarget",
      "params": { "targetQuery": "submit" }
    }
  ]
}
```
